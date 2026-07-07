use super::OutputBuffer;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum PtyError {
    #[error("PTY error: {0}")]
    Pty(String),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

pub struct PtySession {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send>>,
    pub output: Arc<OutputBuffer>,
    /// Canonical shell name: "pwsh", "cmd", "bash", etc.
    pub shell_type: String,
}

impl PtySession {
    pub fn spawn(
        app: AppHandle,
        tab_id: String,
        cols: u16,
        rows: u16,
        output: Arc<OutputBuffer>,
        start_cwd: Option<String>,
    ) -> Result<Self, PtyError> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| PtyError::Pty(e.to_string()))?;

        let (mut cmd, shell_type) = default_shell_cmd();
        // Advertise terminal capabilities so CLIs (Claude Code, etc.) emit color.
        // xterm.js supports truecolor, so this is safe to announce.
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        // Use the provided cwd if it exists on disk; fall back to the home directory.
        let effective_cwd = start_cwd
            .as_deref()
            .map(std::path::PathBuf::from)
            .filter(|p| p.is_dir())
            .or_else(dirs_next::home_dir);
        if let Some(dir) = effective_cwd {
            cmd.cwd(dir);
        }
        let child = pair.slave.spawn_command(cmd).map_err(|e| PtyError::Pty(e.to_string()))?;

        let mut reader = pair.master.try_clone_reader().map_err(|e| PtyError::Pty(e.to_string()))?;
        let writer = pair.master.take_writer().map_err(|e| PtyError::Pty(e.to_string()))?;

        let buf = output.clone();
        let event_name = format!("pty-data-{}", tab_id);
        std::thread::spawn(move || {
            let mut chunk = vec![0u8; 4096];
            loop {
                match reader.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        buf.push_raw(&chunk[..n]);
                        if let Err(e) = app.emit(&event_name, chunk[..n].to_vec()) {
                            eprintln!("[braces] emit error: {e}");
                        }
                    }
                }
            }
        });

        Ok(Self {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            output,
            shell_type,
        })
    }

    pub fn write(&self, data: &[u8]) -> Result<(), PtyError> {
        self.writer.lock().unwrap().write_all(data)?;
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), PtyError> {
        self.master
            .lock()
            .unwrap()
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| PtyError::Pty(e.to_string()))
    }

    pub fn kill(&self) -> Result<(), PtyError> {
        // SIGKILL-ing only the shell leaks its foreground job: a dev server or
        // the app spawned by `pnpm tauri dev` survives, keeps its port, and the
        // next run fails with "port already in use". Sweep descendants first.
        if let Some(root) = self.child.lock().unwrap().process_id() {
            kill_descendants(root);
        }
        self.child.lock().unwrap().kill().map_err(|e| PtyError::Pty(e.to_string()))
    }
}

/// Kill every process whose ancestry chain leads to `root` (but not `root`
/// itself — portable-pty's `Child::kill` handles that one).
fn kill_descendants(root: u32) {
    use sysinfo::{Pid, ProcessesToUpdate, System};
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    let mut family = vec![Pid::from_u32(root)];
    let mut i = 0;
    while i < family.len() {
        let parent = family[i];
        for (pid, proc_) in sys.processes() {
            if proc_.parent() == Some(parent) && !family.contains(pid) {
                family.push(*pid);
            }
        }
        i += 1;
    }
    for pid in family.iter().skip(1) {
        if let Some(p) = sys.process(*pid) {
            p.kill();
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::process::Command;
    use std::{thread, time::Duration};

    #[test]
    fn kill_descendants_sweeps_the_whole_tree() {
        // sh with one backgrounded and one foreground sleep — the layout a shell
        // has while running a dev server.
        let mut sh = Command::new("/bin/sh")
            .args(["-c", "sleep 300 & sleep 300"])
            .spawn()
            .expect("spawn sh");
        thread::sleep(Duration::from_millis(400));

        kill_descendants(sh.id());
        thread::sleep(Duration::from_millis(400));

        let ps = Command::new("ps").args(["-axo", "ppid,command"]).output().expect("ps");
        let survivors = String::from_utf8_lossy(&ps.stdout)
            .lines()
            .filter(|l| {
                let mut it = l.split_whitespace();
                it.next() == Some(&sh.id().to_string()) && l.contains("sleep 300")
            })
            .count();
        let _ = sh.kill();
        let _ = sh.wait();
        assert_eq!(survivors, 0, "sleeps under sh must be dead");
    }
}

/// Returns (CommandBuilder, shell_type_string)
fn default_shell_cmd() -> (CommandBuilder, String) {
    #[cfg(windows)]
    {
        if let Ok(s) = std::env::var("BRACES_SHELL") {
            let name = classify_shell(&s);
            return (CommandBuilder::new(s), name);
        }
        if let Some(pwsh) = find_powershell() {
            let mut cmd = CommandBuilder::new(&pwsh);
            // NoLogo suppresses the banner; NoProfile speeds startup
            cmd.args(["-NoLogo", "-NoProfile"]);
            return (cmd, "pwsh".into());
        }
        let shell = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into());
        (CommandBuilder::new(&shell), "cmd".into())
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("BRACES_SHELL")
            .or_else(|_| std::env::var("SHELL"))
            .unwrap_or_else(|_| "/bin/bash".into());
        let name = classify_shell(&shell);
        (CommandBuilder::new(shell), name)
    }
}

fn classify_shell(path: &str) -> String {
    let lower = path.to_lowercase();
    if lower.contains("pwsh") { "pwsh".into() }
    else if lower.contains("powershell") { "powershell".into() }
    else if lower.contains("bash") { "bash".into() }
    else if lower.contains("zsh") { "zsh".into() }
    else if lower.contains("fish") { "fish".into() }
    else { "cmd".into() }
}

#[cfg(windows)]
fn find_powershell() -> Option<String> {
    // Only PS7 (pwsh.exe) — reliable with ConPTY. PS5 has hang issues.
    let candidates = [
        r"C:\Program Files\PowerShell\7\pwsh.exe",
        r"C:\Program Files\PowerShell\7-preview\pwsh.exe",
        r"C:\Program Files\PowerShell\7.5\pwsh.exe",
        r"C:\Program Files\PowerShell\7.4\pwsh.exe",
        r"C:\Program Files\PowerShell\7.3\pwsh.exe",
    ];
    for p in candidates {
        if std::path::Path::new(p).exists() {
            return Some(p.into());
        }
    }
    None
}

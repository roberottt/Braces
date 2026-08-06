//! Recovering the user's real `PATH`.
//!
//! A GUI app on macOS is started by launchd, not by a shell, so it inherits a
//! bare `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`) with none of the entries the
//! user's shell config adds. Everything in-process that resolves a binary —
//! command-name completion, `git`, any spawned tool — sees that stunted list,
//! which is why a freshly installed toolchain looks missing or resolves to an
//! older copy shipped with the system.
//!
//! Ask a login+interactive shell what its `PATH` is and adopt it. The PTY
//! itself is spawned as a login shell (see `pty::session`), so this keeps the
//! backend in agreement with what the user sees in the terminal.

use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

/// Marker wrapped around the captured value so shell startup chatter (banners,
/// `nvm` output, motd) can be stripped from stdout.
const SENTINEL: &str = "__BRACES_PATH__";

const TIMEOUT: Duration = Duration::from_secs(5);

/// Adopt the login shell's `PATH` for this process. macOS only — on Linux the
/// desktop session already sources the user's profile, and on Windows the
/// environment comes from the registry at launch.
pub fn hydrate_process_path() {
    if !cfg!(target_os = "macos") {
        return;
    }
    if std::env::var("BRACES_LOGIN_SHELL").is_ok_and(|v| v == "0" || v == "false") {
        return;
    }
    if let Some(path) = login_shell_path() {
        std::env::set_var("PATH", path);
    }
}

/// Run the user's shell as login+interactive and capture its `PATH`.
/// Returns `None` if the shell fails, times out, or reports nothing usable.
fn login_shell_path() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let script = format!("printf '{SENTINEL}%s{SENTINEL}' \"$PATH\"");

    let mut child = Command::new(&shell)
        .args(["-l", "-i", "-c", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    // `-i` makes some configurations block forever (a prompt tool waiting on a
    // tty, a slow version manager). Read on a helper thread and give up rather
    // than stall app startup.
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        use std::io::Read;
        let mut buf = String::new();
        let _ = stdout.read_to_string(&mut buf);
        let _ = tx.send(buf);
    });

    let out = rx.recv_timeout(TIMEOUT).ok();
    let _ = child.kill();
    let _ = child.wait();

    let path = extract(&out?)?;
    // A shell that somehow reported an empty or single-entry PATH is worse than
    // what we already have; ignore it.
    if path.split(':').filter(|s| !s.is_empty()).count() < 2 {
        return None;
    }
    Some(path)
}

/// Pull the sentinel-delimited value out of the shell's stdout.
fn extract(stdout: &str) -> Option<String> {
    let after = stdout.split_once(SENTINEL)?.1;
    let value = after.split_once(SENTINEL)?.0;
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_ignores_startup_chatter() {
        let out = format!("nvm loaded\nwelcome!\n{SENTINEL}/a/bin:/b/bin{SENTINEL}trailing");
        assert_eq!(extract(&out).as_deref(), Some("/a/bin:/b/bin"));
    }

    #[test]
    fn extract_needs_both_sentinels() {
        assert_eq!(extract("no markers here"), None);
        assert_eq!(extract(&format!("{SENTINEL}/a/bin")), None);
    }

    #[test]
    fn extract_rejects_empty_value() {
        assert_eq!(extract(&format!("{SENTINEL}  {SENTINEL}")), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn login_shell_path_reports_something_usable() {
        let path = login_shell_path().expect("login shell should report a PATH");
        assert!(path.contains("/usr/bin"), "unexpected PATH: {path}");
    }
}

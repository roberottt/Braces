use super::{OutputBuffer, PtySession};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, State};

pub struct PtyState(pub Mutex<HashMap<String, PtySession>>);

impl PtyState {
    pub fn new() -> Self {
        Self(Mutex::new(HashMap::new()))
    }
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    tab_id: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    state: State<'_, PtyState>,
) -> Result<(), String> {
    let output = Arc::new(OutputBuffer::new(500));
    let session = PtySession::spawn(app, tab_id.clone(), cols, rows, output, cwd)
        .map_err(|e| e.to_string())?;
    state.0.lock().unwrap().insert(tab_id, session);
    Ok(())
}

#[tauri::command]
pub fn pty_write(tab_id: String, data: Vec<u8>, state: State<'_, PtyState>) -> Result<(), String> {
    let guard = state.0.lock().unwrap();
    guard
        .get(&tab_id)
        .ok_or_else(|| format!("no session for tab {tab_id}"))?
        .write(&data)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(
    tab_id: String,
    cols: u16,
    rows: u16,
    state: State<'_, PtyState>,
) -> Result<(), String> {
    let guard = state.0.lock().unwrap();
    guard
        .get(&tab_id)
        .ok_or_else(|| format!("no session for tab {tab_id}"))?
        .resize(cols, rows)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(tab_id: String, state: State<'_, PtyState>) -> Result<(), String> {
    let mut guard = state.0.lock().unwrap();
    if let Some(s) = guard.remove(&tab_id) {
        s.kill().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Return recent terminal output lines for the given tab (used by AI analysis).
#[tauri::command]
pub fn pty_get_output(
    tab_id: String,
    lines: Option<usize>,
    state: State<'_, PtyState>,
) -> Vec<String> {
    let guard = state.0.lock().unwrap();
    guard
        .get(&tab_id)
        .map(|s| s.output.recent(lines.unwrap_or(50)))
        .unwrap_or_default()
}

/// Return the running shell type for the given tab.
#[tauri::command]
pub fn pty_shell_type(tab_id: String, state: State<'_, PtyState>) -> String {
    state
        .0
        .lock()
        .unwrap()
        .get(&tab_id)
        .map(|s| s.shell_type.clone())
        .unwrap_or_else(|| "unknown".into())
}

/// Return the user's home directory.
#[tauri::command]
pub fn pty_home_dir() -> String {
    dirs_next::home_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| String::from("~"))
}

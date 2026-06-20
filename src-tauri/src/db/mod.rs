use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;

// ── Public store struct ──────────────────────────────────────────────────────

pub struct Db(pub Mutex<Connection>);

impl Db {
    pub fn open(path: PathBuf) -> Self {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let conn = Connection::open(&path).expect("[braces] failed to open SQLite db");
        conn.execute_batch(SCHEMA).expect("[braces] failed to init schema");
        Self(Mutex::new(conn))
    }
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS tabs (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    cwd TEXT NOT NULL,
    last_exit_code INTEGER,
    position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS blocks (
    id TEXT PRIMARY KEY,
    tab_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    cmd TEXT NOT NULL,
    cwd TEXT NOT NULL,
    start_time INTEGER NOT NULL,
    end_time INTEGER,
    exit_code INTEGER,
    html_output TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    kind TEXT NOT NULL,
    content TEXT,
    cmd TEXT,
    out TEXT,
    ok INTEGER
);
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
";

// ── Shared data types (serialised for the frontend) ─────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabRecord {
    pub id: String,
    pub title: String,
    pub cwd: String,
    pub last_exit_code: Option<i64>,
}

/// Mirrors CommandBlock in WarpTerminal.tsx
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockRecord {
    pub id: String,
    pub cmd: String,
    pub cwd: String,
    pub start_time: i64,
    pub end_time: Option<i64>,
    pub exit_code: Option<i64>,
    pub html_output: String,
    pub done: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMeta {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Flat record for a chat message of any kind.
/// kind: "user" | "assistant" | "exec"
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMsgRecord {
    pub kind: String,
    /// content for user/assistant messages
    pub content: Option<String>,
    /// exec fields
    pub cmd: Option<String>,
    pub out: Option<String>,
    pub ok: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadTabsResult {
    pub tabs: Vec<TabRecord>,
    pub active_tab_id: Option<String>,
}

// ── Tauri commands — tabs ────────────────────────────────────────────────────

#[tauri::command]
pub fn db_load_tabs(db: State<'_, Db>) -> Result<LoadTabsResult, String> {
    let conn = db.0.lock().unwrap();

    let mut stmt = conn
        .prepare("SELECT id, title, cwd, last_exit_code FROM tabs ORDER BY position ASC")
        .map_err(|e| e.to_string())?;

    let tabs = stmt
        .query_map([], |row| {
            Ok(TabRecord {
                id: row.get(0)?,
                title: row.get(1)?,
                cwd: row.get(2)?,
                last_exit_code: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let active_tab_id: Option<String> = conn
        .query_row(
            "SELECT value FROM meta WHERE key = 'active_tab_id'",
            [],
            |row| row.get(0),
        )
        .ok();

    Ok(LoadTabsResult { tabs, active_tab_id })
}

#[tauri::command]
pub fn db_save_tabs(
    tabs: Vec<TabRecord>,
    active_tab_id: String,
    db: State<'_, Db>,
) -> Result<(), String> {
    let conn = db.0.lock().unwrap();

    conn.execute("DELETE FROM tabs", [])
        .map_err(|e| e.to_string())?;

    for (i, tab) in tabs.iter().enumerate() {
        conn.execute(
            "INSERT INTO tabs (id, title, cwd, last_exit_code, position) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![tab.id, tab.title, tab.cwd, tab.last_exit_code, i as i64],
        )
        .map_err(|e| e.to_string())?;
    }

    conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('active_tab_id', ?1)",
        params![active_tab_id],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn db_delete_tab(tab_id: String, db: State<'_, Db>) -> Result<(), String> {
    let conn = db.0.lock().unwrap();
    conn.execute("DELETE FROM blocks WHERE tab_id = ?1", params![tab_id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM tabs WHERE id = ?1", params![tab_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Tauri commands — blocks ──────────────────────────────────────────────────

#[tauri::command]
pub fn db_load_blocks(
    tab_id: String,
    db: State<'_, Db>,
) -> Result<Vec<BlockRecord>, String> {
    let conn = db.0.lock().unwrap();

    let mut stmt = conn
        .prepare(
            "SELECT id, cmd, cwd, start_time, end_time, exit_code, html_output, done \
             FROM blocks WHERE tab_id = ?1 ORDER BY position ASC",
        )
        .map_err(|e| e.to_string())?;

    let blocks = stmt
        .query_map(params![tab_id], |row| {
            let done_int: i64 = row.get(7)?;
            Ok(BlockRecord {
                id: row.get(0)?,
                cmd: row.get(1)?,
                cwd: row.get(2)?,
                start_time: row.get(3)?,
                end_time: row.get(4)?,
                exit_code: row.get(5)?,
                html_output: row.get(6)?,
                done: done_int != 0,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(blocks)
}

#[tauri::command]
pub fn db_save_blocks(
    tab_id: String,
    blocks: Vec<BlockRecord>,
    db: State<'_, Db>,
) -> Result<(), String> {
    let conn = db.0.lock().unwrap();

    conn.execute("DELETE FROM blocks WHERE tab_id = ?1", params![tab_id])
        .map_err(|e| e.to_string())?;

    for (i, b) in blocks.iter().enumerate() {
        conn.execute(
            "INSERT INTO blocks \
             (id, tab_id, position, cmd, cwd, start_time, end_time, exit_code, html_output, done) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                b.id,
                tab_id,
                i as i64,
                b.cmd,
                b.cwd,
                b.start_time,
                b.end_time,
                b.exit_code,
                b.html_output,
                b.done as i64
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(())
}

// ── Tauri commands — chats ───────────────────────────────────────────────────

#[tauri::command]
pub fn db_list_chats(db: State<'_, Db>) -> Result<Vec<ChatMeta>, String> {
    let conn = db.0.lock().unwrap();

    let mut stmt = conn
        .prepare(
            "SELECT id, title, created_at, updated_at FROM chats ORDER BY updated_at DESC",
        )
        .map_err(|e| e.to_string())?;

    let chats = stmt
        .query_map([], |row| {
            Ok(ChatMeta {
                id: row.get(0)?,
                title: row.get(1)?,
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(chats)
}

#[tauri::command]
pub fn db_load_chat(
    chat_id: String,
    db: State<'_, Db>,
) -> Result<Vec<ChatMsgRecord>, String> {
    let conn = db.0.lock().unwrap();

    let mut stmt = conn
        .prepare(
            "SELECT kind, content, cmd, out, ok \
             FROM chat_messages WHERE chat_id = ?1 ORDER BY position ASC",
        )
        .map_err(|e| e.to_string())?;

    let msgs = stmt
        .query_map(params![chat_id], |row| {
            let ok_int: Option<i64> = row.get(4)?;
            Ok(ChatMsgRecord {
                kind: row.get(0)?,
                content: row.get(1)?,
                cmd: row.get(2)?,
                out: row.get(3)?,
                ok: ok_int.map(|v| v != 0),
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(msgs)
}

#[tauri::command]
pub fn db_create_chat(
    chat_id: String,
    title: String,
    db: State<'_, Db>,
) -> Result<(), String> {
    let now = now_ms();
    let conn = db.0.lock().unwrap();
    conn.execute(
        "INSERT INTO chats (id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)",
        params![chat_id, title, now, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn db_save_chat(
    chat_id: String,
    title: String,
    messages: Vec<ChatMsgRecord>,
    db: State<'_, Db>,
) -> Result<(), String> {
    let now = now_ms();
    let conn = db.0.lock().unwrap();

    // Upsert: update if exists, insert if not
    let updated = conn
        .execute(
            "UPDATE chats SET title = ?2, updated_at = ?3 WHERE id = ?1",
            params![chat_id, title, now],
        )
        .map_err(|e| e.to_string())?;

    if updated == 0 {
        conn.execute(
            "INSERT INTO chats (id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
            params![chat_id, title, now],
        )
        .map_err(|e| e.to_string())?;
    }

    // Replace messages
    conn.execute(
        "DELETE FROM chat_messages WHERE chat_id = ?1",
        params![chat_id],
    )
    .map_err(|e| e.to_string())?;

    for (i, msg) in messages.iter().enumerate() {
        let ok_int: Option<i64> = msg.ok.map(|v| if v { 1 } else { 0 });
        conn.execute(
            "INSERT INTO chat_messages \
             (chat_id, position, kind, content, cmd, out, ok) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![chat_id, i as i64, msg.kind, msg.content, msg.cmd, msg.out, ok_int],
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
pub fn db_delete_chat(chat_id: String, db: State<'_, Db>) -> Result<(), String> {
    let conn = db.0.lock().unwrap();
    conn.execute(
        "DELETE FROM chat_messages WHERE chat_id = ?1",
        params![chat_id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM chats WHERE id = ?1", params![chat_id])
        .map_err(|e| e.to_string())?;
    // Clear active_chat_id meta if it points to this chat
    conn.execute(
        "DELETE FROM meta WHERE key = 'active_chat_id' AND value = ?1",
        params![chat_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn db_get_active_chat(db: State<'_, Db>) -> Result<Option<String>, String> {
    let conn = db.0.lock().unwrap();
    Ok(conn
        .query_row(
            "SELECT value FROM meta WHERE key = 'active_chat_id'",
            [],
            |row| row.get(0),
        )
        .ok())
}

#[tauri::command]
pub fn db_set_active_chat(chat_id: String, db: State<'_, Db>) -> Result<(), String> {
    let conn = db.0.lock().unwrap();
    conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('active_chat_id', ?1)",
        params![chat_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ContextError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbeddingEntry {
    pub text: String,
    pub source: String,
    pub kind: EntryKind,
    pub vector: Vec<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Command,
}

pub struct ContextStore {
    entries: Mutex<Vec<EmbeddingEntry>>,
    path: PathBuf,
}

impl ContextStore {
    pub fn load(path: PathBuf) -> Self {
        let entries = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self { entries: Mutex::new(entries), path }
    }

    pub fn save(&self) -> Result<(), ContextError> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let data = serde_json::to_string_pretty(&*self.entries.lock().unwrap())?;
        std::fs::write(&self.path, data)?;
        Ok(())
    }

    pub fn add(&self, entry: EmbeddingEntry) {
        let mut entries = self.entries.lock().unwrap();
        // Replace existing entry with same source
        entries.retain(|e| e.source != entry.source || e.kind != entry.kind);
        entries.push(entry);
    }

    pub fn search(&self, query_vec: &[f32], kind: Option<EntryKind>, top_k: usize) -> Vec<EmbeddingEntry> {
        let entries = self.entries.lock().unwrap();
        let mut scored: Vec<(f32, &EmbeddingEntry)> = entries
            .iter()
            .filter(|e| kind.as_ref().map_or(true, |k| &e.kind == k))
            .map(|e| (cosine_sim(query_vec, &e.vector), e))
            .collect();
        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        scored.into_iter().take(top_k).map(|(_, e)| e.clone()).collect()
    }

    pub fn entry_count(&self) -> usize {
        self.entries.lock().unwrap().len()
    }
}

fn cosine_sim(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() { return 0.0; }
    let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
    let na: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let nb: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if na == 0.0 || nb == 0.0 { 0.0 } else { dot / (na * nb) }
}

// ── Project file indexing ───────────────────────────────────────────────────

const IGNORE_DIRS: &[&str] = &[
    "node_modules", ".git", "target", "dist", ".cache", "__pycache__",
    ".next", "build", "out", "coverage",
];
const INCLUDE_EXTS: &[&str] = &[
    "rs", "ts", "tsx", "js", "jsx", "py", "go", "java", "kt", "rb",
    "c", "cpp", "h", "hpp", "md", "toml", "json", "yaml", "yml",
];

pub fn walk_project(root: &std::path::Path) -> Vec<(PathBuf, String)> {
    let mut files = Vec::new();
    walk_dir(root, root, &mut files);
    files
}

fn walk_dir(root: &std::path::Path, dir: &std::path::Path, out: &mut Vec<(PathBuf, String)>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if IGNORE_DIRS.contains(&name) { continue; }
            }
            walk_dir(root, &path, out);
        } else if path.is_file() {
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            if INCLUDE_EXTS.contains(&ext) {
                if let Ok(content) = std::fs::read_to_string(&path) {
                    out.push((path, content));
                }
            }
        }
    }
}

/// Chunk text into overlapping windows (~512 chars each, 50-char overlap).
pub fn chunk_text(text: &str, source: &str) -> Vec<String> {
    const WINDOW: usize = 512;
    const OVERLAP: usize = 50;
    if text.len() <= WINDOW {
        return vec![format!("File: {source}\n{text}")];
    }
    let chars: Vec<char> = text.chars().collect();
    let mut chunks = Vec::new();
    let mut start = 0;
    while start < chars.len() {
        let end = (start + WINDOW).min(chars.len());
        let chunk: String = chars[start..end].iter().collect();
        chunks.push(format!("File: {source}\n{chunk}"));
        if end == chars.len() { break; }
        start += WINDOW - OVERLAP;
    }
    chunks
}

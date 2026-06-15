use crate::ai::provider::{AiProvider, ChatMessage, Context, Token};
use crate::ai::providers::{
    anthropic::AnthropicProvider, gemini::GeminiProvider, lmstudio::LmStudioProvider,
    mock::MockProvider, ollama::OllamaProvider, openai::OpenAiProvider, xai::XaiProvider,
};
use crate::config::Config;
use crate::context::{ContextStore, EmbeddingEntry, EntryKind};
use crate::pty::commands::PtyState;
use crate::vault::Vault;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;

// ── Provider factory ────────────────────────────────────────────────────────

pub fn make_provider(cfg: &Config) -> Arc<dyn AiProvider> {
    let p = make_named(&cfg.ai.primary, cfg, None, None).unwrap_or_else(|| try_fallback(cfg));
    eprintln!("[make_provider] using provider={} (configured primary={})", p.name(), cfg.ai.primary);
    p
}

/// Build a provider from explicit frontend params (provider name, model, optional host).
/// Falls back to config defaults for anything not specified.
pub fn make_provider_explicit(
    provider_name: &str,
    model_override: &str,
    host_override: Option<&str>,
    cfg: &Config,
) -> Arc<dyn AiProvider> {
    let model = if model_override.is_empty() { None } else { Some(model_override) };
    make_named(provider_name, cfg, model, host_override)
        .unwrap_or_else(|| Arc::new(MockProvider::default()))
}

fn make_named(
    name: &str,
    cfg: &Config,
    model_override: Option<&str>,
    host_override: Option<&str>,
) -> Option<Arc<dyn AiProvider>> {
    let pc = cfg.providers.get(name);
    match name {
        "ollama" => {
            let host = host_override
                .or_else(|| pc.and_then(|p| p.host.as_deref()))
                .unwrap_or("http://localhost:11434");
            let model = model_override
                .or_else(|| pc.and_then(|p| p.model.as_deref()))
                .unwrap_or("llama3.2");
            let embed = pc.and_then(|p| p.embed_model.as_deref()).unwrap_or("nomic-embed-text");
            Some(Arc::new(OllamaProvider::new(host, model, embed)))
        }
        "lmstudio" => {
            let host = host_override
                .or_else(|| pc.and_then(|p| p.host.as_deref()))
                .unwrap_or("http://localhost:1234");
            let model = model_override
                .or_else(|| pc.and_then(|p| p.model.as_deref()))
                .unwrap_or("local-model");
            Some(Arc::new(LmStudioProvider::new(host, model)))
        }
        "anthropic" => {
            let key = Vault::get("anthropic").ok()?;
            let model = model_override
                .map(|s| s.to_string())
                .or_else(|| pc.and_then(|p| p.model.clone()))
                .unwrap_or_else(|| "claude-opus-4-8".into());
            Some(Arc::new(AnthropicProvider::new(key, Some(model))))
        }
        "openai" => {
            let key = Vault::get("openai").ok()?;
            let model = model_override
                .map(|s| s.to_string())
                .or_else(|| pc.and_then(|p| p.model.clone()))
                .unwrap_or_else(|| "gpt-4o-mini".into());
            Some(Arc::new(OpenAiProvider::new(key, model)))
        }
        "xai" => {
            let key = Vault::get("xai").ok()?;
            let model = model_override
                .map(|s| s.to_string())
                .or_else(|| pc.and_then(|p| p.model.clone()))
                .unwrap_or_else(|| "grok-3".into());
            Some(Arc::new(XaiProvider::new(key, model)))
        }
        "gemini" => {
            let key = Vault::get("gemini").ok()?;
            let model = model_override
                .map(|s| s.to_string())
                .or_else(|| pc.and_then(|p| p.model.clone()))
                .unwrap_or_else(|| "gemini-2.0-flash".into());
            Some(Arc::new(GeminiProvider::new(key, model)))
        }
        _ => None,
    }
}

fn try_fallback(cfg: &Config) -> Arc<dyn AiProvider> {
    cfg.ai
        .fallback
        .as_deref()
        .and_then(|name| make_named(name, cfg, None, None))
        .unwrap_or_else(|| Arc::new(MockProvider::default()))
}

// ── Terminal-aware general chat ───────────────────────────────────────────

/// Strip ANSI escape sequences so terminal output is readable as plain text in the AI context.
pub(crate) fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\x1b' {
            out.push(ch);
            continue;
        }
        match chars.peek().copied() {
            Some('[') => {
                chars.next();
                for c in chars.by_ref() {
                    if c >= '\x40' && c <= '\x7e' { break; }
                }
            }
            Some(']') => {
                chars.next();
                let mut prev = '\0';
                for c in chars.by_ref() {
                    if c == '\x07' { break; }
                    if prev == '\x1b' && c == '\\' { break; }
                    prev = c;
                }
            }
            _ => {}
        }
    }
    out
}

/// General-purpose AI chat with full terminal context (CWD, recent output, shell, OS).
/// Streams tokens via the `ai-chat-token` event and returns the full response.
#[tauri::command]
pub async fn ai_chat(
    query: String,
    cwd: String,
    history: Vec<ChatMessage>,
    provider_name: String,
    model: String,
    host: Option<String>,
    active_tab_id: String,
    state: State<'_, Config>,
    pty: State<'_, PtyState>,
    app: AppHandle,
) -> Result<String, String> {
    let provider = make_provider_explicit(
        &provider_name,
        &model,
        host.as_deref(),
        state.inner(),
    );

    let (recent_raw, shell_type) = {
        let guard = pty.0.lock().unwrap();
        let session = guard.get(&active_tab_id);
        let raw = session
            .map(|s| s.output.recent(80).join("\n"))
            .unwrap_or_default();
        let shell = session
            .map(|s| s.shell_type.clone())
            .unwrap_or_else(|| "unknown".into());
        (raw, shell)
    };
    let recent = strip_ansi(&recent_raw);

    let mut system = format!(
        "You are Braces, an AI assistant embedded inside a terminal. \
         Answer concisely and practically. Prefer runnable commands and code blocks.\n\
         OS: {} | Shell: {} | CWD: {}",
        std::env::consts::OS,
        shell_type,
        cwd,
    );
    if !recent.trim().is_empty() {
        system.push_str(&format!(
            "\n\nRecent terminal output (last ~80 lines):\n```\n{}\n```",
            recent
        ));
    }

    let ctx = Context {
        system: Some(system),
        history,
        cwd: Some(cwd),
        project_chunks: vec![],
    };

    let preview: String = query.chars().take(80).collect();
    eprintln!("[ai_chat] provider={} query={:?}", provider.name(), preview);

    let (tx, mut rx) = mpsc::channel::<Token>(256);
    let p = provider.clone();
    let q = query.clone();
    let c = ctx.clone();
    tokio::spawn(async move {
        if let Err(e) = p.complete(&q, &c, tx).await {
            eprintln!("[ai_chat] complete() error: {:?}", e);
        }
    });

    let mut result = String::new();
    while let Some(tok) = rx.recv().await {
        let _ = app.emit("ai-chat-token", tok.0.clone());
        result.push_str(&tok.0);
    }
    eprintln!("[ai_chat] done, {} chars", result.len());
    Ok(result.trim().to_string())
}

// ── Collect streamed tokens into a String ──────────────────────────────────

async fn collect(provider: Arc<dyn AiProvider>, prompt: &str) -> Result<String, String> {
    let (tx, mut rx) = mpsc::channel::<Token>(128);
    let p = provider.clone();
    let pr = prompt.to_string();
    tokio::spawn(async move {
        p.complete(&pr, &Context::default(), tx).await.ok();
    });
    let mut out = String::new();
    while let Some(tok) = rx.recv().await {
        out.push_str(&tok.0);
    }
    Ok(out.trim().to_string())
}

// ── Commands ─────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
pub struct NlResult {
    pub command: String,
    pub explanation: Option<String>,
}

/// Convert natural-language query "? list files by size" → shell command.
#[tauri::command]
pub async fn ai_nl_to_shell(
    query: String,
    state: State<'_, Config>,
    app: AppHandle,
) -> Result<NlResult, String> {
    let provider = make_provider(state.inner());
    let (tx, mut rx) = mpsc::channel::<Token>(128);
    let p = provider.clone();
    let prompt = format!(
        "Convert this natural language request to a single shell command. \
         Output ONLY the command — no markdown, no explanation.\n\nRequest: {query}"
    );
    let pr = prompt.clone();
    tokio::spawn(async move { p.complete(&pr, &Context::default(), tx).await.ok() });

    let mut command = String::new();
    while let Some(tok) = rx.recv().await {
        let _ = app.emit("ai-nl-token", tok.0.clone());
        command.push_str(&tok.0);
        if command.contains('\n') { break; }
    }
    let command = command.trim().lines().next().unwrap_or("").to_string();
    Ok(NlResult { command, explanation: None })
}

/// Return autocomplete suggestion for the current shell input.
#[tauri::command]
pub async fn ai_autocomplete(
    input: String,
    _cwd: String,
    state: State<'_, Config>,
) -> Result<String, String> {
    let provider = make_provider(state.inner());
    let prompt = format!(
        "Complete this shell command. Output ONLY the full completed command string.\n\nPrefix: {input}"
    );
    let result = collect(provider, &prompt).await?;
    Ok(result.lines().next().unwrap_or("").to_string())
}

/// Analyze the last N lines of terminal output and suggest a fix.
#[tauri::command]
pub async fn ai_analyze_error(
    active_tab_id: String,
    state: State<'_, Config>,
    pty: State<'_, PtyState>,
    app: AppHandle,
) -> Result<String, String> {
    let recent = pty.0.lock().unwrap()
        .get(&active_tab_id)
        .map(|s| s.output.recent(60).join("\n"))
        .unwrap_or_default();
    if recent.trim().is_empty() {
        return Ok("No output to analyze.".into());
    }
    let provider = make_provider(state.inner());
    let (tx, mut rx) = mpsc::channel::<Token>(128);
    let p = provider.clone();
    let prompt = format!(
        "Analyze this terminal output. Identify the error, explain the cause in one sentence, \
         and provide the exact fix command. Format:\nCAUSE: <one sentence>\nFIX: <command>\n\nOutput:\n{recent}"
    );
    tokio::spawn(async move { p.complete(&prompt, &Context::default(), tx).await.ok() });

    let mut result = String::new();
    while let Some(tok) = rx.recv().await {
        let _ = app.emit("ai-analysis-token", tok.0.clone());
        result.push_str(&tok.0);
    }
    Ok(result.trim().to_string())
}

/// Index a project directory for RAG.
#[tauri::command]
pub async fn rag_index(
    path: String,
    state: State<'_, Config>,
    store: State<'_, ContextStore>,
) -> Result<usize, String> {
    let provider = make_provider(state.inner());
    let root = std::path::Path::new(&path);
    let files = crate::context::walk_project(root);
    let mut count = 0usize;

    for (file_path, content) in &files {
        let source = file_path
            .strip_prefix(root)
            .unwrap_or(file_path)
            .to_string_lossy()
            .to_string();
        for chunk in crate::context::chunk_text(content, &source) {
            match provider.embed(&chunk).await {
                Ok(vec) => {
                    store.add(EmbeddingEntry {
                        text: chunk,
                        source: source.clone(),
                        kind: EntryKind::File,
                        vector: vec,
                    });
                    count += 1;
                }
                Err(_) => continue,
            }
        }
    }

    store.save().map_err(|e| e.to_string())?;
    Ok(count)
}

/// Semantic search over indexed project files.
#[tauri::command]
pub async fn rag_query(
    query: String,
    top_k: Option<usize>,
    state: State<'_, Config>,
    store: State<'_, ContextStore>,
) -> Result<Vec<String>, String> {
    let provider = make_provider(state.inner());
    let vec = provider.embed(&query).await.map_err(|e| e.to_string())?;
    let results = store.search(&vec, Some(EntryKind::File), top_k.unwrap_or(5));
    Ok(results.into_iter().map(|e| e.text).collect())
}

/// Add command to semantic history.
#[tauri::command]
pub async fn history_add(
    command: String,
    state: State<'_, Config>,
    store: State<'_, ContextStore>,
) -> Result<(), String> {
    let provider = make_provider(state.inner());
    match provider.embed(&command).await {
        Ok(vec) => {
            store.add(EmbeddingEntry {
                text: command.clone(),
                source: command,
                kind: EntryKind::Command,
                vector: vec,
            });
            store.save().map_err(|e| e.to_string())
        }
        Err(_) => Ok(()), // silently skip if embedding unavailable
    }
}

/// Semantic search over command history.
#[tauri::command]
pub async fn history_search(
    query: String,
    top_k: Option<usize>,
    state: State<'_, Config>,
    store: State<'_, ContextStore>,
) -> Result<Vec<String>, String> {
    let provider = make_provider(state.inner());
    let vec = provider.embed(&query).await.map_err(|e| e.to_string())?;
    let results = store.search(&vec, Some(EntryKind::Command), top_k.unwrap_or(10));
    Ok(results.into_iter().map(|e| e.text).collect())
}

/// Return live system metrics.
#[tauri::command]
pub fn get_metrics() -> crate::metrics::SystemMetrics {
    crate::metrics::collect()
}

/// Answer a natural-language query about running processes.
#[tauri::command]
pub async fn ai_query_processes(
    query: String,
    state: State<'_, Config>,
) -> Result<String, String> {
    use sysinfo::System;
    let mut sys = System::new_all();
    sys.refresh_all();

    // Build a compact process list
    let mut procs: Vec<String> = sys
        .processes()
        .values()
        .map(|p| {
            format!(
                "{} (pid:{}) cpu:{:.1}% mem:{}MB",
                p.name().to_string_lossy(),
                p.pid(),
                p.cpu_usage(),
                p.memory() / 1024 / 1024
            )
        })
        .collect();
    procs.sort();
    procs.dedup();
    let procs_text = procs.join("\n");

    let provider = make_provider(state.inner());
    let prompt = format!(
        "Given this list of running processes, answer: {query}\n\nProcesses:\n{procs_text}\n\nAnswer concisely."
    );
    collect(provider, &prompt).await
}

use crate::ai::commands::{make_provider_explicit, strip_ansi};
use crate::ai::provider::{AgentStep, ChatMessage, Context, Token, ToolDef, ToolResult};
use crate::config::Config;
use crate::pty::commands::PtyState;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;

// ── PTY execution ─────────────────────────────────────────────────────────────

/// Truncate at a UTF-8 char boundary (byte-slicing a String mid-codepoint panics).
fn truncate_utf8(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// Injects `command` into the active PTY (visible in the user's terminal) and
/// waits for the output to settle. Returns (output_lines_joined, success).
async fn exec_in_pty(command: &str, active_tab_id: &str, pty: &PtyState) -> (String, bool) {
    use tokio::time::{sleep, Duration, Instant};

    let before_len = {
        let g = pty.0.lock().unwrap();
        g.get(active_tab_id).map(|s| s.output.len()).unwrap_or(0)
    };

    // Write to the live terminal — user sees this exactly as if they typed it
    {
        let g = pty.0.lock().unwrap();
        match g.get(active_tab_id) {
            Some(s) => {
                // A single \r is Enter in a PTY; \r\n would queue an extra blank prompt.
                if let Err(e) = s.write(format!("{command}\r").as_bytes()) {
                    return (format!("PTY write error: {e}"), false);
                }
            }
            None => return ("No active terminal session.".into(), false),
        }
    }

    // Quiescence detection: stop when output hasn't changed for 700 ms, or 30 s max
    let max_wait  = Duration::from_secs(30);
    let quiesce   = Duration::from_millis(700);
    let start     = Instant::now();
    let mut last_change = Instant::now();
    let mut last_len = before_len;

    loop {
        sleep(Duration::from_millis(100)).await;
        let cur_len = {
            let g = pty.0.lock().unwrap();
            g.get(active_tab_id).map(|s| s.output.len()).unwrap_or(0)
        };
        if cur_len != last_len {
            last_len = cur_len;
            last_change = Instant::now();
        }
        if start.elapsed() >= max_wait { break; }
        if cur_len > before_len && last_change.elapsed() >= quiesce { break; }
        if cur_len == before_len && start.elapsed().as_secs() >= 5 { break; }
    }

    // Collect and filter new output
    let new_lines = {
        let g = pty.0.lock().unwrap();
        g.get(active_tab_id)
            .map(|s| s.output.after(before_len))
            .unwrap_or_default()
    };

    let cmd_lower = command.trim().to_lowercase();
    let filtered: Vec<&str> = new_lines.iter()
        .filter(|l| {
            let lt = l.trim().to_lowercase();
            lt != cmd_lower && !is_prompt(l)
        })
        .map(|l| l.as_str())
        .collect();

    let output = filtered.join("\n").trim().to_string();
    let ok = !output.to_lowercase().contains("not recognized")
          && !output.to_lowercase().contains("command not found")
          && !output.to_lowercase().contains("is not recognized");
    (output, ok)
}

fn is_prompt(line: &str) -> bool {
    let t = line.trim();
    (t.starts_with("PS ") && (t.ends_with('>') || t.ends_with("> ")))
        || (t.len() > 3 && t.contains(":\\") && t.ends_with('>'))
        || t.ends_with("$ ") || t.ends_with("# ") || t.ends_with("% ")
}

// ── Safety ────────────────────────────────────────────────────────────────────

fn is_dangerous(cmd: &str) -> bool {
    let c = cmd.to_lowercase();
    ["rm -rf /", "rm -rf /*", "del /f /s /q c:\\", "format c:", "> /dev/sda", ":(){ :|:& };:"]
        .iter()
        .any(|p| c.contains(p))
}

// ── Event helpers ─────────────────────────────────────────────────────────────

fn emit_token(app: &AppHandle, text: &str) {
    let _ = app.emit("ai-agent-event", serde_json::json!({ "t": "token", "text": text }));
}
fn emit_new_block(app: &AppHandle) {
    let _ = app.emit("ai-agent-event", serde_json::json!({ "t": "new_block" }));
}
fn emit_exec_start(app: &AppHandle, cmd: &str) {
    let _ = app.emit("ai-agent-event", serde_json::json!({ "t": "exec_start", "cmd": cmd }));
}
fn emit_exec_done(app: &AppHandle, cmd: &str, out: &str, ok: bool) {
    let _ = app.emit("ai-agent-event", serde_json::json!({ "t": "exec_done", "cmd": cmd, "out": out, "ok": ok }));
}

// ── Text-based fallback (for providers without native tool calling) ────────────

fn try_exec_line(line: &str) -> Option<String> {
    let s = line.trim().trim_matches('*').trim_matches('_').trim();
    let cmd = if let Some(r) = s.strip_prefix("EXEC: ") { r }
              else if let Some(r) = s.strip_prefix("EXEC:") { r }
              else if let Some(r) = s.strip_prefix("EXEC ") { r }
              else { return None };
    let cmd = cmd.trim().trim_matches('*').trim_matches('_').trim();
    if cmd.is_empty() { None } else { Some(cmd.to_string()) }
}

enum Seg { Text(String), Exec(String) }

fn parse_text_segments(text: &str) -> Vec<Seg> {
    let mut segs = Vec::new();
    let mut acc = String::new();
    for line in text.lines() {
        if let Some(cmd) = try_exec_line(line) {
            if !acc.trim().is_empty() {
                segs.push(Seg::Text(std::mem::take(&mut acc).trim().to_string()));
            }
            acc.clear();
            segs.push(Seg::Exec(cmd));
        } else {
            acc.push_str(line);
            acc.push('\n');
        }
    }
    let tail = acc.trim().to_string();
    if !tail.is_empty() { segs.push(Seg::Text(tail)); }
    segs
}

async fn run_text_agent(
    query: String,
    cwd: String,
    history: Vec<ChatMessage>,
    system: String,
    active_tab_id: String,
    pty: &PtyState,
    provider: std::sync::Arc<dyn crate::ai::provider::AiProvider>,
    app: &AppHandle,
) -> String {
    let mut messages = history;
    messages.push(ChatMessage { role: "user".into(), content: query });
    let mut final_text = String::new();

    for _ in 0..8u32 {
        let last = messages.last().unwrap().content.clone();
        let prior = messages[..messages.len().saturating_sub(1)].to_vec();
        let ctx = Context {
            system: Some(system.clone()),
            history: prior,
            cwd: Some(cwd.clone()),
            project_chunks: vec![],
        };

        let (tx, mut rx) = mpsc::channel::<Token>(512);
        let p = provider.clone();
        let c = ctx.clone();
        let l = last.clone();
        tokio::spawn(async move { p.complete(&l, &c, tx).await.ok(); });

        let mut full = String::new();
        while let Some(tok) = rx.recv().await { full.push_str(&tok.0); }

        let segs = parse_text_segments(&full);
        let mut has_exec = false;
        let mut tool_results: Vec<String> = Vec::new();
        let mut text_parts: Vec<String> = Vec::new();
        let mut prev_exec = false;

        for seg in segs {
            match seg {
                Seg::Text(t) if !t.is_empty() => {
                    if prev_exec { emit_new_block(app); }
                    emit_token(app, &t);
                    text_parts.push(t);
                    prev_exec = false;
                }
                Seg::Exec(cmd) => {
                    if is_dangerous(&cmd) {
                        let m = format!("[Blocked: {cmd}]");
                        emit_token(app, &m);
                        text_parts.push(m);
                        continue;
                    }
                    has_exec = true;
                    emit_exec_start(app, &cmd);
                    let (out, ok) = exec_in_pty(&cmd, &active_tab_id, pty).await;
                    let display = if out.is_empty() { "(no output)".into() } else { out.clone() };
                    let display = if display.len() > 4000 { format!("{}\n…", truncate_utf8(&display, 4000)) } else { display };
                    emit_exec_done(app, &cmd, &display, ok);
                    tool_results.push(format!("$ {cmd}\n{display}"));
                    prev_exec = true;
                }
                _ => {}
            }
        }

        messages.push(ChatMessage { role: "assistant".into(), content: full });

        if !has_exec {
            final_text = text_parts.join("\n\n").trim().to_string();
            break;
        }
        messages.push(ChatMessage {
            role: "user".into(),
            content: format!("[Terminal output]\n{}", tool_results.join("\n\n---\n")),
        });
    }
    final_text
}

// ── Native tool-calling agent ─────────────────────────────────────────────────

async fn run_tool_agent(
    query: String,
    _cwd: String,
    history: Vec<ChatMessage>,
    system: String,
    active_tab_id: String,
    pty: &PtyState,
    provider: std::sync::Arc<dyn crate::ai::provider::AiProvider>,
    app: &AppHandle,
) -> Result<String, String> {
    let tool = ToolDef {
        name: "run_command".into(),
        description: "Execute a shell command in the user's active terminal session. \
                      The command runs in the CWD of the terminal and its output is returned."
            .into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "Shell command to run (e.g. \"git status\", \"ls -la\")"
                }
            },
            "required": ["command"]
        }),
    };

    // Build initial message list in provider-native format
    let mut msgs: Vec<serde_json::Value> = provider.history_to_messages(&system, &history);
    msgs.push(serde_json::json!({ "role": "user", "content": query }));

    let mut final_text = String::new();

    for _ in 0..8u32 {
        match provider.agent_step(&msgs, &system, &[tool.clone()]).await {
            Err(e) => return Err(e.to_string()),

            Ok(AgentStep::Done(text)) => {
                emit_token(app, &text);
                final_text = text;
                break;
            }

            Ok(AgentStep::UseTools { text, calls, raw_msg }) => {
                // Emit any text the model included before the tool calls
                if !text.trim().is_empty() {
                    emit_token(app, &text);
                }

                // Append the assistant's tool-use message
                msgs.push(raw_msg);

                // Execute each tool call in the PTY
                let mut results: Vec<ToolResult> = Vec::new();
                for call in &calls {
                    if call.name != "run_command" { continue; }
                    let cmd = call.args["command"].as_str().unwrap_or("").trim().to_string();
                    if cmd.is_empty() { continue; }
                    if is_dangerous(&cmd) {
                        let m = format!("[Blocked dangerous command: {cmd}]");
                        emit_token(app, &m);
                        results.push(ToolResult { call_id: call.id.clone(), output: m });
                        continue;
                    }

                    emit_exec_start(app, &cmd);
                    let (out, ok) = exec_in_pty(&cmd, &active_tab_id, pty).await;
                    let display = if out.is_empty() {
                        "(no output)".to_string()
                    } else if out.len() > 4000 {
                        format!("{}\n… (truncated)", truncate_utf8(&out, 4000))
                    } else {
                        out.clone()
                    };
                    emit_exec_done(app, &cmd, &display, ok);
                    results.push(ToolResult { call_id: call.id.clone(), output: display });
                }

                // Feed results back to the model
                for msg in provider.tool_result_messages(&results) {
                    msgs.push(msg);
                }

                if !text.trim().is_empty() {
                    emit_new_block(app);
                }
            }
        }
    }

    Ok(final_text)
}

// ── Tauri command ─────────────────────────────────────────────────────────────

/// Agentic AI that executes shell commands inside the active PTY terminal.
/// Uses native tool calling (OpenAI / Anthropic) when available; falls back
/// to text-parsing for other providers.
#[tauri::command]
pub async fn ai_agent(
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
        let g = pty.0.lock().unwrap();
        let s = g.get(&active_tab_id);
        let raw   = s.map(|s| s.output.recent(30).join("\n")).unwrap_or_default();
        let shell = s.map(|s| s.shell_type.clone()).unwrap_or_else(|| "unknown".into());
        (raw, shell)
    };
    let recent = strip_ansi(&recent_raw);
    let recent_ctx = if recent.trim().is_empty() { String::new() } else {
        format!("\n\nRecent terminal output:\n```\n{}\n```", truncate_utf8(&recent, 1200))
    };

    let system = format!(
        "You are Braces, an AI agent embedded inside a terminal emulator. \
         You have access to a 'run_command' tool that executes shell commands in the \
         user's active terminal session.\n\
         \n\
         Rules:\n\
         - Call tools immediately — do NOT write 'I will run X' or 'Let me execute Y' \
           before invoking a tool. Just call it.\n\
         - Run 'git status' before any git write operation.\n\
         - After all commands complete, reply with a one-sentence summary.\n\
         - Only use tools when actually needed to fulfill the request.\n\
         \n\
         OS: {os} | Shell: {shell} | CWD: {cwd}{recent_ctx}",
        os = std::env::consts::OS,
        shell = shell_type,
        cwd = cwd,
    );

    if provider.supports_tools() {
        run_tool_agent(query, cwd, history, system, active_tab_id, &pty, provider, &app).await
    } else {
        // Text-based fallback with "EXEC: cmd" parsing
        let system_text = format!(
            "{system}\n\n\
             Since your provider does not support native tool calling, to run a shell command \
             write it on its own line starting with \"EXEC: \":\n\
             EXEC: git status\n\
             EXEC: git add -A"
        );
        Ok(run_text_agent(query, cwd, history, system_text, active_tab_id, &pty, provider, &app).await)
    }
}

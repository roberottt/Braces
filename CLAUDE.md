# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Braces is a desktop terminal emulator with a block-based command UI and built-in AI agent layer. Built with **Tauri v2** (Rust backend + WebView frontend), **SolidJS + TypeScript** (frontend), and **xterm.js** for interactive terminal programs.

## Commands

```sh
# Install dependencies
pnpm install

# Run in development mode (starts both Vite dev server and Tauri)
pnpm tauri dev

# Production build
pnpm tauri build

# Type-check frontend only (no emit)
node node_modules/typescript/bin/tsc --noEmit

# Type-check and test Rust backend (run from src-tauri/)
cargo check
cargo test
```

## Architecture

The app has two distinct layers that communicate via Tauri's `invoke()` IPC bridge.

### Frontend (`src/`)

- **SolidJS** with reactive primitives (`createSignal`, `createEffect`, `createStore`)
- **Global state** lives in `src/store/terminalStore.ts` (single `[store, setStore]` pair covering tabs, git status, panel visibility, theme, provider) and `src/store/chatStore.ts` (multi-chat AI conversations)
- `src/App.tsx` is the root — registers all global keyboard shortcuts, polls git status every 2s, and persists tabs to SQLite
- `src/terminal/BracesTerminal.tsx` is the core terminal component: block renderer + PTY client + input bar + interactive xterm.js fallback
- `src/hud/` contains all overlay panels (AI side panel, Git panel, Workspace file explorer, Code Review, Metrics, Status bar, Tab sidebar)
- Themes are applied by setting `data-theme` on `<html>` (values: `neon-noir`, `akira`, `ghost-protocol`, `c3po`, `minimal`)
- i18n strings are in `src/i18n.ts`; language is `"es"` (default) or `"en"`, stored in `localStorage` as `braces_language`

### Backend (`src-tauri/src/`)

- `lib.rs` — Tauri app setup and the full Tauri command registry (all `#[tauri::command]` functions registered here)
- `pty/` — PTY session management using `portable-pty`; `PtyState` is a Tauri-managed singleton
- `ai/` — AI subsystem:
  - `provider.rs` defines the `AiProvider` async trait (`complete`, `embed`, `supports_streaming`)
  - `router.rs` wraps primary + optional fallback provider; automatically falls back on error
  - `providers/` has one file per provider: `anthropic`, `openai`, `gemini`, `xai`, `ollama`, `lmstudio`, `mock`
  - `agent.rs` — agentic loop that can execute shell commands as tools
  - `commands.rs` — all `#[tauri::command]` wrappers for AI features
- `db/mod.rs` — SQLite persistence (tabs, command blocks, AI chats) via `rusqlite`; DB lives at `~/.config/braces/braces.db`
- `git/` — git operations (status, diff, stage, commit, checkout, file tree)
- `vault/mod.rs` — AES-256-GCM encryption + OS keychain via the `keyring` crate; API keys never touch disk in plain text
- `config.rs` — TOML config loader; config at `~/.config/braces/config.toml`
- `context/mod.rs` — RAG / semantic history index stored at `~/.config/braces/context.json`
- `metrics/mod.rs` — `sysinfo`-based CPU/memory polling

### Interactive mode detection

`BracesTerminal` switches from block UI to raw xterm.js when the running process is a known TUI program (vim, tmux, ssh, fzf, etc.) or a REPL launched without arguments. When the program exits, block mode resumes.

### Claude Code sessions

When `claude` or `npx claude` runs inside the terminal it stays in raw xterm.js mode like any other TUI (no separate input box). Two extras are layered on top of plain passthrough: Shift+Enter is translated to ESC+CR (Claude Code's insert-newline binding), and pasting an image saves it to a temp file and pastes the path so Claude Code attaches it.

## Key localStorage keys

| Key | Purpose |
|---|---|
| `braces_setup_done` | Whether onboarding wizard has been completed |
| `braces_theme` | Active theme name |
| `braces_language` | `"es"` or `"en"` |
| `braces_provider` | Active AI provider |
| `braces_model` | Active model string |
| `braces_persist_sessions` | `"true"` / `"false"` |

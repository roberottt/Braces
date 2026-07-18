<table>
<tr>
<td><img src="public/splash-eye-icon.png" alt="Braces logo" width="130" /></td>
<td>

```
  ██████╗ ██████╗  █████╗  ██████╗███████╗███████╗
  ██╔══██╗██╔══██╗██╔══██╗██╔════╝██╔════╝██╔════╝
  ██████╔╝██████╔╝███████║██║     █████╗  ███████╗
  ██╔══██╗██╔══██╗██╔══██║██║     ██╔══╝  ╚════██║
  ██████╔╝██║  ██║██║  ██║╚██████╗███████╗███████║
  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝╚══════╝╚══════╝
                   ⬡  Terminal
```

</td>
</tr>
</table>

> An AI-native terminal for your desktop. Every command becomes a card, and an AI agent lives right next to your shell.

---

## Why Braces?

I built Braces because I wanted a terminal experience like Warp's — command blocks, an AI agent, a modern feel — but without being tied to a specific machine. Warp relies on GPU acceleration, which means it doesn't run well (or at all) on older hardware, low-power devices, or remote/VM setups without a GPU. Braces is built to deliver that same experience anywhere, on any computer, with no GPU acceleration required.

---

## What is Braces?

Braces is a modern terminal where each command you run appears as its own card — with exit status, elapsed time, and clean colored output. No more scrolling through a wall of text to find where a command started or whether it failed.

On top of that, a built-in AI panel can explain errors, suggest fixes, run commands for you, and review your code — without ever leaving the terminal.

Works on **Windows, macOS, and Linux**.

<p align="center">
  <img src="public/braces_image.png" alt="Braces terminal screenshot" width="800" />
</p>

<p align="center"><em>This is what Braces looks like — and it comes with 5 different themes to match your style.</em></p>

---

## Highlights

**🧱 Commands as cards** — every command shows a ✓/✕ status badge, how long it took, and the directory it ran in. Failed commands are easy to spot at a glance.

**🤖 AI at your side** (`Ctrl+Shift+A`) — chat with an AI agent that can run shell commands, analyze the last error (`▲`), and inject a one-click fix (`⚡`) into your input. Supports multiple conversations, all saved across restarts.

**🔌 Bring your own AI** — works with Anthropic, OpenAI, Gemini, xAI/Grok, NVIDIA NIM, or fully local models via Ollama and LM Studio. API keys are encrypted and stored in your OS keychain, never in plain text. See [AI providers](#ai-providers) for the full list.

**📝 Built-in code editor** (`Ctrl+E`) — a full editor with file tree, tabs, syntax highlighting, and live git gutters. Edit, save (`Ctrl+S`), and get back to your shell.

**🌿 Git without leaving** — a live branch/status pill in the command bar, a full git panel (`Ctrl+Shift+G`) to stage, discard, diff, and commit, plus an AI code review panel (`Ctrl+Shift+R`).

**🖥️ Real terminal underneath** — full-screen apps like `vim`, `htop`, `ssh`, `tmux`, or `lazygit` just work: Braces detects them and hands over the pane automatically, then returns to card mode when they exit.

**⚡ Full Claude Code integration** — run `claude` inside Braces and it works out of the box, exactly as it does in a native terminal: full interactive TUI support, `Shift+Enter` to insert newlines, and clipboard image pasting (paste a screenshot and Claude Code attaches it automatically).

**✨ Suggestions that follow what you're doing** — optionally, Braces predicts your next command from your working directory, git branch and recent commands, and shows it as ghost text (`→` to accept). It works two ways: while you type it completes what you've started, and on an empty prompt after a command finishes it proposes the next step on its own — including a diagnostic when the last command failed. Off by default; enable it in the first-run wizard or **Settings → AI**. While off, ghost text comes from prefix matching over your shell history, with no provider needed.

**Also included:** multi-tab sessions, tab completion, history panel (`↑` / `→`), semantic history search (`Ctrl+R`), clickable URLs (`Ctrl+Click`), system metrics overlay (`Ctrl+Shift+M`), 5 themes, Spanish/English UI, and session persistence — your tabs and chats come back after a restart.

---

## Getting started

### Prerequisites

- [Rust](https://rustup.rs) 1.80+
- [Node.js](https://nodejs.org) 20+ and [pnpm](https://pnpm.io)
- On Windows: [VS Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the C++ workload

### Run it

```sh
pnpm install       # install dependencies
pnpm tauri dev     # run in development mode
pnpm tauri build   # build for production
```

On first launch, a setup wizard walks you through choosing your AI provider, shell, and theme. That's it.

### Opening the app on macOS

The app is not notarized, so macOS will block it on first launch ("Braces is damaged and can't be opened"). Fix it by removing the quarantine flag after copying it to `/Applications`:

```sh
xattr -cr /Applications/Braces.app
```

---

## AI providers

Braces talks to seven AI backends. Pick one in the setup wizard, or change it any time in **Settings → AI** (`Ctrl+,`).

| Provider | API endpoint | Default model | API key | Streaming |
|---|---|---|---|---|
| **Anthropic** | `api.anthropic.com/v1/messages` | `claude-opus-4-8` | `sk-ant-…` | ✅ |
| **OpenAI** | `api.openai.com/v1` | `gpt-4o-mini` | `sk-…` | ✅ |
| **Gemini** | `generativelanguage.googleapis.com/v1beta` | `gemini-2.0-flash` | `AIza…` | ✅ |
| **xAI (Grok)** | `api.x.ai/v1` | `grok-3` | `xai-…` | ✅ |
| **NVIDIA NIM** | `integrate.api.nvidia.com/v1` | `meta/llama-3.1-8b-instruct` | `nvapi-…` | ✅ |
| **Ollama** (local) | `http://localhost:11434` | `llama3.2` | — | ✅ |
| **LM Studio** (local) | `http://localhost:1234` | `local-model` | — | ✅ |

The OpenAI-compatible providers (OpenAI, xAI, NVIDIA NIM, LM Studio) all speak the same `/chat/completions` protocol, so any model those services expose works — just type its name in the model field.

### Embeddings

Semantic history search (`Ctrl+R`) and the RAG context index need an embedding model. Only some providers offer one:

| Provider | Embeddings |
|---|---|
| Ollama | ✅ `nomic-embed-text` (configurable) |
| OpenAI / LM Studio / NVIDIA NIM | ✅ `text-embedding-3-small` |
| Anthropic, Gemini, xAI | ❌ — configure Ollama as fallback |

### Automatic fallback

You can set a **fallback provider** alongside your primary one. If a request fails — rate limit, network error, local server down — Braces retries it transparently on the fallback. A common setup is a cloud model as primary with local Ollama as backup (or the reverse, to keep things local by default).

### Configuration

Providers are configured in `~/.config/braces/braces.toml`:

```toml
[ai]
primary  = "ollama"      # ollama | anthropic | openai | lmstudio | xai | gemini | nvidia
fallback = "anthropic"
autocomplete = true      # master switch for AI command suggestions

[providers.anthropic]
model = "claude-opus-4-8"

[providers.ollama]
host        = "http://localhost:11434"
model       = "llama3.2"
embed_model = "nomic-embed-text"
```

**API keys are never stored in this file.** They're encrypted with AES-256-GCM and kept in your OS keychain — enter them under **Settings → API keys**.

### What the AI can do

Whichever provider you pick drives these four features:

- **Chat panel** (`Ctrl+Shift+A`) — a conversation per tab, with an agentic loop that can run shell commands as tools and inject them straight into the active terminal. Chats persist across restarts.
- **Code review** (`Ctrl+Shift+R`) — reviews your working diff in a side panel.
- **Semantic history search** (`Ctrl+R`) — every command you run is embedded and indexed, so you can search history by meaning instead of exact text. Needs a provider that supports embeddings (see above); with Anthropic, Gemini or xAI as your only provider, commands are silently not indexed.

- **Command suggestions** (ghost text in the input bar, `→` to accept) — predicts the command you're about to run from what you're actually doing: your working directory, current git branch and recent commands. Two modes, both on the same toggle:
  - *While typing* — completes the command you've started.
  - *On an empty prompt* — about a second after a command finishes, proposes the next step unprompted. If the last command failed, it suggests something that diagnoses or fixes it instead.

  AI-generated suggestions carry a small `AI` badge next to the ghost text, so you can always tell them from history matches.

  **What gets sent:** while typing, only your commands, working directory and git branch. The empty-prompt suggestion additionally sends the **last 25 lines (max 2000 chars) of the previous command's output** — without it the model can't tell a dirty working tree from a clean one and suggests nonsense. That's a smaller window than the chat panel (`Ctrl+Shift+A`), which already sends 80 lines. If you don't want terminal output reaching your provider at all, leave AI suggestions off.

AI command suggestions are **off by default** — they're the one feature here that calls your provider on its own, so Braces asks before spending your tokens. The first-run wizard offers them on the provider step, and you can flip them any time under **Settings → AI → AI command suggestions**; `autocomplete = false` in `braces.toml` disables them outright.

While off, the ghost text falls back to plain prefix matching against your own shell history, which needs no provider configured. Braces also falls back to history automatically whenever the provider errors out or has nothing to suggest, so the input bar never blocks on the network.

---

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+A` | AI panel |
| `Ctrl+E` | Code editor |
| `Ctrl+Shift+G` | Git panel |
| `Ctrl+Shift+R` | AI code review |
| `Ctrl+Shift+E` | File explorer |
| `Ctrl+Shift+M` | System metrics |
| `Ctrl+Alt+T` / `Ctrl+W` | New / close tab |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab |
| `Ctrl+R` | Search command history |
| `↑` / `→` | History panel / accept suggestion |
| `Ctrl+L` | Clear terminal |
| `Ctrl+,` | Settings |
| `Escape` | Close any panel |

---

## Good to know (technical)

- **Built with**: [Tauri v2](https://tauri.app) (Rust backend), [SolidJS](https://solidjs.com) + TypeScript frontend, and [xterm.js](https://xtermjs.org) for interactive programs. Every tab runs a real PTY via [`portable-pty`](https://crates.io/crates/portable-pty).
- **Your data lives in** `~/.config/braces/` (macOS/Linux) or `%APPDATA%\braces\` (Windows): `config.toml` (settings), `braces.db` (SQLite — sessions and AI chats), `context.json` (semantic history index).
- **API keys** are encrypted with AES-256-GCM and stored in the OS keychain (Keychain / Credential Manager / Secret Service) — never written to disk in plain text.
- **Type-checking and tests**:

  ```sh
  node node_modules/typescript/bin/tsc --noEmit   # frontend
  cargo check && cargo test                        # backend (from src-tauri/)
  ```

---

## License

MIT

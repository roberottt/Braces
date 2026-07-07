<img src="public/splash-eye-icon.png" alt="Braces logo" width="130" align="left" />

```
  ██████╗ ██████╗  █████╗  ██████╗███████╗███████╗
  ██╔══██╗██╔══██╗██╔══██╗██╔════╝██╔════╝██╔════╝
  ██████╔╝██████╔╝███████║██║     █████╗  ███████╗
  ██╔══██╗██╔══██╗██╔══██║██║     ██╔══╝  ╚════██║
  ██████╔╝██║  ██║██║  ██║╚██████╗███████╗███████║
  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝╚══════╝╚══════╝
                   ⬡  Terminal
```

<br clear="left" />

> AI-native cyberpunk terminal built with Rust · Tauri v2 · SolidJS

---

## What is Braces?

Braces is a desktop terminal emulator with native PTY, a block-based command UI, and a built-in AI agent layer. Every command runs in a real shell session and renders as a rich card block showing exit status and elapsed time. An AI side panel can reason about your codebase, execute commands, and diagnose errors — all without leaving the terminal.

---

## Tech stack

| Layer | Technology |
|---|---|
| Desktop shell | [Tauri v2](https://tauri.app) (Rust backend + WebView frontend) |
| Frontend | [SolidJS](https://solidjs.com) + TypeScript + Vite |
| Terminal renderer | [@xterm/xterm](https://xtermjs.org) (interactive mode) + custom HTML block renderer (standard mode) |
| PTY | [`portable-pty`](https://crates.io/crates/portable-pty) — real pseudo-terminal on Windows/macOS/Linux |
| AI layer | Decoupled `AIProvider` trait (Rust) — pluggable backends |
| Secrets | AES-256-GCM vault + OS keychain via [`keyring`](https://crates.io/crates/keyring) |
| System metrics | [`sysinfo`](https://crates.io/crates/sysinfo) |

---

## Features

### Block-based command UI

Every command you run appears as a self-contained card:

- **Exit status badge** — green `✓` on success, red `✕ <code>` on failure
- **Elapsed time** — shown on the card header (`45ms`, `1.23s`)
- **CWD label** — directory the command ran in
- **ANSI output** — color codes translated to HTML; no raw escape sequences leaking into the UI
- **Running spinner** — live `●` indicator while the command is executing

### Real PTY sessions

Braces spawns a genuine PTY for every tab. The shell (`pwsh`, `cmd`, `bash`, etc.) is auto-detected. Shell init scripts are injected so the prompt emits OSC 7 / OSC 0 markers that keep the CWD indicator accurate after every `cd`.

### Interactive-program detection

When you launch a full-screen TUI (vim, htop, ssh, lazygit, fzf, …) Braces automatically hands the terminal pane over to xterm.js. When the program exits, the block UI resumes. The full list includes:

- **Always interactive**: `vim`, `nvim`, `nano`, `emacs`, `less`, `man`, `top`, `htop`, `tmux`, `fzf`, `lazygit`, `k9s`, `ssh`, and more
- **REPLs when bare**: `python`, `node`, `psql`, `bash`, `pwsh`, and more — only take over when launched without a script argument

### Built-in code editor (`Ctrl+E`)

A full-window text editor powered by **CodeMirror 6**, toggled with `Ctrl+E` or from the status bar:

- **File tree sidebar** — browse the repository and open any file with a click
- **Multiple editor tabs** with a dirty (`●`) indicator for unsaved changes
- **Syntax highlighting** auto-detected from the file name (all languages bundled in `@codemirror/language-data`)
- **Git gutter** — added / modified / deleted line markers next to the line numbers, refreshed live
- **`Ctrl+S`** saves the file and refreshes git status
- **External change detection** — if the file changes on disk (git checkout, discard, pull, another program) the buffer reloads automatically, but never while you have unsaved edits

### Clickable links (`Ctrl+Click`)

URLs in command output are detected and open in the default browser with `Ctrl+Click` — both in block mode and inside interactive programs (vim, ssh, htop, …) via the xterm.js web-links addon.

### Command input syntax highlighting

The input bar colorizes as you type: sub-commands, flags, strings, and operators each get their own token color, matching the active theme.

### Claude Code integration

Running `npx claude` or `claude` inside the terminal keeps Claude Code fully inline in the terminal — you type straight into Claude's own input:

- **`Shift+Enter` for newlines** — translated to Claude Code's insert-newline binding
- **Image paste** — paste clipboard images directly; they are saved to temp files and their path is pasted so Claude attaches them
- **Everything else passes through natively** — menus, arrow keys, `Ctrl+C`, `Escape`, autocomplete

### Multi-tab sessions

| Action | Shortcut |
|---|---|
| New tab | `Ctrl+Alt+T` |
| Close active tab | `Ctrl+W` |
| Cycle tabs forward | `Ctrl+Tab` |
| Cycle tabs backward | `Ctrl+Shift+Tab` |
| Toggle session sidebar | sidebar arrow button |

Each tab has its own PTY, CWD, exit code, and title (set from the last command).

### Tab completion

Press `Tab` on any partial input to invoke the backend completion engine:

- Completes **file and directory names** relative to the current CWD
- Completes **command names** from `$PATH` when completing the first token
- Shows a popup panel when there are multiple matches — navigate with `Tab` / `↑↓`, confirm with `Enter`, cancel with `Escape`
- Single match is accepted inline immediately

### Command history

- `↑` arrow opens a **history panel** showing every past command with relative timestamps (`just now`, `5m ago`, `2h ago`, …)
- `→` arrow accepts an **inline ghost suggestion** from history (longest prefix match)
- `Ctrl+R` opens a **semantic history search** overlay
- History is persisted to `localStorage` (up to 10 000 entries, deduplicated)

### AI side panel (`Ctrl+Shift+A`)

A conversational agent panel backed by your configured AI provider:

- **Streaming token display** with a live cursor
- **Tool execution blocks** — the agent can run shell commands; each shows the command, a running spinner, and captured output with success/failure styling
- **Error analysis** (`▲` button) — sends the last terminal error to the AI for diagnosis
- **Apply fix** (`⚡` button) — if the AI's response contains a `FIX:` line, one click injects that command into the terminal input
- **Clear chat** (`⌫` button)
- Full conversation history passed to every request so the agent has context

### Git integration

A live git status pill in the command bar shows the current branch and number of changed files. Click the branch name to open the **branch switcher** and check out any local branch without leaving the terminal.

**Git panel** (`Ctrl+Shift+G`):

- Changed files list with staged / unstaged split
- Stage, unstage, and discard individual files
- Stage all / commit with a message
- Per-file diff view

**Code review panel** (`Ctrl+Shift+R`): AI-powered review of current diff.

**Workspace / file explorer** (`Ctrl+Shift+E`): Browse the repository file tree.

### AI providers

Configure any of the supported backends in Settings → AI:

| Provider | Default model |
|---|---|
| Ollama (local) | `llama3.2` |
| Anthropic | `claude-opus-4-8` |
| OpenAI | `gpt-4o-mini` |
| LM Studio (local) | `local-model` |
| xAI / Grok | `grok-3` |
| Google Gemini | `gemini-2.0-flash` |

Local providers (Ollama, LM Studio) accept a custom host URL. API keys for cloud providers are stored encrypted in the OS keychain — never in plain text on disk.

### Themes

Five accent-color themes (the background stays pure black — `#000` — always):

| Theme | Accent |
|---|---|
| Graphite *(default)* | Blue-indigo `#8aa0ff` |
| Akira | Crimson `#c45272` |
| Ghost Protocol | Olive green `#72aa50` |
| C-3PO | Amber `#c08840` |
| Minimal | Light gray `#cccccc` |

### Session persistence

Terminal sessions and AI chat history are persisted to a SQLite database (`~/.config/braces/braces.db` on macOS/Linux, `%APPDATA%\braces\braces.db` on Windows) and restored automatically on the next launch:

- **Terminal tabs** — command blocks and CWD are saved; on restart they appear as read-only history with a fresh shell starting in the saved directory
- **AI chats** — full conversation history is written to the DB; closing the panel no longer loses the conversation
- **Tab close** (`Ctrl+W` or sidebar ×) deletes the tab's data from the DB
- Enable or disable persistence in **Settings → Appearance → Session persistence**

### Multi-chat AI panel

The AI side panel now supports multiple independent conversations:

- **`+` button** — creates a new chat
- **`☰` button** — opens chat history to browse, reopen, or delete previous conversations
- Chats are persisted to SQLite and restored across restarts

### System metrics overlay (`Ctrl+Shift+M`)

Live CPU, memory, and process info rendered over the terminal.

### Secure API key vault

API keys entered in Settings → Keys are:

1. Encrypted with **AES-256-GCM** using a random nonce
2. Stored in the **OS native keychain** (`Windows Credential Manager` / `macOS Keychain` / `Secret Service` on Linux) via the `keyring` crate
3. Never written to disk in plain text

### Onboarding wizard

First launch shows a guided setup wizard to configure the AI provider, shell, and visual preferences. Choices are persisted to `localStorage`.

### Internationalization

The UI supports **Spanish** (default) and **English**. Switch language from the flag toggle in Settings.

### Settings modal (`Ctrl+,`)

Three tabs:

- **Appearance** — theme picker, session persistence toggle, language selector
- **AI** — provider, model, custom host for local backends, autocomplete toggle
- **Keys** — encrypted API key entry for Anthropic, OpenAI, xAI, Gemini

---

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+,` | Settings |
| `Ctrl+Alt+T` | New tab |
| `Ctrl+W` | Close active tab |
| `Ctrl+Tab` | Next tab |
| `Ctrl+Shift+Tab` | Previous tab |
| `Ctrl+E` | Toggle code editor view |
| `Ctrl+S` | Save file (in editor view) |
| `Ctrl+Shift+A` | Toggle AI side panel |
| `Ctrl+Shift+M` | Toggle metrics overlay |
| `Ctrl+Shift+G` | Toggle git panel |
| `Ctrl+Shift+E` | Toggle workspace / file explorer |
| `Ctrl+Shift+R` | Toggle code review panel |
| `Ctrl+R` | Semantic history search |
| `Ctrl+L` | Clear terminal blocks |
| `Ctrl+C` | Cancel running command |
| `Ctrl+D` | Send EOF to shell |
| `Tab` | Tab completion |
| `↑` | History panel |
| `→` | Accept inline suggestion |
| `Escape` | Close any active panel |

---

## Architecture

```
terminal/
├── src/                        # SolidJS frontend
│   ├── App.tsx                 # Root — layout, shortcuts, git polling
│   ├── terminal/
│   │   ├── BracesTerminal.tsx    # Block renderer + PTY client + input bar
│   │   ├── HistoryOverlay.tsx  # Ctrl+R search overlay
│   │   └── shellInit.ts        # Shell-specific init scripts (OSC 7 prompt)
│   ├── editor/
│   │   ├── EditorView.tsx      # Full-window editor layout (Ctrl+E)
│   │   ├── EditorPane.tsx      # CodeMirror 6 buffer per open file
│   │   ├── EditorTabBar.tsx    # Open-file tabs
│   │   ├── gitGutter.ts        # Added/modified/deleted line markers
│   │   └── languages.ts        # Language auto-detection
│   ├── hud/
│   │   ├── AiSidePanel.tsx     # AI agent chat panel
│   │   ├── FileTree.tsx        # Repository file tree (editor sidebar)
│   │   ├── StatusBar.tsx       # Top bar
│   │   ├── TabSidebar.tsx      # Session list
│   │   ├── GitPanel.tsx        # Git operations
│   │   ├── WorkspacePanel.tsx  # File explorer
│   │   ├── CodeReviewPanel.tsx # AI code review
│   │   ├── ErrorPanel.tsx      # Error analysis bar
│   │   └── MetricsOverlay.tsx  # CPU/memory overlay
│   ├── settings/
│   │   └── SettingsModal.tsx   # Theme / AI / keys settings
│   ├── onboarding/
│   │   └── OnboardingWizard.tsx
│   ├── ai/
│   │   ├── autocomplete.ts     # Frontend AI autocomplete helpers
│   │   └── nlShell.ts          # Natural-language shell helpers
│   ├── store/
│   │   ├── terminalStore.ts    # Global reactive store (SolidJS store)
│   │   └── chatStore.ts        # Global AI chat store (multi-chat, persisted)
│   └── i18n.ts                 # ES / EN strings
│
└── src-tauri/                  # Rust backend
    └── src/
        ├── lib.rs              # Tauri app setup + command registry
        ├── pty/                # PTY session management (portable-pty)
        ├── db/
        │   └── mod.rs          # SQLite layer — session + chat persistence
        ├── ai/
        │   ├── router.rs       # AIProvider trait + provider dispatch
        │   ├── agent.rs        # Agentic loop (tool execution)
        │   └── providers/      # ollama / anthropic / openai / xai / gemini / mock
        ├── git/                # Git commands (status, diff, stage, commit, …)
        ├── vault.rs            # AES-256-GCM + OS keychain
        ├── config.rs           # TOML config loader
        ├── context.rs          # RAG context store
        └── metrics.rs          # sysinfo CPU / memory
```

---

## Building

**Prerequisites**

- [Rust](https://rustup.rs) 1.80+
- [Node.js](https://nodejs.org) 20+ and [pnpm](https://pnpm.io)
- [Tauri CLI v2](https://tauri.app/start/prerequisites/)
- Windows: [VS Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the C++ workload

**Install dependencies**

```sh
pnpm install
```

**Development**

```sh
pnpm tauri dev
```

**Production build**

```sh
pnpm tauri build
```

**Type-check only**

```sh
node node_modules/typescript/bin/tsc --noEmit   # frontend
cargo check                                      # backend (from src-tauri/)
cargo test                                       # run unit tests
```

### Opening the app on macOS

The app is not notarized, so Gatekeeper will block it on first launch ("Braces is damaged and can't be opened"). Remove the quarantine attribute after copying it to `/Applications`:

```sh
xattr -cr /Applications/Braces.app
```

Then open it normally.

---

## Configuration

On first launch the onboarding wizard configures the essentials. Settings are persisted to `localStorage` and the app's config directory:

- **Config file**: `~/.config/braces/config.toml` (macOS/Linux) / `%APPDATA%\braces\config.toml` (Windows) — AI provider defaults, visual settings
- **Session database**: `braces.db` in the same directory — SQLite database for terminal sessions, command blocks, and AI chat history
- **Context store**: `context.json` in the same directory — RAG / semantic history index
- **API keys**: OS keychain (never on disk in plain text)
- **UI preferences**: `localStorage` (theme, language, provider, model, history)

---

## License

MIT

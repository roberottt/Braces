import { Component, For, Index, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { store, setStore } from "../store/terminalStore";
import { t } from "../i18n";
import { getShellInitScript } from "./shellInit";
import { TermScreen, mkScreen } from "./ansiToHtml";
import NewSessionWelcome from "./NewSessionWelcome";
import "@xterm/xterm/css/xterm.css";

// Graphite theme — modern, calm palette (no neon) matching styles/global.css.
const NEON_NOIR_THEME = {
  background: "#000000", foreground: "#e6e7ea",
  cursor: "#8aa0ff", cursorAccent: "#000000",
  black: "#000000", red: "#f0726f", green: "#6fcf97", yellow: "#e0b07a",
  blue: "#8aa0ff", magenta: "#b08af0", cyan: "#7fd6d0", white: "#e6e7ea",
  brightBlack: "#5c5f68", brightRed: "#f58a87", brightGreen: "#87dba9",
  brightYellow: "#ecc89a", brightBlue: "#a6b6ff", brightMagenta: "#c4a3f5",
  brightCyan: "#9ee0db", brightWhite: "#ffffff",
  selectionBackground: "#8aa0ff33",
};

type HistEntry  = { cmd: string; ts: number };

type CommandBlock = {
  id: string;
  cmd: string;
  cwd: string;
  startTime: number;
  endTime: number | null;
  exitCode: number | null;
  htmlOutput: string;
  done: boolean;
};

// ── Interactive-program detection ───────────────────────────────────────────
// Full-screen / inline TUIs position their UI with cursor movement, which the
// block (HTML) renderer can't reproduce — it strips those and the text collapses
// together. So when the user launches one of these we hand the whole pane to the
// real xterm grid and hide the command input until the program exits. This is
// decided from the typed command (deterministic) rather than sniffing escape
// sequences (which flaps: PSReadLine emits cursor moves for its own prompt).
const ALWAYS_INTERACTIVE = new Set([
  "claude", "vim", "vi", "nvim", "nano", "emacs", "pico", "micro", "helix", "hx",
  "less", "more", "most", "man", "top", "htop", "btop", "btm", "atop", "glances",
  "tmux", "screen", "fzf", "lazygit", "gitui", "lazydocker", "ranger", "vifm", "nnn", "yazi",
  "tig", "k9s", "ssh", "telnet", "gdb", "lldb", "ncdu", "cmatrix", "vit", "calcurse",
]);
// REPLs/shells: interactive only when launched bare (no script argument to run).
const REPL_IF_BARE = new Set([
  "python", "python3", "ipython", "node", "deno", "bun", "irb", "pry", "lua",
  "ghci", "iex", "clj", "scala", "R", "julia", "php", "mysql", "psql", "sqlite3",
  "redis-cli", "mongosh", "bash", "sh", "zsh", "fish", "pwsh", "powershell", "cmd",
]);
const COMMAND_WRAPPERS = new Set([
  "npx", "sudo", "doas", "command", "env", "time", "nice", "stdbuf",
  "pnpm", "yarn", "bunx", "uvx", "uv", "poetry", "winpty",
]);

// In block mode we give ConPTY a very tall virtual screen so that ordinary
// command output (ls, git log, …) never exceeds the viewport and ConPTY never
// scrolls. Scrolling makes ConPTY redraw the screen with cursor-positioning the
// block renderer can't follow — which truncated long listings and left gaps.
// Interactive programs get the real window height via enterInteractive().
const BLOCK_ROWS = 2000;

// Git sub-commands that can change HEAD / the branch / the working-tree status.
// When one is run we can't rely on the prompt-redraw OSC marker firing promptly
// (it often doesn't after `git switch`/`checkout -b`), so we proactively kick a
// short burst of git-refresh events instead of waiting for the 2 s poll.
const GIT_MUTATING_RE =
  /^\s*git\s+(?:-[^\s]+\s+)*(checkout|switch|branch|reset|merge|rebase|pull|fetch|stash|commit|cherry-pick|revert|restore|clone|init|tag|am|apply)\b/i;

const baseName = (s: string): string =>
  (s.toLowerCase().replace(/\.(exe|cmd|bat|ps1|com)$/, "").split(/[\\/]/).pop() || s);

// Parses the shell prompt marker "[CWD:<path>|EXIT:<code>]" emitted by shellInit.ts.
// Falls back to a bare "[CWD:<path>]" (no exit code) for safety if a shell hook
// ever fires without one.
const CWD_EXIT_RE = /^\[CWD:([\s\S]*)\|EXIT:(-?\d+)\]$/;
const parseCwdMarker = (bracketed: string): { cwd: string; exitCode: number | null } => {
  const m = CWD_EXIT_RE.exec(bracketed);
  if (m) return { cwd: m[1], exitCode: Number(m[2]) };
  return { cwd: bracketed.replace(/^\[CWD:/, "").replace(/\]$/, ""), exitCode: null };
};

// ── Command-line syntax highlighting ─────────────────────────────────────────
// The input box is a plain <input> (can't hold coloured spans), so we mirror the
// typed text in an overlay div whose tokens are wrapped in coloured spans while
// the real input text is rendered transparent. The two stay pixel-aligned because
// the overlay copies the input's exact font metrics and scroll offset.

// Programs whose SECOND word is a sub-command worth its own colour (git fetch …).
const CMD_WITH_SUB = new Set([
  "git", "npm", "pnpm", "yarn", "bun", "bunx", "cargo", "docker", "podman",
  "kubectl", "go", "pip", "pip3", "apt", "apt-get", "brew", "systemctl", "gh",
  "tauri", "deno", "make", "conda", "nix", "helm", "terraform", "rustup", "dotnet",
]);

const escHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Distinct, calm colours for command names — each command keeps a stable colour
// derived from its own name, so `git`, `npm`, `cargo`, `ls`… look different.
const CMD_COLORS = [
  "#8aa0ff", "#6fcf97", "#e0b07a", "#b08af0", "#7fd6d0",
  "#f0a3c0", "#d6c87f", "#87b9f5", "#9ad19a", "#f5a97f",
];
function cmdColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return CMD_COLORS[h % CMD_COLORS.length];
}

/** Tokenise a command line into coloured HTML for the overlay. Whitespace preserved. */
function highlightCmd(text: string): string {
  if (!text) return "";
  let html = "";
  let plainWord = 0;          // index among non-flag / non-operator words
  let firstWord = "";
  for (const part of text.split(/(\s+)/)) {
    if (part === "") continue;
    if (/^\s+$/.test(part)) { html += escHtml(part); continue; }

    const safe = escHtml(part);
    if (/^["']/.test(part)) {                         // quoted string
      html += `<span class="tok-str">${safe}</span>`;
    } else if (/^[|&;<>]+$/.test(part)) {             // pipe / redirect / chain
      html += `<span class="tok-op">${safe}</span>`;
    } else if (part.startsWith("-")) {                // -v / --flag
      html += `<span class="tok-flag">${safe}</span>`;
    } else if (plainWord === 0) {                     // command name → per-command colour
      firstWord = baseName(part);
      html += `<span style="color:${cmdColor(firstWord)}">${safe}</span>`;
      plainWord++;
    } else if (plainWord === 1 && CMD_WITH_SUB.has(firstWord)) { // sub-command
      html += `<span class="tok-sub">${safe}</span>`;
      plainWord++;
    } else {                                          // args / paths
      html += `<span class="tok-arg">${safe}</span>`;
      plainWord++;
    }
  }
  return html;
}

/** True if launching `raw` should take over the terminal (xterm) until it exits. */
function isInteractiveCommand(raw: string): boolean {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  // Step past leading wrappers (`npx claude`, `sudo vim`) and any flags.
  while (i < tokens.length && (tokens[i].startsWith("-") || COMMAND_WRAPPERS.has(baseName(tokens[i])))) i++;
  if (i >= tokens.length) return false;
  const prog = baseName(tokens[i]);
  if (ALWAYS_INTERACTIVE.has(prog)) return true;
  if (REPL_IF_BARE.has(prog)) {
    // Bare REPL (no non-flag argument) → interactive; `python script.py` → not.
    return tokens.slice(i + 1).every(t => t.startsWith("-"));
  }
  return false;
}

type Props = { tabId: string };

const WarpTerminal: Component<Props> = (props) => {
  let outputRef!: HTMLDivElement;
  let blocksRef!: HTMLDivElement;
  let wibContainerRef!: HTMLDivElement;
  let wibSpacerRef!: HTMLDivElement;
  let inputRef!: HTMLInputElement;
  let highlightRef: HTMLDivElement | undefined;
  let ghostRef: HTMLDivElement | undefined;
  let term: Terminal;
  let fitAddon: FitAddon;

  const HISTORY_KEY = "braces_cmd_history";
  const HISTORY_MAX = 10000;

  const loadHistory = (): HistEntry[] => {
    try {
      const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
      if (!Array.isArray(raw)) return [];
      return raw.map((x: any) =>
        typeof x === "string" ? { cmd: x, ts: Date.now() } : x as HistEntry
      );
    } catch { return []; }
  };
  const persistHistory = (h: HistEntry[]) => {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(h)); } catch { /* quota */ }
  };

  const relTime = (ts: number): string => {
    const d = Date.now() - ts;
    const m = Math.floor(d / 60000);
    if (m < 1)   return "just now";
    if (m < 60)  return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24)  return `${h}h ago`;
    const days = Math.floor(h / 24);
    return `${days} day${days !== 1 ? "s" : ""} ago`;
  };

  const [cmdText, setCmdText] = createSignal("");
  const [cmdHistory, setCmdHistory] = createSignal<HistEntry[]>(loadHistory());
  const [showHistPanel, setShowHistPanel] = createSignal(false);
  const [histPanelSel, setHistPanelSel] = createSignal(0);
  let histPanelRef: HTMLDivElement | undefined;
  const [showTabPanel, setShowTabPanel] = createSignal(false);
  const [tabCompletions, setTabCompletions] = createSignal<string[]>([]);
  const [tabCompIdx, setTabCompIdx] = createSignal(0);
  let tabPanelRef: HTMLDivElement | undefined;
  let preTabText = "";

  const [showBranchPanel, setShowBranchPanel] = createSignal(false);
  const [branches, setBranches] = createSignal<string[]>([]);

  const openBranchSwitcher = async () => {
    if (showBranchPanel()) { setShowBranchPanel(false); return; }
    setShowHistPanel(false);
    setShowTabPanel(false);
    try {
      const info = await invoke<{ current: string; all: string[] }>(
        "git_branch_info", { cwd: store.cwd }
      );
      setBranches(info.all.filter(b => !b.startsWith("remotes/")));
      setShowBranchPanel(true);
    } catch { /* not a repo */ }
  };

  const checkoutBranch = async (branch: string) => {
    setShowBranchPanel(false);
    try {
      await invoke("git_checkout", { cwd: store.cwd, branch });
      window.dispatchEvent(new CustomEvent("braces:git-refresh", { detail: { cwd: store.cwd } }));
    } catch (e) { console.error("checkout failed:", e); }
  };
  const [ptyReady, setPtyReady] = createSignal(false);
  const [isInteractive, setIsInteractive] = createSignal(false);
  // Drives the visual swap to xterm (the "interactive" CSS class), delayed a beat
  // behind isInteractive: commands classified interactive that die instantly
  // (`ssh` with no host, missing `htop`) would otherwise blank the whole block
  // list and restore it ~100ms later — a full-screen flash on every such error.
  const [uiInteractive, setUiInteractive] = createSignal(false);
  const INTERACTIVE_UI_DELAY_MS = 200;
  let uiFlipTimer: ReturnType<typeof setTimeout> | undefined;
  const [interactiveCmd, setInteractiveCmd] = createSignal("");
  const [blocks, setBlocks] = createSignal<CommandBlock[]>([]);
  // True while the shell emits the [CWD:…] prompt marker (zsh/bash/pwsh/cmd) —
  // the only shells where we can tell that a running block has finished, which
  // stdin-mode below depends on to ever release the input again.
  const [shellHasMarker, setShellHasMarker] = createSignal(false);
  const hasRunningBlock = createMemo(() => blocks().some(b => !b.done));
  // A command is still running in this tab: the input bar stops being a prompt
  // and becomes the command's stdin (like Warp), so long-running programs
  // (dev servers, watchers) visibly "own" the terminal until they exit or the
  // user interrupts them with Ctrl+C.
  const stdinMode = () => shellHasMarker() && hasRunningBlock() && !isInteractive();

  // Persist blocks to SQLite. Saves ALL blocks with a command — NOT just the ones
  // marked done. Some shells never emit the prompt marker that fires closeBlock(),
  // so filtering on `done` left those sessions with an empty blocks table. On
  // restore every loaded block is forced done (its PTY is gone) so it renders as a
  // finished history card.
  const persistBlocks = () => {
    if (!store.persistSessions) return;
    const all = blocks().filter((b) => b.cmd);
    invoke("db_save_blocks", { tabId: props.tabId, blocks: all }).catch((e) =>
      console.error("[braces] db_save_blocks failed:", e)
    );
  };

  // Safety-net: debounced save whenever the blocks signal changes (covers streaming
  // output and unexpected app closure before a block formally completes).
  let saveBlocksTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    if (!store.persistSessions) return;
    const all = blocks();
    if (all.length === 0) return;
    if (saveBlocksTimer) clearTimeout(saveBlocksTimer);
    saveBlocksTimer = setTimeout(persistBlocks, 500);
  });

  // Claude Code runs directly in xterm (like Warp) — no separate composer.
  // This flag only gates the two extras layered on top of plain TUI passthrough:
  // Shift+Enter → newline, and image paste → temp file + pasted path.
  const isClaudeSession = () =>
    isInteractive() && /^(?:npx\s+)?claude(?:\s|$)/i.test(interactiveCmd().trim());

  // Image paste during a Claude session: save the clipboard image to a temp file
  // and paste its path (bracketed, so it lands in the input instead of submitting).
  // Claude Code picks the path up as an attachment — same mechanism Warp uses.
  // Text-only pastes fall through to xterm's native paste handling.
  const handleXtermPaste = (e: ClipboardEvent) => {
    if (!isClaudeSession()) return;
    const images = Array.from(e.clipboardData?.items ?? []).filter(i => i.type.startsWith("image/"));
    if (images.length === 0) return;
    e.preventDefault();
    e.stopPropagation(); // capture phase: keeps xterm's own paste handler out
    for (const item of images) {
      const blob = item.getAsFile();
      if (!blob) continue;
      const ext = item.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
      blob.arrayBuffer()
        .then(buf => invoke<string>("save_temp_image", { data: Array.from(new Uint8Array(buf)), ext }))
        .then(path => { if (path) sendRaw(`\x1b[200~${path}\x1b[201~`); })
        .catch(() => {});
    }
  };

  // Coloured mirror of the typed command (rendered into .wib-highlight overlay).
  const highlightHtml = createMemo(() => highlightCmd(cmdText()));

  // Keep the colour overlay + ghost scrolled in lock-step with the input so the
  // tokens stay aligned once the command is wider than the visible box.
  const syncScroll = () => {
    const x = inputRef?.scrollLeft ?? 0;
    if (highlightRef) highlightRef.scrollLeft = x;
    if (ghostRef) ghostRef.scrollLeft = x;
  };

  const suggestion = createMemo(() => {
    if (showTabPanel()) return "";
    const text = cmdText();
    if (!text) return "";
    return cmdHistory().find(h => h.cmd.startsWith(text) && h.cmd !== text)?.cmd ?? "";
  });

  // Per-tab reactive accessors
  const tabCwd = () => store.tabs.find(t => t.id === props.tabId)?.cwd ?? "~";
  const tabExitCode = () => store.tabs.find(t => t.id === props.tabId)?.lastExitCode ?? null;

  const setTabCwd = (cwdOrFn: string | ((prev: string) => string)) => {
    const current = tabCwd();
    const next = typeof cwdOrFn === "function" ? cwdOrFn(current) : cwdOrFn;
    setStore("tabs", (t) => t.id === props.tabId, "cwd", next);
    if (store.activeTabId === props.tabId) setStore("cwd", next);
  };

  const setTabExitCode = (code: number | null) => {
    setStore("tabs", (t) => t.id === props.tabId, "lastExitCode", code);
    if (store.activeTabId === props.tabId) setStore("lastExitCode", code);
  };

  const setTabTitle = (title: string) => {
    setStore("tabs", (t) => t.id === props.tabId, "title", title);
  };

  let ptyReadyRef = false;
  let echoFilter = "";
  let activeBlockId = "";
  // Virtual screen for the active block. The PTY stream is applied to this grid
  // (cursor motion, in-place redraws, line/screen erase) and the whole block is
  // re-rendered from it on every chunk — so progress bars / spinners overwrite in
  // place instead of stacking blank lines.
  let activeScreen: TermScreen = mkScreen();
  let titleBuf = "";
  let interactiveStartedAt = 0;
  // True while the current interactive-mode command's plain output is still being
  // mirrored into its block. Turned off as soon as it draws a real full-screen TUI
  // frame (alternate screen buffer) or after a short grace window — whichever comes
  // first — so a genuinely live program (htop, a long ssh session) isn't dumped into
  // the block wholesale. Until then, this is what makes a program that's merely on
  // the ALWAYS_INTERACTIVE list (ssh, htop…) but exits instantly with a one-line
  // error (bad host, missing binary) show that error text instead of an empty block.
  let captureInteractiveOutput = false;
  const INTERACTIVE_CAPTURE_GRACE_MS = 1500;
  let lastPtyCols = 0;
  let lastPtyRows = 0;

  const sendRaw = (data: string | Uint8Array) => {
    if (!ptyReadyRef) return;
    const bytes = typeof data === "string"
      ? Array.from(new TextEncoder().encode(data))
      : Array.from(data);
    invoke("pty_write", { tabId: props.tabId, data: bytes }).catch((e) => {
      appendOutput(`\x1b[31m[braces] write error: ${e}\x1b[0m\r\n`);
    });
  };

  // Whether the user is (roughly) at the bottom of the block list already.
  const isNearBottom = () => {
    if (!blocksRef) return true;
    const slack = 48;
    return blocksRef.scrollHeight - blocksRef.scrollTop - blocksRef.clientHeight < slack;
  };

  // Sticky auto-follow. The flag is cleared ONLY by an explicit user gesture —
  // wheel/trackpad scrolling upward (the onWheel handler below) — and re-armed
  // when the user returns to the bottom or runs a command. Deliberately NOT
  // derived from scroll events: scroll-event timing vs content growth is racy
  // (WKWebView dispatches them late against rAF), and any "am I still at the
  // bottom?" sampling scheme eventually mis-reads its own programmatic scroll
  // as the user scrolling away, silently killing the follow.
  let followBottom = true;

  // Pin the view to the bottom now, and keep re-pinning every frame for a short
  // window. A single one-shot scroll can land before late layout (font metrics,
  // the block's close-time <br> trim, the exit-code pill row, padding resize)
  // grows or shrinks the content under it, leaving the tail hidden behind the
  // input bar. The frame loop makes the final position independent of that
  // ordering; a wheel-up cancels it instantly via followBottom.
  const PIN_WINDOW_MS = 250;
  let pinUntil = 0;
  let pinActive = false;
  const pinLoop = () => {
    if (!followBottom || !blocksRef || performance.now() >= pinUntil) { pinActive = false; return; }
    const max = blocksRef.scrollHeight - blocksRef.clientHeight;
    if (blocksRef.scrollTop < max) blocksRef.scrollTop = max;
    requestAnimationFrame(pinLoop);
  };
  const scrollToBottom = () => {
    if (!blocksRef) return;
    blocksRef.scrollTop = blocksRef.scrollHeight;
    pinUntil = performance.now() + PIN_WINDOW_MS;
    if (!pinActive) { pinActive = true; requestAnimationFrame(pinLoop); }
  };

  // Coalesce streaming renders: PTY bursts deliver many chunks per frame (command
  // echo, output, prompt marker), and regenerating the block's innerHTML for each
  // one makes the block visibly flash. Accumulate into activeScreen immediately
  // (lossless) but rasterise to HTML at most once per animation frame.
  let renderQueued = false;
  const renderActiveBlock = () => {
    renderQueued = false;
    if (!activeBlockId) return;
    const html = activeScreen.toHtml();
    const id = activeBlockId;
    setBlocks(prev => prev.map(b =>
      b.id === id ? { ...b, htmlOutput: html } : b
    ));
    if (followBottom) scrollToBottom();
  };

  const appendOutput = (text: string) => {
    if (!activeBlockId) return;
    activeScreen.write(text);
    if (!renderQueued) {
      renderQueued = true;
      requestAnimationFrame(renderActiveBlock);
    }
  };

  const closeBlock = (exitCode: number | null = null) => {
    if (!activeBlockId) return;
    // Flush any render still waiting on its animation frame — the queued callback
    // would no-op once activeBlockId is cleared and silently drop the last chunk.
    if (renderQueued) renderActiveBlock();
    const id = activeBlockId;
    setBlocks(prev => prev.map(b => {
      if (b.id !== id) return b;
      // Strip trailing blank lines — ConPTY often emits a screen-buffer redraw
      // whose trailing whitespace/newlines would otherwise make the block tall.
      const trimmed = b.htmlOutput.replace(/(<br\s*\/?>)+$/, '');
      return { ...b, htmlOutput: trimmed, done: true, exitCode, endTime: Date.now() };
    }));
    setTabExitCode(exitCode);
    activeBlockId = "";
    activeScreen = mkScreen();
    // Persist blocks to SQLite (errors surface in the console)
    persistBlocks();
    // Always fire git-refresh after every command completion so the branch pill
    // and change counter update even when the exit code doesn't change value.
    const cwd = tabCwd();
    if (cwd && cwd !== "~") {
      window.dispatchEvent(new CustomEvent("braces:git-refresh", { detail: { cwd } }));
    }
    // Resize the PTY only when the window WIDTH changed — the height stays pinned
    // at BLOCK_ROWS so ConPTY never scrolls in block mode. Keeping rows constant
    // means there's no resize (and so no screen-buffer re-emit "flood") between
    // successive commands, which previously corrupted the next block. The resize
    // runs here with activeBlockId already cleared so any flood is discarded.
    if (term && term.cols !== lastPtyCols) {
      lastPtyCols = term.cols;
      lastPtyRows = BLOCK_ROWS;
      invoke("pty_resize", { tabId: props.tabId, cols: lastPtyCols, rows: BLOCK_ROWS }).catch(() => {});
    }
    if (followBottom) scrollToBottom();
  };

  const trackCdCommand = (raw: string) => {
    // Bare Windows drive-letter switch: "E:", "C:", "D:" etc.
    // OSC 0 from the shell prompt will correct to the exact last-visited path once the command completes.
    if (/^[A-Za-z]:$/.test(raw.trim())) {
      setTabCwd(raw.trim()[0].toUpperCase() + ":/");
      return;
    }

    const m = raw.match(/^(?:cd|chdir|pushd)\s*(.*)/i);
    if (!m) return;
    const target = m[1].trim().replace(/^["']|["']$/g, "");
    if (!target) return;
    if (target === "~") {
      invoke<string>("pty_home_dir").then(h => setTabCwd(h)).catch(() => {});
      return;
    }
    if (target === "..") {
      setTabCwd(c => {
        const parts = c.replace(/\\/g, "/").split("/").filter(Boolean);
        if (parts.length > 1) parts.pop();
        return parts.join("/") || "/";
      });
      return;
    }
    if (/^[A-Za-z]:/.test(target) || target.startsWith("/") || target.startsWith("\\")) {
      setTabCwd(target.replace(/\\/g, "/"));
      return;
    }
    setTabCwd(c => {
      const base = c.replace(/\\/g, "/").replace(/\/$/, "");
      return base + "/" + target;
    });
  };

  // Hand the whole pane to the real terminal (xterm): hide the input + blocks,
  // enable stdin, focus xterm. Used both on launching a known interactive program
  // and as a fallback when an app switches to the alternate screen.
  const enterInteractive = () => {
    if (isInteractive()) return;
    term?.reset(); // clean grid — no stale frame from a previous run can bleed through
    interactiveStartedAt = Date.now();
    captureInteractiveOutput = true;
    setIsInteractive(true);
    // The PTY gets real dimensions immediately (the program must lay out for the
    // true window size from its first frame) — only the visual swap waits.
    requestAnimationFrame(() => {
      fitAddon?.fit();
      lastPtyCols = term?.cols ?? 80;
      lastPtyRows = term?.rows ?? 24;
      invoke("pty_resize", { tabId: props.tabId, cols: lastPtyCols, rows: lastPtyRows }).catch(() => {});
    });
    uiFlipTimer = setTimeout(() => {
      if (!isInteractive()) return;
      setUiInteractive(true);
      term?.focus();
    }, INTERACTIVE_UI_DELAY_MS);
  };
  // Return to the block UI: restore the input, drop the frame, refocus the input box.
  const exitInteractive = () => {
    if (!isInteractive()) return;
    if (uiFlipTimer) clearTimeout(uiFlipTimer);
    setUiInteractive(false);
    setIsInteractive(false);
    setInteractiveCmd("");
    term?.reset();
    // Restore the tall block-mode screen so the PTY stops scrolling once the
    // interactive program (which ran at the real window height) has exited.
    if (term) {
      lastPtyCols = term.cols;
      lastPtyRows = BLOCK_ROWS;
      invoke("pty_resize", { tabId: props.tabId, cols: term.cols, rows: BLOCK_ROWS }).catch(() => {});
    }
    // Reveal whatever grew in the now-hidden block while .warp-blocks was frozen
    // (pointer-events: none + visibility: hidden for the whole interactive session).
    if (followBottom) scrollToBottom();
    setTimeout(() => { inputRef?.focus(); }, 32);
  };

  const submitCmd = () => {
    // Stdin mode: the line goes verbatim (untrimmed) to the running command,
    // no new block, no history entry — it's program input, not a command.
    if (stdinMode()) {
      const line = cmdText();
      setCmdText("");
      sendRaw(line + "\r");
      return;
    }

    const raw = cmdText().trim();
    setCmdText("");
    if (raw) {
      setCmdHistory(h => {
        const entry: HistEntry = { cmd: raw, ts: Date.now() };
        const deduped = [entry, ...h.filter(c => c.cmd !== raw)].slice(0, HISTORY_MAX);
        persistHistory(deduped);
        return deduped;
      });
      setTabTitle(raw.length > 40 ? raw.slice(0, 40) + "…" : raw);
      invoke("history_add", { command: raw }).catch(() => {});
      trackCdCommand(raw);

      // Branch/ref-changing git command → refresh the branch pill + change counter
      // without waiting for the 2 s poll. Fired as a short staggered burst because
      // we don't know exactly when the command finishes; the retries also ride out
      // any brief .git/index.lock contention right after the command exits.
      if (GIT_MUTATING_RE.test(raw)) {
        const cwd = tabCwd();
        if (cwd && cwd !== "~") {
          for (const ms of [350, 900, 1800]) {
            setTimeout(() => window.dispatchEvent(
              new CustomEvent("braces:git-refresh", { detail: { cwd } })
            ), ms);
          }
        }
      }

      // Known interactive program → take over the terminal immediately. A block is
      // created so the command appears in the history after the session ends, but it
      // has no captured output (the live UI isn't text we can replay).
      if (isInteractiveCommand(raw)) {
        sendRaw(raw + "\r");
        const iblock: CommandBlock = {
          id: Math.random().toString(36).slice(2),
          cmd: raw,
          cwd: tabCwd(),
          startTime: Date.now(),
          endTime: null,
          exitCode: null,
          htmlOutput: "",
          done: false,
        };
        setBlocks(prev => [...prev, iblock]);
        activeBlockId = iblock.id;
        activeScreen = mkScreen();
        followBottom = true; // running a command always jumps to its new block
        scrollToBottom();
        setInteractiveCmd(raw);
        enterInteractive();
        return;
      }

      echoFilter = raw;
      const block: CommandBlock = {
        id: Math.random().toString(36).slice(2),
        cmd: raw,
        cwd: tabCwd(),
        startTime: Date.now(),
        endTime: null,
        exitCode: null,
        htmlOutput: "",
        done: false,
      };
      setBlocks(prev => [...prev, block]);
      activeBlockId = block.id;
      activeScreen = mkScreen();
      followBottom = true; // running a command always jumps to its new block
      scrollToBottom();
    }
    sendRaw((raw || "") + "\r");
  };

  // Auto-scroll the selected history item into view.
  createEffect(() => {
    if (!showHistPanel()) return;
    const sel = histPanelSel();
    requestAnimationFrame(() => {
      histPanelRef
        ?.querySelector<HTMLElement>(`[data-hpidx="${sel}"]`)
        ?.scrollIntoView({ block: "nearest" });
    });
  });

  // Auto-scroll the selected tab completion item into view.
  createEffect(() => {
    if (!showTabPanel()) return;
    const idx = tabCompIdx();
    requestAnimationFrame(() => {
      tabPanelRef
        ?.querySelector<HTMLElement>(`[data-tcidx="${idx}"]`)
        ?.scrollIntoView({ block: "nearest" });
    });
  });

  const handleKeyDown = (e: KeyboardEvent) => {
    const hist = cmdHistory();

    // ── Tab completion panel navigation ──────────────────────────────────
    if (showTabPanel()) {
      if (e.key === "Escape") {
        e.preventDefault();
        setShowTabPanel(false);
        setTabCompletions([]);
        setCmdText(preTabText);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        setShowTabPanel(false);
        setTabCompletions([]);
        submitCmd();
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        const comps = tabCompletions();
        const next = (tabCompIdx() + 1) % comps.length;
        setTabCompIdx(next);
        setCmdText(comps[next]);
        requestAnimationFrame(() => inputRef?.setSelectionRange(comps[next].length, comps[next].length));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        const comps = tabCompletions();
        const prev = (tabCompIdx() - 1 + comps.length) % comps.length;
        setTabCompIdx(prev);
        setCmdText(comps[prev]);
        requestAnimationFrame(() => inputRef?.setSelectionRange(comps[prev].length, comps[prev].length));
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const comps = tabCompletions();
        const next = (tabCompIdx() + 1) % comps.length;
        setTabCompIdx(next);
        setCmdText(comps[next]);
        requestAnimationFrame(() => inputRef?.setSelectionRange(comps[next].length, comps[next].length));
        return;
      }
    }

    // ── History panel navigation ─────────────────────────────────────────
    if (showHistPanel()) {
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHistPanelSel(i => Math.min(i + 1, hist.length - 1));
        setCmdText(hist[histPanelSel()]?.cmd ?? "");
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = histPanelSel() - 1;
        if (next < 0) {
          setShowHistPanel(false);
          setCmdText("");
          setHistPanelSel(0);
        } else {
          setHistPanelSel(next);
          setCmdText(hist[next]?.cmd ?? "");
        }
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const cmd = hist[histPanelSel()]?.cmd ?? "";
        setShowHistPanel(false);
        setCmdText(cmd);
        submitCmd();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setShowHistPanel(false);
        setCmdText("");
        setHistPanelSel(0);
        return;
      }
    }

    switch (e.key) {
      case "Enter":
        e.preventDefault();
        submitCmd();
        return;
      case "ArrowUp":
        e.preventDefault();
        if (hist.length > 0) {
          setShowHistPanel(true);
          setHistPanelSel(0);
          setCmdText(hist[0]?.cmd ?? "");
        }
        return;
      case "ArrowDown":
        e.preventDefault();
        return;
      case "ArrowRight": {
        const sug = suggestion();
        if (sug && inputRef && inputRef.selectionStart === inputRef.value.length) {
          e.preventDefault();
          setCmdText(sug);
                requestAnimationFrame(() => inputRef?.setSelectionRange(sug.length, sug.length));
        }
        return;
      }
      case "Tab": {
        e.preventDefault();
        const text = cmdText();
        preTabText = text;
        invoke<string[]>("shell_complete", { input: text, cwd: tabCwd() }).then(matches => {
          if (matches.length === 0) return;
          if (matches.length === 1) {
            setCmdText(matches[0]);
            requestAnimationFrame(() => inputRef?.setSelectionRange(matches[0].length, matches[0].length));
            return;
          }
          setTabCompletions(matches);
          setTabCompIdx(0);
          setShowTabPanel(true);
          setCmdText(matches[0]);
          requestAnimationFrame(() => inputRef?.setSelectionRange(matches[0].length, matches[0].length));
        });
        return;
      }
      case "c":
        if (e.ctrlKey) { e.preventDefault(); setCmdText(""); sendRaw("\x03"); }
        return;
      case "d":
        if (e.ctrlKey) { e.preventDefault(); sendRaw("\x04"); }
        return;
      case "l":
        if (e.ctrlKey) {
          e.preventDefault();
          setBlocks([]);
          activeBlockId = "";
          activeScreen = mkScreen();
          // Clear persisted blocks for this tab too
          invoke("db_save_blocks", { tabId: props.tabId, blocks: [] }).catch(() => {});
        }
        return;
    }
  };

  const shortCwd = () => {
    const c = tabCwd();
    const parts = c.replace(/\\/g, "/").split("/").filter(Boolean);
    return parts.length > 2 ? "…/" + parts.slice(-2).join("/") : c;
  };

  onMount(async () => {
    term = new Terminal({
      // stdin stays enabled at all times: toggling disableStdin at runtime does not
      // reliably re-init xterm's input textarea, which left interactive apps unable
      // to receive keystrokes. In block mode xterm is hidden + unfocused and the
      // onData handler below is gated on isInteractive(), so it can't steal input.
      convertEol: true,
      fontFamily: '"Hack","Cascadia Code","Consolas",monospace',
      fontSize: 14,
      lineHeight: 1.2,
      cursorStyle: "bar",
      cursorBlink: false,
      // This xterm instance is only active during interactive programs (vim, htop…).
      // Block-mode output lives in the HTML block renderer, not here.
      // 1000 lines covers every real TUI use case and costs ~10× less RAM than 10 000.
      scrollback: 1000,
      theme: NEON_NOIR_THEME,
      allowProposedApi: true,
    });
    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    // Mirrors the Ctrl+Click-to-open behavior of block-mode output (see ansiToHtml.ts
    // linkifyLine) so interactive programs (vim, ssh, htop…) get the same link handling.
    term.loadAddon(new WebLinksAddon((event, uri) => {
      if (!event.ctrlKey) return;
      shellOpen(uri).catch(() => {});
    }));
    term.open(outputRef);

    // Wait for monospace fonts to load so xterm measures correct cell width.
    // Without this, cells are sized to the fallback font and text renders squished.
    await document.fonts.ready;

    term.parser.registerOscHandler(7, (data) => {
      if (data.startsWith("file://")) {
        try {
          setTabCwd(decodeURIComponent(new URL(data).pathname.replace(/^\/([A-Za-z]:)/, "$1")));
        } catch { setTabCwd(data); }
      } else if (data) {
        setTabCwd(data);
      }
      return true;
    });

    // Exit detection (two independent signals, both safe against Claude Code's
    // mid-conversation title churn — Claude never sets either of these):
    //   1. Our custom prompt's [CWD:…] marker (pwsh, and cmd once the prompt redraws).
    //   2. ConPTY restoring the shell's own executable title (e.g.
    //      "C:\WINDOWS\system32\cmd.exe") when the foreground program exits. On cmd.exe
    //      this is often the ONLY signal that arrives, because the [CWD:] prompt redraw
    //      doesn't always surface after a full-screen child exits.
    // A short grace window after launch ignores the transient cmd.exe title that can
    // appear before the launched program takes over the console.
    const SHELL_TITLE = /(?:cmd|powershell|pwsh|bash|sh|zsh)(?:\.exe)?\s*$/i;
    term.parser.registerOscHandler(0, (data) => {
      if (data.startsWith("[CWD:")) {
        const { cwd, exitCode } = parseCwdMarker(data);
        if (cwd) setTabCwd(cwd);
        if (isInteractive()) { exitInteractive(); closeBlock(exitCode); }
        return true;
      }
      if (isInteractive() && SHELL_TITLE.test(data) && Date.now() - interactiveStartedAt > 800) {
        exitInteractive();
        closeBlock(null); // shell-title fallback carries no exit-code info
      }
      return false;
    });

    await new Promise<void>(r => requestAnimationFrame(() => r()));
    fitAddon.fit();

    // xterm creates an internal textarea for keyboard input. Without disableStdin,
    // that textarea can steal focus from the WIB input and swallow keystrokes silently
    // (onData guard prevents them reaching the PTY, but the WIB never sees them either).
    // Solution: redirect focus back to the WIB whenever xterm's textarea gains focus
    // outside of interactive mode.
    const xtermTextarea = outputRef.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement | null;
    if (xtermTextarea) {
      xtermTextarea.addEventListener("focus", () => {
        if (!isInteractive()) {
          setTimeout(() => { if (!isInteractive()) inputRef?.focus(); }, 0);
        }
      });
    }

    term.onData(data => { if (isInteractive()) sendRaw(data); });

    // Claude Code: Shift+Enter inserts a newline instead of submitting. xterm would
    // send a plain \r for it, so translate to ESC+CR (what Option/Meta+Enter sends),
    // which Claude Code binds to insert-newline in any terminal.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && e.key === "Enter" && e.shiftKey && isClaudeSession()) {
        // preventDefault too: returning false only skips xterm's handling — the
        // browser would still put a newline in xterm's helper textarea.
        e.preventDefault();
        sendRaw("\x1b\r");
        return false;
      }
      return true;
    });

    // Capture-phase: intercept image pastes before xterm's own paste handler.
    outputRef.addEventListener("paste", handleXtermPaste, true);

    // ── PTY data routing ────────────────────────────────────────────────────
    // Interactive mode: bytes go to xterm (primary) + raw scan (backup).
    //   Primary: xterm OSC parser fires the registerOscHandler(0) handler above
    //            when the shell prompt marker [CWD:…] appears. Handles fragmentation.
    //   Backup:  raw string scan of the last 64 bytes detects the marker synchronously
    //            in case xterm's handler doesn't fire (e.g. parser state edge-cases).
    // Non-interactive: detect an indirect TUI launch via the alternate-screen-on seq.
    const ALT_ON      = /\x1b\[\?(?:1049|1047|47)h/;
    const PROMPT_MARK = "\x1b]0;[CWD:";
    // Shell-executable title restored by ConPTY on program exit (backup for the OSC 0
    // handler above). NOT \x1b[?2004l — Claude Code emits that on every response cycle.
    const SHELL_TITLE_SEQ = /\x1b\]0;[^\x07\x1b]*(?:cmd|powershell|pwsh)(?:\.exe)?[^\x07\x1b]*(?:\x07|\x1b\\)/i;
    let   detectCarry = "";

    const unlistenPty = await listen<number[]>(`pty-data-${props.tabId}`, (ev) => {
      const bytes = new Uint8Array(ev.payload);
      const text = new TextDecoder().decode(bytes);

      if (!isInteractive()) {
        // Indirect TUI: app switched to the alternate screen without being in
        // ALWAYS_INTERACTIVE (e.g. `git commit` → vim).
        if (ALT_ON.test(text)) { enterInteractive(); }
      }

      if (isInteractive()) {
        if (captureInteractiveOutput) {
          if (ALT_ON.test(text) || Date.now() - interactiveStartedAt > INTERACTIVE_CAPTURE_GRACE_MS) {
            captureInteractiveOutput = false;
          } else {
            appendOutput(text);
          }
        }

        // Primary: write through xterm so OSC 0 handler can fire.
        term.write(bytes);

        // Backup: raw scan across chunk boundary (OSC 0 handler may not have fired).
        if (isInteractive()) {
          const scan = detectCarry + text;
          detectCarry = scan.slice(-96);
          const cwdMark = scan.includes(PROMPT_MARK);
          const shellMark = Date.now() - interactiveStartedAt > 800 && SHELL_TITLE_SEQ.test(scan);
          if (cwdMark || shellMark) {
            const m = /\x1b\]0;(\[CWD:[^\x07\x1b\]]*\])/.exec(scan);
            const parsed = m ? parseCwdMarker(m[1]) : null;
            if (parsed?.cwd) setTabCwd(parsed.cwd);
            exitInteractive();
            closeBlock(parsed?.exitCode ?? null);
          }
        }
        return;
      }

      detectCarry = "";

      titleBuf = (titleBuf + text).slice(-512);

      const osc0 = /\x1b\]0;(\[CWD:[^\x07\x1b\]]*\])(?:\x07|\x1b\\)/.exec(titleBuf);

      // Append this chunk's text BEFORE closing the block below. A command that
      // fails almost instantly (e.g. `ssh` with no host, a missing binary) can have
      // its error text and the shell's exit-marker land in the very same PTY read —
      // closing first would reset activeBlockId/activeScreen and silently drop that
      // text, leaving the block empty except for the exit code.
      let displayText = text;
      if (echoFilter) {
        const echoLine = echoFilter + "\r\n";
        const idx = displayText.indexOf(echoLine);
        if (idx !== -1) {
          displayText = displayText.slice(0, idx) + displayText.slice(idx + echoLine.length);
          echoFilter = "";
        }
      }

      displayText = displayText.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");

      if (displayText) appendOutput(displayText);

      if (osc0) {
        const { cwd, exitCode } = parseCwdMarker(osc0[1]);
        if (cwd) setTabCwd(cwd);
        closeBlock(exitCode);
        titleBuf = titleBuf.slice(osc0.index + osc0[0].length);
      }
    });

    const unlistenAnalysis = await listen<string>("ai-analysis-token", (ev) => {
      if (store.activeTabId !== props.tabId) return;
      setStore("errorAnalysis", prev => prev + ev.payload);
      const fix = store.errorAnalysis.split("\n").find(l => l.startsWith("FIX:"));
      if (fix) setStore("errorFix", fix.replace(/^FIX:\s*/, "").trim());
    });

    // The AI agent injects its commands straight into this tab's PTY (backend
    // exec_in_pty). The shell runs them, but block mode discards PTY output when
    // no block is open — so open one here, exactly like submitCmd does minus the
    // PTY write. The existing pty-data handler then streams the output into it
    // and the prompt's OSC 0 marker closes it with the real exit code.
    const unlistenAgentExec = await listen<Record<string, unknown>>("ai-agent-event", (ev) => {
      if (store.activeTabId !== props.tabId) return;
      const evt = ev.payload;
      if (evt.t !== "exec_start" || typeof evt.cmd !== "string") return;
      if (isInteractive()) return; // raw xterm already shows injected input as-is
      if (activeBlockId) return;   // a command is mid-run; don't hijack its block
      echoFilter = evt.cmd;
      const block: CommandBlock = {
        id: Math.random().toString(36).slice(2),
        cmd: evt.cmd,
        cwd: tabCwd(),
        startTime: Date.now(),
        endTime: null,
        exitCode: null,
        htmlOutput: "",
        done: false,
      };
      setBlocks(prev => [...prev, block]);
      activeBlockId = block.id;
      activeScreen = mkScreen();
      followBottom = true;
      scrollToBottom();
    });

    const ro = new ResizeObserver(() => {
      fitAddon?.fit();
      // Only resize the PTY in interactive mode. In block mode, ConPTY would
      // respond by re-emitting its visible screen buffer, which corrupts the
      // block renderer (all redrawn output floods the current open block).
      // Interactive-mode programs always get correct dims via enterInteractive().
      // Non-interactive commands sync size in submitCmd() when dims have changed.
      if (isInteractive()) {
        lastPtyCols = term.cols;
        lastPtyRows = term.rows;
        invoke("pty_resize", { tabId: props.tabId, cols: term.cols, rows: term.rows }).catch(() => {});
      }
    });
    ro.observe(outputRef);

    // Keep the end-of-list spacer exactly as tall as the input bar overlay.
    // The bar's height varies a lot (history/branch/tab-completion panels can
    // add 100-300px above the input row), so a hardcoded spacer would let the
    // last blocks render underneath it. The reserved space is a real child
    // element rather than padding-bottom — WebKit doesn't reliably count a
    // flex scroll container's bottom padding in scrollHeight, which let
    // content hide behind the bar before scrolling ever activated.
    const wibRo = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height ?? 0;
      // h reads 0 mid-teardown; writing that through would collapse the
      // reserved space while scrollTop is already at max. Keep the last
      // sane value instead.
      if (h > 0 && wibSpacerRef) {
        wibSpacerRef.style.height = `${h + 16}px`;
        // Growing the spacer pushes the bottom edge down past the viewport —
        // re-pin so the last block isn't left hidden under the taller bar.
        if (followBottom && blocksRef) blocksRef.scrollTop = blocksRef.scrollHeight;
      }
    });
    wibRo.observe(wibContainerRef);

    const onGlobalKey = (e: KeyboardEvent) => {
      if (store.activeTabId !== props.tabId) return;
      if (e.ctrlKey && e.shiftKey && e.key === "A") { e.preventDefault(); setStore("sidePanelOpen", v => !v); }
      if (e.ctrlKey && e.shiftKey && e.key === "M") { e.preventDefault(); setStore("metricsOpen", v => !v); }

      // Ctrl+C pressed with focus anywhere else in the window interrupts the
      // running command. The WIB input and xterm already forward their own
      // Ctrl+C when focused, but focus routinely ends up elsewhere — e.g. after
      // clicking block output to read logs, or coming back to Braces after
      // `pnpm tauri dev` opened its app window — and the keystroke was silently
      // lost. Editable elements keep their own Ctrl+C (WIB/xterm forward it to
      // the PTY themselves; typing in the AI panel must not interrupt anything),
      // and a non-empty text selection still means "copy".
      if (
        e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey &&
        e.key.toLowerCase() === "c" && hasRunningBlock()
      ) {
        const el = document.activeElement;
        const editable =
          el instanceof HTMLInputElement ||
          el instanceof HTMLTextAreaElement ||
          (el instanceof HTMLElement && el.isContentEditable);
        if (!editable && (window.getSelection()?.isCollapsed ?? true)) {
          e.preventDefault();
          sendRaw("\x03");
          return;
        }
      }

      if (isInteractive()) return;
      if (e.ctrlKey && e.key === "r" && !e.shiftKey) { e.preventDefault(); setStore("historySearchOpen", v => !v); }
      if (e.ctrlKey && e.key === "f" && store.errorFix) {
        e.preventDefault();
        setCmdText(store.errorFix);
        setStore("errorPanelOpen", false);
        inputRef?.focus();
      }
    };
    window.addEventListener("keydown", onGlobalKey);

    const onInject = (e: Event) => {
      if (store.activeTabId !== props.tabId) return;
      setCmdText((e as CustomEvent<string>).detail);
      inputRef?.focus();
    };
    window.addEventListener("braces:inject-cmd", onInject);

    const cols = Math.max(term.cols, 80);
    const rows = BLOCK_ROWS;

    // ── Restore blocks saved from the previous session ───────────────────
    let isRestoredTab = false;
    try {
      const savedBlocks = await invoke<CommandBlock[]>("db_load_blocks", { tabId: props.tabId });
      console.debug("[braces] db_load_blocks", props.tabId, "→", savedBlocks.length, "blocks");
      if (savedBlocks.length > 0) {
        // The PTY these blocks belonged to is gone — render them as finished
        // history cards (any block left mid-run when the app closed shows as done).
        setBlocks(savedBlocks.map((b) => ({ ...b, done: true })));
        isRestoredTab = true;
        // A restored session should open at its most recent block, not at the top.
        scrollToBottom();
      }
    } catch (e) {
      console.error("[braces] db_load_blocks failed:", e);
    }

    try {
      // Pass the saved cwd so the new shell starts in the right directory
      const savedCwd = tabCwd();
      const cwd = savedCwd && savedCwd !== "~" ? savedCwd : undefined;
      await invoke("pty_spawn", { tabId: props.tabId, cols, rows, cwd });
      lastPtyCols = cols;
      lastPtyRows = rows;
      ptyReadyRef = true;
      setPtyReady(true);

      const homeDir: string = await invoke("pty_home_dir");
      // Reset cwd to home only for tabs with no specific directory; restored tabs and
      // tabs opened in a real directory (e.g. via Ctrl+Alt+T) keep their saved cwd.
      if (!isRestoredTab && tabCwd() === "~") setTabCwd(homeDir);

      const shellType: string = await invoke("pty_shell_type", { tabId: props.tabId });
      const init = getShellInitScript(shellType);
      // Marker support == the init script exists for this shell; without it
      // blocks can never be detected as finished, so stdin-mode stays off.
      setShellHasMarker(!!init);
      if (init) setTimeout(() => sendRaw(init), 400);

      inputRef?.focus();
    } catch (e) {
      const errBlock: CommandBlock = {
        id: "spawn-error",
        cmd: "[braces]",
        cwd: "~",
        startTime: Date.now(),
        endTime: Date.now(),
        exitCode: 1,
        htmlOutput: `<span style="color:#f0726f">[braces] shell spawn failed: ${e}</span>`,
        done: true,
      };
      setBlocks([errBlock]);
    }

    onCleanup(() => {
      // Final flush so anything not yet caught by the debounce is persisted.
      if (saveBlocksTimer) clearTimeout(saveBlocksTimer);
      persistBlocks();
      unlistenPty();
      unlistenAnalysis();
      unlistenAgentExec();
      ro.disconnect();
      wibRo.disconnect();
      window.removeEventListener("keydown", onGlobalKey);
      window.removeEventListener("braces:inject-cmd", onInject);
      outputRef.removeEventListener("paste", handleXtermPaste, true);
      invoke("pty_kill", { tabId: props.tabId }).catch(() => {});
      term.dispose();
    });
  });

  return (
    <div class={`warp-terminal${uiInteractive() ? " interactive" : ""}`}>

      <div class="warp-main">
        <div class="warp-blocks" ref={blocksRef!} onWheel={(e) => {
          // Explicit upward wheel/trackpad = the user wants to read history:
          // detach from the bottom. This is the ONLY thing that detaches.
          if (e.deltaY < 0) followBottom = false;
        }} onScroll={() => {
          // Re-arm (never disarm) when the user arrives back at the bottom.
          if (isNearBottom()) followBottom = true;
        }} onClick={(e) => {
          if (!e.ctrlKey) return;
          const a = (e.target as HTMLElement).closest?.('a[data-url]') as HTMLElement | null;
          if (!a) return;
          e.preventDefault();
          const url = a.dataset.url ?? '';
          if (url) shellOpen(url).catch(() => {});
        }}>
          <Show when={blocks().length === 0 && ptyReady() && !isInteractive()}>
            <NewSessionWelcome cwd={tabCwd()} />
          </Show>
          <Index each={blocks()}>
            {(block) => {
              const elapsed = () => {
                const endTime = block().endTime;
                if (!endTime) return null;
                const ms = endTime - block().startTime;
                return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
              };
              const blockCwd = () => {
                const cwd = block().cwd;
                const parts = (cwd || "~").replace(/\\/g, "/").split("/").filter(Boolean);
                return parts.length > 2 ? "…/" + parts.slice(-2).join("/") : (cwd || "~");
              };
              const statusCls = () =>
                !block().done ? "running"
                : block().exitCode === 0 ? "ok"
                : block().exitCode === null ? "" // unknown — neutral border, not an error
                : "err";

              return (
                <div class={`cmd-block ${statusCls()}`}>
                  <div class="cmd-block-header">
                    <span class="cmd-block-cwd">⬡ {blockCwd()}</span>
                    <Show when={block().done && block().exitCode !== null}>
                      <span class={`cmd-block-status ${block().exitCode === 0 ? "ok" : "err"}`}>
                        {block().exitCode === 0 ? "✓" : `✕ ${block().exitCode}`}
                      </span>
                    </Show>
                    <Show when={elapsed() !== null}>
                      <span class="cmd-block-elapsed">{elapsed()}</span>
                    </Show>
                    <Show when={!block().done}>
                      <span class="cmd-block-spinner">●</span>
                      <button
                        class="cmd-block-stop"
                        title={t(store.language, "stop_cmd_tip")}
                        onClick={() => sendRaw("\x03")}
                      >■</button>
                    </Show>
                  </div>
                  <div class="cmd-block-cmd">
                    <span class="cmd-block-chevron">❯</span>
                    {block().cmd}
                  </div>
                  <Show when={!!block().htmlOutput}>
                    <div class="cmd-block-output" innerHTML={block().htmlOutput} />
                  </Show>
                </div>
              );
            }}
          </Index>
          {/* Reserves the input bar's footprint inside the scroll content —
              must stay the last child. See the wibRo ResizeObserver. */}
          <div class="wib-spacer" ref={wibSpacerRef!} aria-hidden="true" />
        </div>

        <div ref={outputRef} class="warp-output" />
      </div>

      {/* Slim status footer for Claude Code sessions. The regular input bar
          (which carries the branch/changes pills) is hidden for the whole
          interactive session, so without this the user loses all git context
          while Claude edits files. Rendered as a flex sibling of .warp-main so
          it takes real height — the ResizeObserver refits xterm automatically. */}
      <Show when={uiInteractive() && isClaudeSession()}>
        <div class="claude-bar">
          <span class="claude-bar-brand">✳ claude</span>
          <span class="claude-bar-spacer" />
          <span class="claude-bar-pill" title={tabCwd()}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>
            </svg>
            <span class="claude-bar-cwd">{shortCwd()}</span>
          </span>
          <Show when={store.gitIsRepo}>
            <span class="claude-bar-pill" title={store.gitBranch}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/>
                <circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>
              </svg>
              {store.gitBranch || "HEAD"}
              <Show when={store.gitAhead > 0}><span class="claude-bar-sync">↑{store.gitAhead}</span></Show>
              <Show when={store.gitBehind > 0}><span class="claude-bar-sync">↓{store.gitBehind}</span></Show>
            </span>
            <button
              class="claude-bar-pill claude-bar-changes"
              classList={{ active: store.gitPanelOpen }}
              title={t(store.language, "view_changes_tip")}
              onClick={() => setStore("gitPanelOpen", v => !v)}
            >
              <Show when={store.gitInsertions > 0 || store.gitDeletions > 0} fallback={<span class="claude-bar-clean">✓</span>}>
                <span class="claude-bar-ins">+{store.gitInsertions}</span>
                <span class="claude-bar-del">−{store.gitDeletions}</span>
              </Show>
            </button>
          </Show>
        </div>
      </Show>

      {/* Always mounted; hidden via CSS in interactive mode. Wrapping this in a
          <Show> destroyed the node on every interactive session: the ResizeObserver
          then reported height 0 (padding-bottom collapsed to 16px → blocks hid
          behind the input bar with scrollTop already at max), and after the <Show>
          recreated the node the observer was still bound to the dead one, so the
          padding never recovered. */}
      <div class="wib-container" ref={wibContainerRef!}>

        <Show when={showBranchPanel() && branches().length > 0}>
          <div class="branch-panel">
            <div class="branch-panel-header">
              <span class="branch-panel-title">{t(store.language, "branches_panel")}</span>
              <span class="branch-panel-hint">{t(store.language, "branch_hint")}</span>
              <button class="branch-panel-close" onClick={() => setShowBranchPanel(false)}>✕</button>
            </div>
            <div class="branch-panel-list">
              <For each={branches()}>
                {(b) => (
                  <div
                    class="branch-item"
                    classList={{ "branch-item-current": b === store.gitBranch }}
                    onClick={() => checkoutBranch(b)}
                  >
                    <svg class="branch-item-icon" width="12" height="12" viewBox="0 0 24 24" fill="none"
                      stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/>
                      <circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>
                    </svg>
                    <span class="branch-item-name">{b}</span>
                    <Show when={b === store.gitBranch}>
                      <span class="branch-item-check">✓</span>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>

        <Show when={showTabPanel() && tabCompletions().length > 0}>
          <div class="tab-comp-panel" ref={tabPanelRef}>
            <div class="tab-comp-header">
              <span class="tab-comp-title">{t(store.language, "completions_panel")}</span>
              <span class="tab-comp-hint">{t(store.language, "completions_hint")}</span>
            </div>
            <div class="tab-comp-list">
              <For each={tabCompletions()}>
                {(cmd, i) => (
                  <div
                    class="tab-comp-item"
                    classList={{ "tab-comp-item-sel": i() === tabCompIdx() }}
                    data-tcidx={i()}
                    onClick={() => {
                      setShowTabPanel(false);
                      setTabCompletions([]);
                      setCmdText(cmd);
                      submitCmd();
                    }}
                  >
                    <span class="tab-comp-chevron">❯</span>
                    <span class="tab-comp-cmd">{cmd}</span>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>

        <Show when={showHistPanel() && cmdHistory().length > 0}>
          <div class="hist-panel" ref={histPanelRef}>
            <div class="hist-panel-header">
              <span class="hist-panel-title">{t(store.language, "history_panel_title")}</span>
              <span class="hist-panel-hint">{t(store.language, "history_panel_hint")}</span>
            </div>
            <div class="hist-panel-list">
              <For each={[...cmdHistory()].reverse()}>
                {(entry, i) => {
                  const realIdx = () => cmdHistory().length - 1 - i();
                  return (
                    <div
                      class="hist-item"
                      classList={{ "hist-item-sel": realIdx() === histPanelSel() }}
                      data-hpidx={realIdx()}
                      onClick={() => {
                        setShowHistPanel(false);
                        setCmdText(entry.cmd);
                        submitCmd();
                      }}
                    >
                      <span class="hist-item-chevron">❯</span>
                      <span class="hist-item-cmd">{entry.cmd}</span>
                      <span class="hist-item-time">{relTime(entry.ts)}</span>
                    </div>
                  );
                }}
              </For>
            </div>
          </div>
        </Show>

        <div class="wib">
          <div class="wib-meta">
            <span class="wib-cwd-pill" title={tabCwd()}>
              <svg class="wib-folder" width="14" height="14" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>
              </svg>
              <span class="wib-cwd">{shortCwd()}</span>
            </span>
            <Show when={tabExitCode() !== null && tabExitCode() !== 0}>
              <span class="wib-exit-err">✕ {tabExitCode()}</span>
            </Show>
            <Show when={tabExitCode() === 0}>
              <span class="wib-exit-ok">✓</span>
            </Show>
            <span class="wib-meta-spacer" />
            <Show when={store.gitIsRepo}>
              <button
                class="wib-git-branch"
                classList={{ active: showBranchPanel() }}
                title={t(store.language, "switch_branch_tip")}
                onClick={openBranchSwitcher}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/>
                  <circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>
                </svg>
                {store.gitBranch || "HEAD"}
              </button>
              <button
                class="wib-git-changes"
                classList={{ active: store.gitPanelOpen }}
                title={t(store.language, "view_changes_tip")}
                onClick={() => { setShowBranchPanel(false); setStore("gitPanelOpen", v => !v); }}
              >
                <Show when={store.gitInsertions > 0 || store.gitDeletions > 0} fallback={<span class="wib-git-clean">✓</span>}>
                  <span class="wib-git-ins">+{store.gitInsertions}</span>
                  <span class="wib-git-del">−{store.gitDeletions}</span>
                </Show>
              </button>
            </Show>
          </div>
          <div class="wib-row">
            <span class="wib-chevron">❯</span>
            <div class="wib-input-wrap">
              <div class="wib-ghost" aria-hidden="true" ref={ghostRef}>{suggestion()}</div>
              <div class="wib-highlight" aria-hidden="true" ref={highlightRef}>
                <span class="wib-hl-inner" innerHTML={highlightHtml()} />
              </div>
              <input
                ref={inputRef}
                class="wib-input"
                type="text"
                value={cmdText()}
                onInput={e => { setCmdText(e.currentTarget.value); setShowHistPanel(false); setShowTabPanel(false); setTabCompletions([]); requestAnimationFrame(syncScroll); }}
                onScroll={syncScroll}
                onKeyDown={handleKeyDown}
                placeholder={
                  !ptyReady() ? t(store.language, "connecting_ph")
                  : stdinMode() ? t(store.language, "running_stdin_ph")
                  : t(store.language, "run_commands_ph")
                }
                disabled={!ptyReady()}
                autocomplete="off"
                spellcheck={false}
              />
            </div>
          </div>
        </div>

      </div>{/* wib-container */}

    </div>
  );
};

export default WarpTerminal;

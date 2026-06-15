import { Component, For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { store, setStore } from "../store/terminalStore";
import { getShellInitScript } from "./shellInit";
import { ansiChunkToHtml, mkAnsiState, type AnsiState } from "./ansiToHtml";
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

type ClaudeImage = { path: string; preview: string };
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

const baseName = (s: string): string =>
  (s.toLowerCase().replace(/\.(exe|cmd|bat|ps1|com)$/, "").split(/[\\/]/).pop() || s);

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
  let inputRef!: HTMLInputElement;
  let claudeTextareaRef: HTMLTextAreaElement | undefined;
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
  const [interactiveCmd, setInteractiveCmd] = createSignal("");
  const [claudeText, setClaudeText] = createSignal("");
  const [claudeImages, setClaudeImages] = createSignal<ClaudeImage[]>([]);
  const [blocks, setBlocks] = createSignal<CommandBlock[]>([]);

  const isClaudeSession = () =>
    isInteractive() && /^(?:npx\s+)?claude(?:\s|$)/i.test(interactiveCmd().trim());

  // Auto-focus the composer textarea whenever a Claude session starts.
  createEffect(() => { if (isClaudeSession()) setTimeout(() => claudeTextareaRef?.focus(), 50); });

  const submitClaudeMessage = () => {
    const text = claudeText();
    const images = claudeImages();
    if (!text.trim() && images.length === 0) return;

    const parts: string[] = [];
    if (text.trim()) parts.push(text.trim());
    parts.push(...images.map(img => img.path));
    const msg = parts.join("\n");

    // The Enter (\r) is ALWAYS sent as a separate, delayed write. If text + \r arrive in
    // one PTY chunk, Claude Code's stdin handling doesn't flush the submit until the next
    // event — which is why messages used to need a second Enter to go through.
    if (msg.includes("\n")) {
      // Multi-line: wrap in bracketed-paste so internal newlines stay as input rather
      // than submitting each line. Claude debounces pastes (~100ms), so the submitting
      // \r must wait past that window or it gets absorbed into the paste buffer.
      sendRaw(`\x1b[200~${msg}\x1b[201~`);
      setTimeout(() => sendRaw("\r"), 160);
    } else {
      // Single line: send as plain text (no bracketed-paste = no paste debounce), then
      // the \r shortly after as its own stdin event to trigger the submit.
      sendRaw(msg);
      setTimeout(() => sendRaw("\r"), 40);
    }

    setClaudeText("");
    setClaudeImages(prev => { prev.forEach(img => URL.revokeObjectURL(img.preview)); return []; });
    if (claudeTextareaRef) {
      claudeTextareaRef.style.height = "auto";
      setTimeout(() => claudeTextareaRef?.focus(), 0);
    }
  };

  const handleClaudePaste = async (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const blob = item.getAsFile();
        if (!blob) continue;
        const buf = await blob.arrayBuffer();
        const ext = item.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
        const data = Array.from(new Uint8Array(buf));
        const path = await invoke<string>("save_temp_image", { data, ext }).catch(() => "");
        if (!path) continue;
        const preview = URL.createObjectURL(blob);
        setClaudeImages(prev => [...prev, { path, preview }]);
      }
    }
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
  let activeAnsiState: AnsiState = mkAnsiState();
  let titleBuf = "";
  let interactiveStartedAt = 0;
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

  const scrollToBottom = () => {
    requestAnimationFrame(() => { if (blocksRef) blocksRef.scrollTop = blocksRef.scrollHeight; });
  };

  const appendOutput = (text: string) => {
    if (!activeBlockId) return;
    const { html, state } = ansiChunkToHtml(text, activeAnsiState);
    activeAnsiState = state;
    if (!html) return;
    const id = activeBlockId;
    setBlocks(prev => prev.map(b =>
      b.id === id ? { ...b, htmlOutput: b.htmlOutput + html } : b
    ));
    scrollToBottom();
  };

  const closeBlock = (exitCode: number | null = null) => {
    if (!activeBlockId) return;
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
    // Always fire git-refresh after every command completion so the branch pill
    // and change counter update even when the exit code doesn't change value.
    const cwd = tabCwd();
    if (cwd && cwd !== "~") {
      window.dispatchEvent(new CustomEvent("braces:git-refresh", { detail: { cwd } }));
    }
    // Resize here (activeBlockId is now empty) so any ConPTY screen-buffer
    // flood triggered by the resize is discarded by appendOutput's early return.
    // Doing this in submitCmd() instead caused the flood to land in the new block.
    if (term && (term.cols !== lastPtyCols || term.rows !== lastPtyRows)) {
      lastPtyCols = term.cols;
      lastPtyRows = term.rows;
      invoke("pty_resize", { tabId: props.tabId, cols: lastPtyCols, rows: lastPtyRows }).catch(() => {});
    }
    scrollToBottom();
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
    setIsInteractive(true);
    requestAnimationFrame(() => {
      fitAddon?.fit();
      lastPtyCols = term?.cols ?? 80;
      lastPtyRows = term?.rows ?? 24;
      invoke("pty_resize", { tabId: props.tabId, cols: lastPtyCols, rows: lastPtyRows }).catch(() => {});
      term?.focus();
    });
  };
  // Return to the block UI: restore the input, drop the frame, refocus the input box.
  const exitInteractive = () => {
    if (!isInteractive()) return;
    setIsInteractive(false);
    setInteractiveCmd("");
    claudeImages().forEach(img => URL.revokeObjectURL(img.preview));
    setClaudeImages([]);
    setClaudeText("");
    term?.reset();
    setTimeout(() => { inputRef?.focus(); }, 32);
  };

  const submitCmd = () => {
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
        activeAnsiState = mkAnsiState();
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
      activeAnsiState = mkAnsiState();
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
          activeAnsiState = mkAnsiState();
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
        const cwd = data.slice(5).replace(/\]$/, "");
        if (cwd) setTabCwd(cwd);
        if (isInteractive()) { exitInteractive(); closeBlock(tabExitCode()); }
        return true;
      }
      if (isInteractive() && SHELL_TITLE.test(data) && Date.now() - interactiveStartedAt > 800) {
        exitInteractive();
        closeBlock(tabExitCode());
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
        } else if (isClaudeSession()) {
          setTimeout(() => { if (isClaudeSession()) claudeTextareaRef?.focus(); }, 0);
        }
      });
    }

    term.onData(data => { if (isInteractive()) sendRaw(data); });

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
        // Primary: write through xterm so OSC 0 handler can fire.
        term.write(bytes);

        // Backup: raw scan across chunk boundary (OSC 0 handler may not have fired).
        if (isInteractive()) {
          const scan = detectCarry + text;
          detectCarry = scan.slice(-96);
          const cwdMark = scan.includes(PROMPT_MARK);
          const shellMark = Date.now() - interactiveStartedAt > 800 && SHELL_TITLE_SEQ.test(scan);
          if (cwdMark || shellMark) {
            const m = /\x1b\]0;\[CWD:([^\x07\x1b\]]*)\]/.exec(scan);
            if (m?.[1]) setTabCwd(m[1]);
            exitInteractive();
            closeBlock(tabExitCode());
          }
        }
        return;
      }

      detectCarry = "";

      titleBuf = (titleBuf + text).slice(-512);

      const osc0 = /\x1b\]0;\[CWD:([^\x07\x1b\]]*)\](?:\x07|\x1b\\)/.exec(titleBuf);
      if (osc0) {
        setTabCwd(osc0[1]);
        closeBlock(tabExitCode());
        titleBuf = titleBuf.slice(osc0.index + osc0[0].length);
      }

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
    });

    const unlistenAnalysis = await listen<string>("ai-analysis-token", (ev) => {
      if (store.activeTabId !== props.tabId) return;
      setStore("errorAnalysis", prev => prev + ev.payload);
      const fix = store.errorAnalysis.split("\n").find(l => l.startsWith("FIX:"));
      if (fix) setStore("errorFix", fix.replace(/^FIX:\s*/, "").trim());
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

    const onGlobalKey = (e: KeyboardEvent) => {
      if (store.activeTabId !== props.tabId) return;
      if (e.ctrlKey && e.shiftKey && e.key === "A") { e.preventDefault(); setStore("sidePanelOpen", v => !v); }
      if (e.ctrlKey && e.shiftKey && e.key === "M") { e.preventDefault(); setStore("metricsOpen", v => !v); }

      // While the Claude composer has focus, control signals must still reach the PTY.
      if (isClaudeSession()) {
        if (e.ctrlKey && e.key === "c") {
          e.preventDefault();
          sendRaw("\x03");
          setClaudeText("");
          if (claudeTextareaRef) claudeTextareaRef.style.height = "auto";
        } else if (e.ctrlKey && e.key === "d") {
          e.preventDefault();
          sendRaw("\x04");
        } else if (e.key === "Escape") {
          e.preventDefault();
          sendRaw("\x1b");
        }
        return;
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
    const rows = Math.max(term.rows, 24);
    try {
      await invoke("pty_spawn", { tabId: props.tabId, cols, rows });
      lastPtyCols = cols;
      lastPtyRows = rows;
      ptyReadyRef = true;
      setPtyReady(true);

      const homeDir: string = await invoke("pty_home_dir");
      setTabCwd(homeDir);

      const shellType: string = await invoke("pty_shell_type", { tabId: props.tabId });
      const init = getShellInitScript(shellType);
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
      unlistenPty();
      unlistenAnalysis();
      ro.disconnect();
      window.removeEventListener("keydown", onGlobalKey);
      window.removeEventListener("braces:inject-cmd", onInject);
      invoke("pty_kill", { tabId: props.tabId }).catch(() => {});
      term.dispose();
    });
  });

  return (
    <div class={`warp-terminal${isInteractive() ? " interactive" : ""}${isClaudeSession() ? " claude-session" : ""}`}>

      <div class="warp-main">
        <div class="warp-blocks" ref={blocksRef!}>
          <Show when={blocks().length === 0 && ptyReady() && !isInteractive()}>
            <NewSessionWelcome cwd={tabCwd()} />
          </Show>
          <For each={blocks()}>
            {(block) => {
              const elapsed = () => {
                if (!block.endTime) return null;
                const ms = block.endTime - block.startTime;
                return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
              };
              const blockCwd = () => {
                const parts = (block.cwd || "~").replace(/\\/g, "/").split("/").filter(Boolean);
                return parts.length > 2 ? "…/" + parts.slice(-2).join("/") : (block.cwd || "~");
              };
              const statusCls = () =>
                !block.done ? "running" : block.exitCode === 0 ? "ok" : "err";

              return (
                <div class={`cmd-block ${statusCls()}`}>
                  <div class="cmd-block-header">
                    <span class="cmd-block-cwd">⬡ {blockCwd()}</span>
                    <Show when={block.done && block.exitCode !== null}>
                      <span class={`cmd-block-status ${block.exitCode === 0 ? "ok" : "err"}`}>
                        {block.exitCode === 0 ? "✓" : `✕ ${block.exitCode}`}
                      </span>
                    </Show>
                    <Show when={elapsed() !== null}>
                      <span class="cmd-block-elapsed">{elapsed()}</span>
                    </Show>
                    <Show when={!block.done}>
                      <span class="cmd-block-spinner">●</span>
                    </Show>
                  </div>
                  <div class="cmd-block-cmd">
                    <span class="cmd-block-chevron">❯</span>
                    {block.cmd}
                  </div>
                  <Show when={!!block.htmlOutput}>
                    <div class="cmd-block-output" innerHTML={block.htmlOutput} />
                  </Show>
                </div>
              );
            }}
          </For>
        </div>

        <div ref={outputRef} class="warp-output" />
      </div>

      <Show when={isClaudeSession()}>
        <div class="claude-composer">
          <Show when={claudeImages().length > 0}>
            <div class="claude-images">
              <For each={claudeImages()}>
                {(img, i) => (
                  <div class="claude-image-preview">
                    <img src={img.preview} alt="" />
                    <button class="claude-image-remove" onClick={() => {
                      URL.revokeObjectURL(img.preview);
                      setClaudeImages(prev => prev.filter((_, j) => j !== i()));
                    }}>✕</button>
                  </div>
                )}
              </For>
            </div>
          </Show>
          <div class="claude-input-row">
            <span class="claude-chevron">❯</span>
            <textarea
              ref={claudeTextareaRef}
              class="claude-textarea"
              value={claudeText()}
              onInput={e => {
                setClaudeText(e.currentTarget.value);
                e.currentTarget.style.height = "auto";
                e.currentTarget.style.height = `${e.currentTarget.scrollHeight}px`;
              }}
              onKeyDown={e => {
                // When the composer is empty, forward navigation keys straight to Claude
                // so its interactive menus (model picker, permission prompts, etc.) work
                // with arrows / Enter / Tab. When there's text, behave as a message box.
                if (claudeText().length === 0 && !e.shiftKey) {
                  const NAV: Record<string, string> = {
                    ArrowUp: "\x1b[A", ArrowDown: "\x1b[B",
                    ArrowRight: "\x1b[C", ArrowLeft: "\x1b[D",
                    Enter: "\r", Tab: "\t",
                  };
                  const seq = NAV[e.key];
                  if (seq) { e.preventDefault(); sendRaw(seq); return; }
                }
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitClaudeMessage(); }
              }}
              onPaste={handleClaudePaste}
              placeholder="Message Claude… (Shift+Enter for newline · ↑↓ Enter navigate menus)"
              rows={1}
            />
            <button class="claude-send-btn" title="Send (Enter)" onClick={submitClaudeMessage}>↵</button>
          </div>
        </div>
      </Show>

      <Show when={!isInteractive()}>
        <div class="wib-container">

        <Show when={showBranchPanel() && branches().length > 0}>
          <div class="branch-panel">
            <div class="branch-panel-header">
              <span class="branch-panel-title">RAMAS</span>
              <span class="branch-panel-hint"><kbd>↵</kbd> cambiar &nbsp;·&nbsp; <kbd>esc</kbd> cerrar</span>
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
              <span class="tab-comp-title">COMPLETIONS</span>
              <span class="tab-comp-hint">
                <kbd>Tab</kbd> / <kbd>↑↓</kbd> navegar &nbsp;·&nbsp; <kbd>↵</kbd> ejecutar &nbsp;·&nbsp; <kbd>esc</kbd> cancelar
              </span>
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
              <span class="hist-panel-title">HISTORY</span>
              <span class="hist-panel-hint">
                <kbd>↑↓</kbd> navegar &nbsp;·&nbsp; <kbd>↵</kbd> seleccionar &nbsp;·&nbsp; <kbd>esc</kbd> cerrar
              </span>
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
                title="Cambiar de rama"
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
                title="Ver cambios (Ctrl+Shift+G)"
                onClick={() => { setShowBranchPanel(false); setStore("gitPanelOpen", v => !v); }}
              >
                ±{store.gitChangedCount}
              </button>
            </Show>
          </div>
          <div class="wib-row">
            <span class="wib-chevron">❯</span>
            <div class="wib-input-wrap">
              <div class="wib-ghost" aria-hidden="true">{suggestion()}</div>
              <input
                ref={inputRef}
                class="wib-input"
                type="text"
                value={cmdText()}
                onInput={e => { setCmdText(e.currentTarget.value); setShowHistPanel(false); setShowTabPanel(false); setTabCompletions([]); }}
                onKeyDown={handleKeyDown}
                placeholder={ptyReady() ? "Run commands…" : "Connecting…"}
                disabled={!ptyReady()}
                autocomplete="off"
                spellcheck={false}
              />
            </div>
          </div>
        </div>

        </div>{/* wib-container */}
      </Show>

    </div>
  );
};

export default WarpTerminal;

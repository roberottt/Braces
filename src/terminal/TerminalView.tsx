import { Component, onCleanup, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { InputHandler } from "./inputHandler";
import { store, setStore } from "../store/terminalStore";
import "@xterm/xterm/css/xterm.css";

// OSC sequence parser — extracts CWD (OSC 7) and exit code (OSC 133;D;N)
function parseOsc(raw: Uint8Array): { cwd?: string; exitCode?: number } {
  const text = new TextDecoder().decode(raw);
  const result: { cwd?: string; exitCode?: number } = {};
  const OSC_RE = /\x1b\](\d+);([^\x07\x1b]*)\x07/g;
  let m: RegExpExecArray | null;
  while ((m = OSC_RE.exec(text)) !== null) {
    const code = m[1], data = m[2];
    if (code === "7") {
      // OSC 7: file://hostname/path
      try {
        const url = new URL(data);
        result.cwd = decodeURIComponent(url.pathname.replace(/^\/[A-Za-z]:\//, (s) => s.slice(1)));
      } catch {
        result.cwd = data;
      }
    }
    if (code === "133" && data.startsWith("D;")) {
      result.exitCode = parseInt(data.slice(2), 10) || 0;
    }
  }
  return result;
}

const NEON_NOIR_THEME = {
  background: "#0a0a0a", foreground: "#e0e0e0",
  cursor: "#00d4ff", cursorAccent: "#0a0a0a",
  black: "#0a0a0a", red: "#ff3c6e", green: "#c8ff00", yellow: "#ff9a3c",
  blue: "#5577ff", magenta: "#d400ff", cyan: "#00d4ff", white: "#e0e0e0",
  brightBlack: "#444444", brightRed: "#ff3c6e", brightGreen: "#c8ff00",
  brightYellow: "#ff9a3c", brightBlue: "#5577ff", brightMagenta: "#d400ff",
  brightCyan: "#00d4ff", brightWhite: "#ffffff",
};

// Map theme name → xterm palette override
const XTERM_THEMES: Record<string, typeof NEON_NOIR_THEME> = {
  "neon-noir": NEON_NOIR_THEME,
  "ghost-protocol": { ...NEON_NOIR_THEME, background: "#000000", cursor: "#c8ff00", green: "#c8ff00", cyan: "#88ff00" },
  "akira":          { ...NEON_NOIR_THEME, background: "#050505", cursor: "#ff00aa", magenta: "#ff00aa" },
  "time-warp":      { ...NEON_NOIR_THEME, background: "#111111", cursor: "#ff9a3c", yellow: "#ff9a3c" },
  "minimal":        { ...NEON_NOIR_THEME, background: "#1a1a1a", cursor: "#ffffff", foreground: "#dddddd" },
};

const TerminalView: Component = () => {
  let wrapRef!: HTMLDivElement;
  let term: Terminal;
  let fitAddon: FitAddon;
  let inputHandler: InputHandler;

  let ptyReady = false;

  const sendToShell = (data: string) => {
    if (!ptyReady) return;
    const bytes = Array.from(new TextEncoder().encode(data));
    invoke("pty_write", { data: bytes }).catch((e) => {
      term?.write(`\r\n\x1b[31m[braces] write error: ${e}\x1b[0m\r\n`);
    });
  };

  // Inject a command into the PTY (used by side panel "apply fix" and history)
  const injectCommand = (cmd: string) => {
    sendToShell(cmd + "\r");
    invoke("history_add", { command: cmd }).catch(() => {});
  };

  onMount(async () => {
    term = new Terminal({
      fontFamily: '"JetBrains Mono","Cascadia Code","Consolas",monospace',
      fontSize: 14,
      lineHeight: 1.2,
      cursorStyle: "block",
      cursorBlink: true,
      theme: XTERM_THEMES[store.theme] ?? NEON_NOIR_THEME,
      allowProposedApi: true,
      scrollback: 10000,
      convertEol: true,
    });

    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(wrapRef);
    // Wait one animation frame so flex layout is finalized before measuring
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    fitAddon.fit();

    inputHandler = new InputHandler(term, sendToShell);
    // term.onData is registered AFTER pty_spawn succeeds (see below)

    // PTY output → xterm + OSC parsing
    const unlistenPty = await listen<number[]>("pty-data", (ev) => {
      console.log("[braces] pty-data", ev.payload.length, "bytes");
      const bytes = new Uint8Array(ev.payload);
      const osc = parseOsc(bytes);
      if (osc.cwd) setStore("cwd", osc.cwd);
      if (osc.exitCode !== undefined) {
        setStore("lastExitCode", osc.exitCode);
        if (osc.exitCode !== 0) {
          // Auto-open error panel and stream analysis
          setStore("errorPanelOpen", true);
          setStore("errorAnalysis", "");
          setStore("errorFix", "");
        }
      }
      term.write(bytes);
    });

    // Analysis tokens → error panel
    const unlistenAnalysis = await listen<string>("ai-analysis-token", (ev) => {
      setStore("errorAnalysis", (prev) => prev + ev.payload);
      // Try to extract FIX line
      const lines = store.errorAnalysis.split("\n");
      const fixLine = lines.find((l) => l.startsWith("FIX:"));
      if (fixLine) setStore("errorFix", fixLine.replace(/^FIX:\s*/, "").trim());
    });

    // Resize
    const ro = new ResizeObserver(() => {
      fitAddon.fit();
      invoke("pty_resize", { cols: term.cols, rows: term.rows }).catch(() => {});
    });
    ro.observe(wrapRef);

    // Global keybindings (Ctrl+Shift+A/M/R + Ctrl+F for fix)
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === "A") {
        e.preventDefault();
        setStore("sidePanelOpen", (v) => !v);
      }
      if (e.ctrlKey && e.shiftKey && e.key === "M") {
        e.preventDefault();
        setStore("metricsOpen", (v) => !v);
      }
      if (e.ctrlKey && e.key === "r" && !e.shiftKey) {
        // Ctrl+R — semantic history search
        e.preventDefault();
        setStore("historySearchOpen", (v) => !v);
      }
      if (e.ctrlKey && e.key === "f" && store.errorFix) {
        e.preventDefault();
        injectCommand(store.errorFix);
        setStore("errorPanelOpen", false);
      }
    };
    window.addEventListener("keydown", onKeyDown);

    // Custom events from side panel / history overlay
    const onInjectCmd = (e: Event) => {
      injectCommand((e as CustomEvent<string>).detail);
    };
    window.addEventListener("braces:inject-cmd", onInjectCmd);

    // Spawn PTY — onData is wired only after a successful spawn
    const cols = Math.max(term.cols, 80);
    const rows = Math.max(term.rows, 24);
    term.write(`\x1b[36m[braces] spawning shell (${cols}x${rows})…\x1b[0m\r\n`);
    try {
      await invoke("pty_spawn", { cols, rows });
      ptyReady = true;
      term.onData((data) => inputHandler.handle(data));
      term.write(`\x1b[36m[braces] shell ready\x1b[0m\r\n`);
    } catch (e) {
      console.error("[braces] pty_spawn failed:", e);
      term.write(`\x1b[31m[braces] shell spawn failed: ${e}\x1b[0m\r\n`);
      term.write(`\x1b[33mSet BRACES_SHELL env var to override (e.g. cmd.exe)\x1b[0m\r\n`);
    }

    term.focus();

    onCleanup(() => {
      unlistenPty();
      unlistenAnalysis();
      ro.disconnect();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("braces:inject-cmd", onInjectCmd);
      invoke("pty_kill").catch(() => {});
      term.dispose();
    });
  });

  return (
    <div class="terminal-wrap">
      <div ref={wrapRef} class="terminal-container" />
    </div>
  );
};

export default TerminalView;

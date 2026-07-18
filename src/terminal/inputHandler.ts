/**
 * Input state machine for Braces special modes:
 *   - Normal: forward to PTY
 *   - NL query: "? ..." → show confirmation banner
 *   - Confirmation: Enter executes / Esc cancels / E edits
 */

import { Terminal } from "@xterm/xterm";
import { isNlQuery, nlToShell, stripNlPrefix } from "../ai/nlShell";
import { requestAutocomplete, cancelAutocomplete } from "../ai/autocomplete";

export type SendToShell = (data: string) => void;

type Mode = "normal" | "nl-confirm";

type NlConfirmState = {
  original: string;   // the "? query" line
  command: string;    // the AI-suggested command
};

const ESC = "\x1b";
const CTRL_C = "\x03";
const ENTER = "\r";
const BACKSPACE = "\x7f";

// ANSI helpers
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const clearLine = "\r\x1b[2K";

export class InputHandler {
  private mode: Mode = "normal";
  private nlState: NlConfirmState | null = null;
  private inputBuffer = "";    // current line being typed (for NL detection)
  private ghostText = "";      // current ghost suggestion
  private cwd = "~";

  constructor(
    private term: Terminal,
    private send: SendToShell
  ) {}

  updateCwd(cwd: string): void {
    this.cwd = cwd;
  }

  /** Main entry point: called on every xterm.js onData event */
  handle(data: string): void {
    if (this.mode === "nl-confirm") {
      this.handleNlConfirm(data);
      return;
    }
    this.handleNormal(data);
  }

  private handleNormal(data: string): void {
    if (data === ENTER || data === "\n") {
      const line = this.inputBuffer;
      this.inputBuffer = "";
      cancelAutocomplete();
      this.ghostText = "";

      if (isNlQuery(line)) {
        // Intercept: don't forward Enter, start NL→shell instead
        this.startNlQuery(stripNlPrefix(line));
        return;
      }

      this.send(data);
      return;
    }

    if (data === BACKSPACE) {
      this.inputBuffer = this.inputBuffer.slice(0, -1);
      this.ghostText = "";
      cancelAutocomplete();
      this.send(data);
      return;
    }

    if (data === "\t") {
      // Tab: accept ghost text if present
      if (this.ghostText) {
        const accepted = this.ghostText;
        this.inputBuffer += accepted;
        this.ghostText = "";
        cancelAutocomplete();
        // Write the ghost text to the terminal and forward to PTY
        this.term.write(accepted);
        for (const ch of accepted) this.send(ch);
        return;
      }
      // Otherwise forward tab to shell for completion
      this.send(data);
      return;
    }

    if (data === CTRL_C) {
      this.inputBuffer = "";
      this.ghostText = "";
      cancelAutocomplete();
      this.send(data);
      return;
    }

    // Regular input — append to buffer, forward, trigger autocomplete
    if (data.length === 1 && data >= " ") {
      this.inputBuffer += data;
      this.send(data);
      const typed = this.inputBuffer;
      requestAutocomplete(typed, { cwd: this.cwd, recent: [] }, (command) => {
        this.updateGhost(command ? command.slice(typed.length) : "");
      });
    } else {
      // Control sequences, arrows, etc.
      this.inputBuffer = "";
      this.ghostText = "";
      cancelAutocomplete();
      this.send(data);
    }
  }

  private updateGhost(text: string): void {
    // Erase old ghost, draw new one
    if (this.ghostText) {
      // Move cursor left by ghost length, erase to end of line, redraw
      this.term.write("\x1b[" + this.ghostText.length + "D\x1b[K");
    }
    this.ghostText = text;
    if (text) {
      this.term.write(dim(text));
      // Move cursor back to insertion point
      this.term.write("\x1b[" + text.length + "D");
    }
  }

  private async startNlQuery(query: string): Promise<void> {
    this.term.write("\r\n");
    this.term.write(dim("  thinking..."));

    try {
      const result = await nlToShell(query);
      const cmd = result.command.trim();

      // Clear the "thinking" line and show the confirmation banner
      this.term.write(clearLine);
      this.term.write(yellow("  » ") + cmd + "\r\n");
      this.term.write(dim("  Enter") + " run  " + dim("E") + " edit  " + dim("Esc") + " cancel\r\n");

      this.mode = "nl-confirm";
      this.nlState = { original: query, command: cmd };
    } catch (e) {
      this.term.write(clearLine);
      this.term.write(`\x1b[31m  [ai] ${e}\x1b[0m\r\n`);
      this.inputBuffer = "";
    }
  }

  private handleNlConfirm(data: string): void {
    if (!this.nlState) { this.mode = "normal"; return; }

    if (data === ENTER) {
      // Execute
      const cmd = this.nlState.command;
      this.mode = "normal";
      this.nlState = null;
      this.inputBuffer = "";
      this.send(cmd + "\r");
      return;
    }

    if (data === ESC) {
      // Cancel
      this.mode = "normal";
      this.nlState = null;
      this.inputBuffer = "";
      this.term.write(dim("  cancelled\r\n"));
      return;
    }

    if (data === "e" || data === "E") {
      // Edit: put the command into the input buffer so user can modify it
      const cmd = this.nlState.command;
      this.mode = "normal";
      this.nlState = null;
      this.inputBuffer = cmd;
      // Write the command to the terminal input line (shell will echo it back
      // when we send individual chars; instead we use PTY write in one shot)
      this.send(cmd);
      return;
    }
  }
}

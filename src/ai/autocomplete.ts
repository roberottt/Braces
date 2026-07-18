/**
 * Predictive inline command suggestions.
 *
 * Debounces input, asks the active AI provider for the most likely full command
 * given what the user is doing (cwd, git branch, recent commands) and hands the
 * result back as ghost text. Falls back to nothing on error — the caller then
 * uses plain history prefix matching.
 */

import { invoke } from "@tauri-apps/api/core";
import { store } from "../store/terminalStore";

/**
 * The provider params every AI command takes. Read from the UI store rather
 * than the TOML config: most users never create a config file, so the backend's
 * configured primary is still the "ollama" default while the UI says otherwise.
 */
const providerParams = () => {
  const providerName = store.provider;
  return {
    providerName,
    model: store.model,
    host: localStorage.getItem(`braces_host_${providerName}`) ?? undefined,
  };
};

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
/** Bumped on every request so late replies from stale input are discarded. */
let requestSeq = 0;

// AI round-trips are far more expensive than the old history lookup, so wait
// until typing actually pauses before spending one.
const DEBOUNCE_MS = 350;
const MIN_INPUT_LEN = 3;
// Grace period after a command finishes before predicting the next one, so the
// suggestion does not flash up while the user is still reading the output.
const IDLE_MS = 800;

export type SuggestionContext = {
  cwd: string;
  /** Most recent commands first. */
  recent: string[];
  gitBranch?: string;
};

/** The full suggested command, or null when there is nothing to suggest. */
export type SuggestionCallback = (command: string | null) => void;

export function requestAutocomplete(
  currentInput: string,
  ctx: SuggestionContext,
  onResult: SuggestionCallback
): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  const seq = ++requestSeq;

  if (currentInput.trim().length < MIN_INPUT_LEN) {
    onResult(null);
    return;
  }

  debounceTimer = setTimeout(async () => {
    try {
      const suggestion = await invoke<string>("ai_autocomplete", {
        input: currentInput,
        cwd: ctx.cwd,
        recent: ctx.recent.slice(0, 10),
        gitBranch: ctx.gitBranch ?? null,
        ...providerParams(),
      });
      if (seq !== requestSeq) return; // superseded by newer input
      onResult(suggestion && suggestion !== currentInput ? suggestion : null);
    } catch (e) {
      // Surfaced, not swallowed: a misconfigured provider is otherwise
      // indistinguishable from "the model had nothing to suggest".
      console.warn("[braces] ai_autocomplete failed:", e);
      if (seq === requestSeq) onResult(null);
    }
  }, DEBOUNCE_MS);
}

/**
 * Ask for the command the user is most likely to run next, for use when the
 * prompt is empty. Waits longer than the typing debounce: the suggestion appears
 * a beat after the previous command finishes, rather than racing its output.
 */
export function requestNextCommand(
  ctx: SuggestionContext & { lastExitCode?: number | null; tabId: string },
  onResult: SuggestionCallback
): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  const seq = ++requestSeq;

  if (ctx.recent.length === 0) {
    onResult(null);
    return;
  }

  debounceTimer = setTimeout(async () => {
    try {
      const suggestion = await invoke<string>("ai_suggest_next", {
        cwd: ctx.cwd,
        recent: ctx.recent.slice(0, 10),
        gitBranch: ctx.gitBranch ?? null,
        lastExitCode: ctx.lastExitCode ?? null,
        activeTabId: ctx.tabId,
        ...providerParams(),
      });
      if (seq !== requestSeq) return; // user started typing, or another ran
      onResult(suggestion || null);
    } catch (e) {
      console.warn("[braces] ai_suggest_next failed:", e);
      if (seq === requestSeq) onResult(null);
    }
  }, IDLE_MS);
}

export function cancelAutocomplete(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = null;
  requestSeq++; // invalidate any in-flight reply
}

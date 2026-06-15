/**
 * Predictive inline autocomplete.
 * Debounces input, fires an AI completion request, returns ghost text.
 * Tab accepts; any other key dismisses.
 */

import { invoke } from "@tauri-apps/api/core";

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let currentController: AbortController | null = null;

const DEBOUNCE_MS = 120;

export type GhostText = {
  prefix: string;   // the current input that triggered it
  suggestion: string; // the additional text to show as ghost
};

export type AutocompleteCallback = (ghost: GhostText | null) => void;

export function requestAutocomplete(
  currentInput: string,
  cwd: string,
  onResult: AutocompleteCallback
): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  currentController?.abort();

  if (currentInput.trim().length < 2) {
    onResult(null);
    return;
  }

  debounceTimer = setTimeout(async () => {
    currentController = new AbortController();
    try {
      const suggestion = await invoke<string>("ai_autocomplete", {
        input: currentInput,
        cwd,
      });
      if (suggestion && suggestion !== currentInput) {
        // suggestion is the FULL command — extract the suffix
        const suffix = suggestion.startsWith(currentInput)
          ? suggestion.slice(currentInput.length)
          : suggestion;
        onResult({ prefix: currentInput, suggestion: suffix });
      } else {
        onResult(null);
      }
    } catch {
      onResult(null);
    }
  }, DEBOUNCE_MS);
}

export function cancelAutocomplete(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  currentController?.abort();
  currentController = null;
}

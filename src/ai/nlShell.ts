/**
 * NL→Shell: intercepts "? <query>" input and routes it through the AI provider.
 * Returns the suggested shell command, or null if not an NL query.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type NlResult = {
  command: string;
  explanation?: string;
};

export async function nlToShell(query: string): Promise<NlResult> {
  // Stream tokens via event channel; collect until done
  return new Promise((resolve, reject) => {
    let collected = "";
    let unlisten: (() => void) | null = null;

    listen<string>("ai-nl-token", (ev) => {
      collected += ev.payload;
    }).then((fn) => {
      unlisten = fn;
    });

    invoke<{ command: string; explanation?: string }>("ai_nl_to_shell", { query })
      .then((result) => {
        unlisten?.();
        resolve(result);
      })
      .catch((e) => {
        unlisten?.();
        // If backend AI not available, return collected streamed text as command
        if (collected.trim()) {
          resolve({ command: collected.trim() });
        } else {
          reject(e);
        }
      });
  });
}

/** Returns true if the input line starts with the NL prefix "? " */
export function isNlQuery(line: string): boolean {
  return line.startsWith("? ") && line.length > 2;
}

export function stripNlPrefix(line: string): string {
  return line.slice(2).trim();
}

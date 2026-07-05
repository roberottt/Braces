import type { EditorView } from "@codemirror/view";

// Module-level (outside the reactive Solid store) so unsaved buffers and live
// CodeMirror instances survive toggling away from the editor view (Ctrl+E) —
// only the DOM node is torn down/rebuilt when EditorView.tsx unmounts, not the
// underlying EditorState, so undo history and unsaved edits are never lost.

/** tab.id -> live CodeMirror EditorView instance. */
export const editorViews = new Map<string, EditorView>();

/** tab.id -> last-saved-to-disk file contents (used to seed/verify dirty state). */
export const savedContent = new Map<string, string>();

export function disposeEditorTab(tabId: string) {
  const view = editorViews.get(tabId);
  if (view) view.destroy();
  editorViews.delete(tabId);
  savedContent.delete(tabId);
}

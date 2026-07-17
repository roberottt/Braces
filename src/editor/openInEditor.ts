import { EditorView } from "@codemirror/view";
import { store, setStore, genEditorTabId } from "../store/terminalStore";
import { editorViews } from "./bufferCache";

/**
 * Line/column jumps queued for editor tabs whose CodeMirror view doesn't exist
 * (or isn't attached) yet. EditorPane consumes an entry when it mounts the
 * tab's view.
 */
export const pendingGoto = new Map<string, { line: number; col: number }>();

/** Move the cursor to line/col (1-based, clamped) and scroll it into view. */
export function gotoLine(view: EditorView, line: number, col: number) {
  const l = Math.min(Math.max(1, line), view.state.doc.lines);
  const info = view.state.doc.line(l);
  const pos = Math.min(info.from + Math.max(0, col - 1), info.to);
  view.dispatch({
    selection: { anchor: pos },
    effects: EditorView.scrollIntoView(pos, { y: "center" }),
  });
  view.focus();
}

/**
 * Open `path` (absolute, or relative to the active tab's cwd — see
 * fs_read_file) in the editor view, creating or focusing its tab, optionally
 * jumping to a 1-based line/column.
 */
export function openFileInEditor(path: string, line?: number, col?: number) {
  const existing = store.editorTabs.find((et) => et.relPath === path);
  let id: string;
  if (existing) {
    id = existing.id;
  } else {
    id = genEditorTabId();
    const title = path.replace(/\\/g, "/").split("/").pop() ?? path;
    setStore("editorTabs", (tabs) => [...tabs, { id, relPath: path, title, dirty: false }]);
  }
  setStore("activeEditorTabId", id);

  if (line) {
    const view = editorViews.get(id);
    if (view && store.currentView === "editor") {
      // Pane already mounted — its onMount won't re-run, so jump directly.
      requestAnimationFrame(() => gotoLine(view, line, col ?? 1));
    } else {
      pendingGoto.set(id, { line, col: col ?? 1 });
    }
  }
  setStore("currentView", "editor");
}

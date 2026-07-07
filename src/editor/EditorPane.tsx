import { Component, onCleanup, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { store, setStore, type EditorTab } from "../store/terminalStore";
import { editorViews, savedContent } from "./bufferCache";
import { editorTheme, editorHighlighting } from "./theme";
import { languageExtensionFor } from "./languages";
import { applyGutterMarks, gitGutterExtension, type FileDiff } from "./gitGutter";

type Props = {
  tab: EditorTab;
};

const EditorPane: Component<Props> = (props) => {
  let containerRef: HTMLDivElement | undefined;

  // Persist the buffer after a gutter-peek revert so the disk-based diff
  // backing the gutter marks reflects the undone change right away.
  const saveAfterRevert = async (view: EditorView) => {
    const contents = view.state.doc.toString();
    try {
      await invoke("fs_write_file", { cwd: store.cwd, path: props.tab.relPath, contents });
      savedContent.set(props.tab.id, contents);
      setStore("editorTabs", (et) => et.id === props.tab.id, "dirty", false);
      window.dispatchEvent(new CustomEvent("braces:git-refresh"));
    } catch (e) {
      console.error("[braces] fs_write_file failed:", e);
    }
  };

  const refreshGutter = async (view: EditorView) => {
    const cwd = store.cwd;
    if (!cwd || cwd === "~") return;
    try {
      const diff = await invoke<FileDiff>("git_diff_file", { cwd, path: props.tab.relPath, staged: false });
      applyGutterMarks(view, diff);
    } catch {
      applyGutterMarks(view, null);
    }
  };

  // If the file changed on disk from outside the editor (git discard/checkout,
  // pull, another program) reload it into the buffer — but only when there
  // are no unsaved edits in flight, so we never clobber the user's own work.
  const reloadIfExternallyChanged = async (view: EditorView) => {
    const tab = store.editorTabs.find((et) => et.id === props.tab.id);
    if (tab?.dirty) return;
    const cwd = store.cwd;
    if (!cwd || cwd === "~") return;
    try {
      const onDisk = await invoke<string>("fs_read_file", { cwd, path: props.tab.relPath });
      const current = view.state.doc.toString();
      if (onDisk !== current) {
        savedContent.set(props.tab.id, onDisk);
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: onDisk } });
      }
    } catch {
      // File may have been deleted externally — leave the buffer as-is.
    }
  };

  onMount(() => {
    const gitRefreshHandler = () => {
      const view = editorViews.get(props.tab.id);
      if (!view) return;
      refreshGutter(view);
      reloadIfExternallyChanged(view);
    };
    window.addEventListener("braces:git-refresh", gitRefreshHandler);
    onCleanup(() => window.removeEventListener("braces:git-refresh", gitRefreshHandler));

    const existing = editorViews.get(props.tab.id);
    if (existing) {
      containerRef!.appendChild(existing.dom);
      refreshGutter(existing);
      // The editor view (and this pane) may have been fully unmounted while
      // detached — e.g. the user left to the terminal to discard changes in
      // the Git panel, which isn't mounted while the editor view is active.
      // Re-check disk content now that we're reconnecting.
      reloadIfExternallyChanged(existing);
      return;
    }

    (async () => {
      const cwd = store.cwd;
      let content = "";
      try {
        content = await invoke<string>("fs_read_file", { cwd, path: props.tab.relPath });
      } catch (e) {
        console.error("[braces] fs_read_file failed:", e);
      }
      savedContent.set(props.tab.id, content);

      const langExt = await languageExtensionFor(props.tab.relPath);

      // Bail if the pane got torn down (tab closed) while the file/language load was in flight.
      if (!containerRef) return;

      const view = new EditorView({
        state: EditorState.create({
          doc: content,
          extensions: [
            lineNumbers(),
            history(),
            keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
            EditorView.lineWrapping,
            editorTheme,
            editorHighlighting,
            gitGutterExtension({ save: saveAfterRevert }),
            ...langExt,
            EditorView.updateListener.of((update) => {
              if (!update.docChanged) return;
              const isDirty = update.state.doc.toString() !== savedContent.get(props.tab.id);
              setStore("editorTabs", (t) => t.id === props.tab.id, "dirty", isDirty);
            }),
          ],
        }),
        parent: containerRef,
      });
      editorViews.set(props.tab.id, view);
      refreshGutter(view);
    })();
  });

  return <div class="editor-cm-mount" ref={containerRef} />;
};

export default EditorPane;

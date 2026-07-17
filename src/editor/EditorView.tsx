import { Component, For, Show, onCleanup, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { store, setStore } from "../store/terminalStore";
import { t } from "../i18n";
import FileTree from "../hud/FileTree";
import EditorTabBar from "./EditorTabBar";
import EditorPane from "./EditorPane";
import { editorViews, savedContent } from "./bufferCache";
import { openFileInEditor } from "./openInEditor";

const EditorView: Component = () => {
  const activeRelPath = () =>
    store.editorTabs.find((et) => et.id === store.activeEditorTabId)?.relPath ?? null;

  const openInEditor = (relPath: string, _name: string) => openFileInEditor(relPath);

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === "s" && !e.repeat) {
        e.preventDefault();
        const tab = store.editorTabs.find((et) => et.id === store.activeEditorTabId);
        if (!tab) return;
        const view = editorViews.get(tab.id);
        if (!view) return;
        const contents = view.state.doc.toString();
        invoke("fs_write_file", { cwd: store.cwd, path: tab.relPath, contents })
          .then(() => {
            savedContent.set(tab.id, contents);
            setStore("editorTabs", (et) => et.id === tab.id, "dirty", false);
            window.dispatchEvent(new CustomEvent("braces:git-refresh"));
          })
          .catch((err) => console.error("[braces] fs_write_file failed:", err));
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  return (
    <div class="editor-view">
      <div class="editor-sidebar">
        <div class="tab-sidebar-header">
          <div class="ws-dock-toggle">
            <button class="ws-dock-btn active">{t(store.language, "files_label")}</button>
          </div>
        </div>
        <FileTree onFileClick={openInEditor} selectedPath={activeRelPath()} />
      </div>
      <div class="editor-main">
        <EditorTabBar />
        <div class="editor-panes">
          <Show
            when={store.editorTabs.length > 0}
            fallback={<div class="editor-empty">{t(store.language, "no_file_open")}</div>}
          >
            <For each={store.editorTabs}>
              {(tab) => (
                <div class="editor-pane-wrap" classList={{ hidden: tab.id !== store.activeEditorTabId }}>
                  <EditorPane tab={tab} />
                </div>
              )}
            </For>
          </Show>
        </div>
      </div>
    </div>
  );
};

export default EditorView;

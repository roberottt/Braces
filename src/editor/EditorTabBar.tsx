import { Component, For, Show, createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { store, setStore, type EditorTab } from "../store/terminalStore";
import { disposeEditorTab, editorViews, savedContent } from "./bufferCache";
import { t } from "../i18n";

const EditorTabBar: Component = () => {
  const [pendingClose, setPendingClose] = createSignal<EditorTab | null>(null);

  const activateTab = (id: string) => setStore("activeEditorTabId", id);

  const removeTab = (id: string) => {
    disposeEditorTab(id);
    const remaining = store.editorTabs.filter((et) => et.id !== id);
    setStore("editorTabs", remaining);
    if (store.activeEditorTabId === id) {
      const next = remaining[remaining.length - 1];
      setStore("activeEditorTabId", next ? next.id : null);
    }
  };

  const saveTab = async (tab: EditorTab) => {
    const view = editorViews.get(tab.id);
    if (!view) return;
    const contents = view.state.doc.toString();
    await invoke("fs_write_file", { cwd: store.cwd, path: tab.relPath, contents });
    savedContent.set(tab.id, contents);
    setStore("editorTabs", (et) => et.id === tab.id, "dirty", false);
    window.dispatchEvent(new CustomEvent("braces:git-refresh"));
  };

  const requestClose = (tab: EditorTab, e: MouseEvent) => {
    e.stopPropagation();
    if (!tab.dirty) { removeTab(tab.id); return; }
    setPendingClose(tab);
  };

  const confirmSaveAndClose = async () => {
    const tab = pendingClose();
    if (!tab) return;
    try {
      await saveTab(tab);
    } catch (e) {
      console.error("[braces] fs_write_file failed:", e);
      return;
    }
    removeTab(tab.id);
    setPendingClose(null);
  };

  const confirmDiscardAndClose = () => {
    const tab = pendingClose();
    if (!tab) return;
    removeTab(tab.id);
    setPendingClose(null);
  };

  return (
    <>
      <div class="editor-tabbar">
        <For each={store.editorTabs}>
          {(tab) => (
            <div
              class="editor-tab"
              classList={{ active: tab.id === store.activeEditorTabId }}
              onClick={() => activateTab(tab.id)}
              title={tab.relPath}
            >
              <span class="editor-tab-dot" classList={{ visible: tab.dirty }} />
              <span class="editor-tab-title">{tab.title}</span>
              <span
                class="editor-tab-close"
                title={t(store.language, "editor_close_tab")}
                onClick={(e) => requestClose(tab, e)}
              >
                ×
              </span>
            </div>
          )}
        </For>
      </div>
      <Show when={pendingClose()}>
        <div class="editor-confirm">
          <span class="editor-confirm-msg">
            {t(store.language, "editor_unsaved_pre")}{pendingClose()!.title}{t(store.language, "editor_unsaved_post")}
          </span>
          <button class="git-confirm-btn" onClick={confirmSaveAndClose}>{t(store.language, "editor_close_save")}</button>
          <button class="git-confirm-btn danger" onClick={confirmDiscardAndClose}>{t(store.language, "editor_close_discard")}</button>
          <button class="git-confirm-btn" onClick={() => setPendingClose(null)}>{t(store.language, "discard_no")}</button>
        </div>
      </Show>
    </>
  );
};

export default EditorTabBar;

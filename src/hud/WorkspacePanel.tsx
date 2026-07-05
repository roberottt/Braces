import { Component } from "solid-js";
import { store, setStore, genEditorTabId } from "../store/terminalStore";
import { t } from "../i18n";
import FileTree from "./FileTree";

// ── panel ────────────────────────────────────────────────────────────────────

const WorkspacePanel: Component = () => {
  const refresh = () => window.dispatchEvent(new CustomEvent("braces:git-refresh"));

  const openInEditor = (relPath: string, name: string) => {
    const existing = store.editorTabs.find(t => t.relPath === relPath);
    if (existing) {
      setStore("activeEditorTabId", existing.id);
    } else {
      const id = genEditorTabId();
      setStore("editorTabs", tabs => [...tabs, { id, relPath, title: name, dirty: false }]);
      setStore("activeEditorTabId", id);
    }
    setStore("currentView", "editor");
  };

  const close = () => {
    setStore("tabsSidebarOpen", false);
    setStore("workspaceOpen",   false);
  };

  const switchToSessions = () => setStore("leftDockView", "sessions");

  return (
    <div class="tab-sidebar">
      {/* Header */}
      <div class="tab-sidebar-header">
        <div class="ws-dock-toggle">
          <button class="ws-dock-btn" onClick={switchToSessions}>{t(store.language, "sessions")}</button>
          <button class="ws-dock-btn active">{t(store.language, "files_label")}</button>
        </div>
        <div class="tab-sidebar-actions">
          <button class="tab-sidebar-btn" title={t(store.language, "refresh")} onClick={refresh}>↻</button>
          <button class="tab-sidebar-btn" title={t(store.language, "hide_panel")} onClick={close}>‹</button>
        </div>
      </div>

      <FileTree
        onFileClick={openInEditor}
        selectedPath={store.activeEditorTabId ? store.editorTabs.find(t => t.id === store.activeEditorTabId)?.relPath ?? null : null}
      />
    </div>
  );
};

export default WorkspacePanel;

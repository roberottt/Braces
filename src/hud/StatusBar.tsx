import { Component, Show, createSignal, onCleanup, onMount } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { store, setStore } from "../store/terminalStore";
import { t } from "../i18n";

const StatusBar: Component = () => {
  const [maximized, setMaximized] = createSignal(false);
  const appWindow = getCurrentWindow();

  onMount(() => {
    appWindow.isMaximized().then(setMaximized).catch(() => {});
    appWindow
      .onResized(() => appWindow.isMaximized().then(setMaximized).catch(() => {}))
      .then((un) => onCleanup(un))
      .catch(() => {});
  });

  return (
    <div class="status-bar" data-tauri-drag-region>
      {/* CWD */}
      <span class="sb-item">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M1 2h4l1 1h3v6H1V2z" stroke="currentColor" stroke-width="0.8" fill="none"/>
        </svg>
        {store.cwd}
      </span>

      {/* Git branch indicator */}
      <Show when={store.gitIsRepo}>
        <span
          class="sb-item sb-branch"
          style={{
            cursor: "pointer",
            color: store.gitBranch && store.gitAhead + store.gitBehind > 0
              ? "var(--accent-amber)"
              : store.gitPanelOpen ? "var(--accent)" : undefined,
          }}
          onClick={() => setStore("gitPanelOpen", (v) => !v)}
          title={t(store.language, "source_control_tip")}
        >
          ⎇ {store.gitBranch}
          <Show when={store.gitAhead > 0}>
            {" "}↑{store.gitAhead}
          </Show>
          <Show when={store.gitBehind > 0}>
            {" "}↓{store.gitBehind}
          </Show>
        </span>
      </Show>

      {/* Draggable empty area — double-click maximizes (native behaviour) */}
      <span class="sb-spacer" data-tauri-drag-region />

      {/* Controls */}
      <span
        class="sb-item sb-icon"
        style={{ cursor: "pointer", color: store.currentView === "editor" ? "var(--accent)" : undefined }}
        onClick={() => setStore("currentView", (v) => (v === "editor" ? "terminal" : "editor"))}
        title={t(store.language, "editor_view_tip")}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M4 3L1.5 6L4 9" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M8 3l2.5 3L8 9" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M6.8 2.2L5.2 9.8" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" />
        </svg>
      </span>
      <span
        class="sb-item sb-icon"
        style={{ cursor: "pointer", color: store.gitPanelOpen ? "var(--accent)" : undefined }}
        onClick={() => setStore("gitPanelOpen", (v) => !v)}
        title={t(store.language, "source_control_tip")}
      >
        ⎇
      </span>
      <span
        class="sb-item sb-icon"
        style={{ cursor: "pointer", color: store.codeReviewOpen ? "var(--accent)" : undefined }}
        onClick={() => setStore("codeReviewOpen", (v) => !v)}
        title={t(store.language, "code_review_tip")}
      >
        ✓
      </span>
      <span
        class="sb-item sb-icon"
        style={{ cursor: "pointer", color: store.sidePanelOpen ? "var(--accent)" : undefined }}
        onClick={() => setStore("sidePanelOpen", (v) => !v)}
        title={t(store.language, "ai_panel_tip")}
      >
        R2
      </span>
      <span
        class="sb-item sb-icon"
        style={{ cursor: "pointer", color: store.metricsOpen ? "var(--accent)" : undefined }}
        onClick={() => setStore("metricsOpen", (v) => !v)}
        title={t(store.language, "resource_monitor_tip")}
      >
        ⬡
      </span>
      {/* Settings */}
      <span
        class="sb-item sb-icon sb-settings"
        classList={{ open: store.settingsOpen }}
        style={{ cursor: "pointer" }}
        onClick={() => setStore("settingsOpen", v => !v)}
        title={t(store.language, "settings_tip")}
      >
        ⚙
      </span>

      {/* Window controls (Warp-style, integrated in the bar) */}
      <div class="win-controls">
        <button
          class="win-btn"
          title={t(store.language, "minimize")}
          onClick={() => appWindow.minimize()}
        >
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 5h8" stroke="currentColor" stroke-width="1" /></svg>
        </button>
        <button
          class="win-btn"
          title={maximized() ? t(store.language, "restore_window") : t(store.language, "maximize")}
          onClick={() => appWindow.toggleMaximize()}
        >
          {maximized() ? (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <rect x="1.5" y="2.5" width="5" height="5" stroke="currentColor" stroke-width="1" />
              <path d="M3.5 2.5V1.5h5v5h-1" stroke="currentColor" stroke-width="1" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <rect x="1.5" y="1.5" width="7" height="7" stroke="currentColor" stroke-width="1" />
            </svg>
          )}
        </button>
        <button
          class="win-btn win-close"
          title={t(store.language, "close")}
          onClick={() => appWindow.close()}
        >
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" stroke-width="1" /></svg>
        </button>
      </div>
    </div>
  );
};

export default StatusBar;

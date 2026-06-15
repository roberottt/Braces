import { Component, Show } from "solid-js";
import { store, setStore } from "../store/terminalStore";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n";

const ErrorPanel: Component = () => {
  const triggerAnalysis = async () => {
    setStore("errorAnalysis", t(store.language, "analyzing"));
    try {
      await invoke("ai_analyze_error", { activeTabId: store.activeTabId });
    } catch {
      setStore("errorAnalysis", t(store.language, "analysis_failed"));
    }
  };

  return (
    <Show when={store.errorPanelOpen}>
      <div class="error-panel">
        <div class="ep-header">
          <span>▲ ERROR — exit {store.lastExitCode}</span>
          <span style={{ flex: 1 }} />
          <Show when={!store.errorAnalysis}>
            <span style={{ cursor: "pointer", color: "var(--accent-amber)" }} onClick={triggerAnalysis}>
              {t(store.language, "analyze")}
            </span>
          </Show>
          <span
            style={{ cursor: "pointer", "margin-left": "12px", opacity: 0.6 }}
            onClick={() => setStore("errorPanelOpen", false)}
          >
            ×
          </span>
        </div>

        <Show when={store.errorAnalysis}>
          <div class="ep-cause">{store.errorAnalysis}</div>
          <Show when={store.errorFix}>
            <div class="ep-fix">$ {store.errorFix}</div>
            <div class="ep-hint">{t(store.language, "apply_fix_hint")}</div>
          </Show>
        </Show>
      </div>
    </Show>
  );
};

export default ErrorPanel;

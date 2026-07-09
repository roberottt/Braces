import { Component, onCleanup } from "solid-js";
import { store, setStore, type ToolPanelId } from "../store/terminalStore";
import { t } from "../i18n";

/**
 * Maximize / restore button shared by the tool panels (AI, Git, Code Review).
 * Maximized state is cleared when the panel unmounts (i.e. is closed) so a
 * reopened panel always starts docked.
 */
const PanelSizeControls: Component<{ panel: ToolPanelId }> = (props) => {
  const isMax = () => store.panelMaximized === props.panel;

  onCleanup(() => {
    setStore("panelMaximized", (m) => (m === props.panel ? null : m));
  });

  return (
    <button
      class="sp-header-btn"
      classList={{ active: isMax() }}
      title={t(store.language, isMax() ? "panel_restore" : "panel_maximize")}
      onClick={() => setStore("panelMaximized", (m) => (m === props.panel ? null : props.panel))}
    >
      {isMax() ? (
        <svg class="sp-header-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="4 14 10 14 10 20" />
          <polyline points="20 10 14 10 14 4" />
        </svg>
      ) : (
        <svg class="sp-header-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="15 3 21 3 21 9" />
          <polyline points="9 21 3 21 3 15" />
        </svg>
      )}
    </button>
  );
};

export default PanelSizeControls;

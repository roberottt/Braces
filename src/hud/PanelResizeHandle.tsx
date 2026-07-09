import { Component, Show, createSignal } from "solid-js";
import { store, setStore, type ToolPanelId } from "../store/terminalStore";
import { t } from "../i18n";

const MIN_WIDTH = 280;
/** Leave at least this much room for the terminal area while dragging. */
const RESERVED_LEFT = 220;

/**
 * Invisible strip on the left edge of a tool panel; dragging it resizes the
 * panel (double-click restores the default width). Hidden while maximized.
 */
const PanelResizeHandle: Component<{ panel: ToolPanelId }> = (props) => {
  const [dragging, setDragging] = createSignal(false);

  const onPointerDown = (e: PointerEvent) => {
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    const panelEl = handle.parentElement!;
    // The panel's right edge stays fixed while its left edge follows the pointer.
    const right = panelEl.getBoundingClientRect().right;
    handle.setPointerCapture(e.pointerId);
    setDragging(true);

    const onMove = (ev: PointerEvent) => {
      const max = window.innerWidth - RESERVED_LEFT;
      const w = Math.round(Math.min(Math.max(right - ev.clientX, MIN_WIDTH), max));
      setStore("panelWidth", props.panel, w);
    };
    const onUp = (ev: PointerEvent) => {
      handle.releasePointerCapture(ev.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      setDragging(false);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  };

  return (
    <Show when={store.panelMaximized !== props.panel}>
      <div
        class="panel-resize-handle"
        classList={{ dragging: dragging() }}
        title={t(store.language, "panel_resize_tip")}
        onPointerDown={onPointerDown}
        onDblClick={() => setStore("panelWidth", props.panel, null)}
      />
    </Show>
  );
};

export default PanelResizeHandle;

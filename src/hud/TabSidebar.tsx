import { Component, For, Show, createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { store, setStore, genTabId, type Tab } from "../store/terminalStore";
import { t } from "../i18n";


function shortCwd(cwd: string): string {
  const parts = (cwd || "~").replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length === 0) return "~";
  return parts.length > 2 ? "…/" + parts.slice(-2).join("/") : cwd;
}

const TabSidebar: Component = () => {
  const [search, setSearch] = createSignal("");
  const [draggingId,      setDraggingId]      = createSignal<string | null>(null);
  const [draggingFromIdx, setDraggingFromIdx] = createSignal(-1);
  const [dropIdx,         setDropIdx]         = createSignal(-1);
  const [dragY,           setDragY]           = createSignal(0);
  const [dragOffsetY,     setDragOffsetY]     = createSignal(0);
  const [itemH,           setItemH]           = createSignal(44);

  let listRef: HTMLDivElement | undefined;
  // Captured at drag-start — never changes during a drag
  let listLeft  = 0;
  let listWidth = 0;
  let origRects: { id: string; top: number }[] = [];
  // Press candidate: drag only begins after the pointer moves past a threshold,
  // so a plain click never triggers the ghost/float visuals.
  const DRAG_THRESHOLD = 5;
  let pressedId: string | null = null;
  let pressedY  = 0;
  let pressedOffsetY = 0;
  let pressedItemH   = 44;

  // ── helpers ─────────────────────────────────────────────────────────────
  const newTab = () => {
    const id = genTabId();
    setStore("tabs", p => [...p, { id, title: t(store.language, "new_session"), cwd: store.cwd || "~", lastExitCode: null }]);
    setStore("activeTabId", id);
  };

  const closeTab = (id: string, e: MouseEvent) => {
    e.stopPropagation();
    if (store.tabs.length === 1) return;
    const idx       = store.tabs.findIndex(t => t.id === id);
    const remaining = store.tabs.filter(t => t.id !== id);
    if (store.activeTabId === id) {
      const next = remaining[Math.min(idx, remaining.length - 1)];
      if (next) { setStore("activeTabId", next.id); setStore("cwd", next.cwd); setStore("lastExitCode", next.lastExitCode); }
    }
    setStore("tabs", remaining);
    // Remove the tab and its blocks from persistent storage
    invoke("db_delete_tab", { tabId: id }).catch((err) =>
      console.error("[braces] db_delete_tab failed:", err)
    );
  };

  const activateTab = (tab: Tab) => {
    setStore("activeTabId", tab.id);
    setStore("cwd", tab.cwd);
    setStore("lastExitCode", tab.lastExitCode);
  };

  const filteredTabs = () => {
    const q = search().toLowerCase();
    if (!q) return store.tabs;
    return store.tabs.filter(t => t.title.toLowerCase().includes(q) || t.cwd.toLowerCase().includes(q));
  };

  // ── drop position ────────────────────────────────────────────────────────
  // Calculated from ORIGINAL positions captured at drag start so it stays
  // stable while transforms animate other items.
  const calcDrop = (clientY: number): number => {
    const fromId = draggingId();
    const nonDragged = origRects.filter(r => r.id !== fromId);
    for (const r of nonDragged) {
      if (clientY < r.top + itemH() / 2) {
        return store.tabs.findIndex(t => t.id === r.id);
      }
    }
    return store.tabs.length;
  };

  // ── per-item CSS transform ───────────────────────────────────────────────
  const itemTranslate = (realIdx: number): string => {
    if (draggingId() === null) return "translateY(0)";
    const from = draggingFromIdx();
    const to   = dropIdx();
    const h    = itemH();
    if (realIdx === from) return "translateY(0)"; // ghost stays put
    if (from < to  && realIdx > from && realIdx < to)  return `translateY(-${h}px)`;
    if (from > to  && realIdx >= to  && realIdx < from) return `translateY(${h}px)`;
    return "translateY(0)";
  };

  // ── pointer handlers ─────────────────────────────────────────────────────
  const onPointerDown = (e: PointerEvent) => {
    if (search()) return;
    const item = (e.target as HTMLElement).closest<HTMLElement>("[data-tab-id]");
    if (!item) return;
    if ((e.target as HTMLElement).closest(".tab-item-close, .tab-search-input")) return;
    e.preventDefault();
    listRef!.setPointerCapture(e.pointerId);

    // Just remember the press — drag visuals start in onPointerMove past the threshold.
    const itemRect  = item.getBoundingClientRect();
    pressedId       = item.dataset.tabId!;
    pressedY        = e.clientY;
    pressedOffsetY  = e.clientY - itemRect.top;
    pressedItemH    = itemRect.height;
  };

  const beginDrag = () => {
    if (!pressedId) return;
    const lr   = listRef!.getBoundingClientRect();
    listLeft   = lr.left;
    listWidth  = lr.width;

    // Snapshot original tops for stable hit-testing during animation
    origRects = Array.from(listRef!.querySelectorAll<HTMLElement>("[data-tab-id]")).map(el => ({
      id:  el.dataset.tabId!,
      top: el.getBoundingClientRect().top,
    }));

    const fromIdx = store.tabs.findIndex(t => t.id === pressedId);
    setItemH(pressedItemH);
    setDraggingId(pressedId);
    setDraggingFromIdx(fromIdx);
    setDragOffsetY(pressedOffsetY);
    setDragY(pressedY);
    setDropIdx(fromIdx); // no displacement at start
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!draggingId()) {
      if (pressedId && Math.abs(e.clientY - pressedY) > DRAG_THRESHOLD) beginDrag();
      else return;
    }
    setDragY(e.clientY);
    setDropIdx(calcDrop(e.clientY));
  };

  const onPointerUp = () => {
    const fromId = draggingId();

    // Plain click (never crossed the drag threshold) → just activate.
    if (!fromId) {
      const tab = store.tabs.find(t => t.id === pressedId);
      if (tab) activateTab(tab);
      cleanup();
      return;
    }

    const to      = dropIdx();
    const tabs    = [...store.tabs];
    const fromIdx = tabs.findIndex(t => t.id === fromId);
    if (fromIdx === -1 || to < 0) { cleanup(); return; }

    // No-op: inserting back in the same place
    if (to !== fromIdx && to !== fromIdx + 1) {
      const [moved]   = tabs.splice(fromIdx, 1);
      const insertIdx = Math.max(0, Math.min(to > fromIdx ? to - 1 : to, tabs.length));
      tabs.splice(insertIdx, 0, moved);
      setStore("tabs", tabs);
    } else {
      // Dragged but dropped in place — treat as click to activate
      const tab = tabs[fromIdx];
      if (tab) activateTab(tab);
    }
    cleanup();
  };

  const cleanup = () => {
    pressedId = null;
    setDraggingId(null);
    setDraggingFromIdx(-1);
    setDropIdx(-1);
    setDragY(0);
  };

  // ── render ───────────────────────────────────────────────────────────────
  const draggingTab = () => store.tabs.find(t => t.id === draggingId());

  return (
    <div class="tab-sidebar">
      {/* Header */}
      <div class="tab-sidebar-header">
        <div class="ws-dock-toggle">
          <button class="ws-dock-btn active">{t(store.language, "sessions")}</button>
          <button class="ws-dock-btn"
            title={t(store.language, "file_explorer_tip")}
            onClick={() => { setStore("leftDockView", "files"); setStore("workspaceOpen", true); }}
          >{t(store.language, "files_label")}</button>
        </div>
        <div class="tab-sidebar-actions">
          <button class="tab-sidebar-btn" title={t(store.language, "new_session_tip")} onClick={newTab}>+</button>
          <button class="tab-sidebar-btn" title={t(store.language, "hide_panel")} onClick={() => setStore("tabsSidebarOpen", false)}>‹</button>
        </div>
      </div>

      {/* Search */}
      <div class="tab-sidebar-search">
        <input
          class="tab-search-input"
          placeholder={t(store.language, "search_sessions_ph")}
          value={search()}
          onInput={e => setSearch(e.currentTarget.value)}
        />
      </div>

      {/* Tab list */}
      <div
        class="tab-list"
        ref={listRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={cleanup}
        style={{ "touch-action": "none" }}
      >
        <For each={filteredTabs()}>
          {(tab) => {
            const realIdx = () => store.tabs.findIndex(t => t.id === tab.id);
            return (
              <div
                class="tab-item"
                classList={{
                  active:   tab.id === store.activeTabId,
                  dragging: tab.id === draggingId(),
                }}
                data-tab-id={tab.id}
                style={{ transform: itemTranslate(realIdx()) }}
              >
                <span class="tab-item-drag-handle">⠿</span>
                <div class="tab-item-info">
                  <div class="tab-item-title">{tab.title}</div>
                  <div class="tab-item-cwd">{shortCwd(tab.cwd)}</div>
                </div>
                <Show when={store.tabs.length > 1}>
                  <button class="tab-item-close" title={t(store.language, "close")} onClick={e => closeTab(tab.id, e)}>×</button>
                </Show>
              </div>
            );
          }}
        </For>
      </div>

      {/* Floating ghost — follows cursor */}
      <Show when={draggingTab()}>
        {(() => {
          const tab = draggingTab()!;
          return (
            <div
              class="tab-drag-float"
              style={{
                top:   `${dragY() - dragOffsetY()}px`,
                left:  `${listLeft}px`,
                width: `${listWidth}px`,
              }}
            >
              <span class="tab-item-drag-handle" style={{ opacity: "0.7" }}>⠿</span>
              <div class="tab-item-info">
                <div class="tab-item-title">{tab.title}</div>
                <div class="tab-item-cwd">{shortCwd(tab.cwd)}</div>
              </div>
            </div>
          );
        })()}
      </Show>
    </div>
  );
};

export default TabSidebar;

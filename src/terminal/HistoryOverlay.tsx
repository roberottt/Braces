import { Component, createSignal, For, onCleanup, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { store, setStore } from "../store/terminalStore";

const HistoryOverlay: Component = () => {
  const [query, setQuery] = createSignal("");
  const [selected, setSelected] = createSignal(0);
  let inputRef!: HTMLInputElement;

  let debounce: ReturnType<typeof setTimeout>;

  const search = (q: string) => {
    clearTimeout(debounce);
    if (!q.trim()) {
      setStore("historyResults", []);
      return;
    }
    debounce = setTimeout(async () => {
      try {
        const results = await invoke<string[]>("history_search", { query: q, topK: 10 });
        setStore("historyResults", results);
        setSelected(0);
      } catch { /* ignore */ }
    }, 200);
  };

  const accept = (cmd: string) => {
    window.dispatchEvent(new CustomEvent("braces:inject-cmd", { detail: cmd }));
    setStore("historySearchOpen", false);
    setStore("historyResults", []);
  };

  onMount(() => setTimeout(() => inputRef?.focus(), 50));

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      setStore("historySearchOpen", false);
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, store.historyResults.length - 1));
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    }
    if (e.key === "Enter" && store.historyResults[selected()]) {
      accept(store.historyResults[selected()]);
    }
  };

  onCleanup(() => clearTimeout(debounce));

  return (
    <div class="history-overlay">
      <div class="ho-input-row">
        <span class="ho-label">SEMANTIC HISTORY</span>
        <input
          ref={inputRef}
          class="ho-input"
          placeholder="search commands…"
          value={query()}
          onInput={(e) => { setQuery(e.currentTarget.value); search(e.currentTarget.value); }}
          onKeyDown={onKey}
        />
      </div>
      <div class="ho-results">
        <For each={store.historyResults}>
          {(cmd, i) => (
            <div
              class={`ho-item${i() === selected() ? " selected" : ""}`}
              onClick={() => accept(cmd)}
            >
              {cmd}
            </div>
          )}
        </For>
      </div>
    </div>
  );
};

export default HistoryOverlay;

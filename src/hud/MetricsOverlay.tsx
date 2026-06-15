import { Component, createSignal, onCleanup, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { setStore } from "../store/terminalStore";

type Metrics = { cpu_percent: number; ram_used_mb: number; ram_total_mb: number };

const MetricsOverlay: Component = () => {
  const [metrics, setMetrics] = createSignal<Metrics>({ cpu_percent: 0, ram_used_mb: 0, ram_total_mb: 8192 });
  const [query, setQuery] = createSignal("");
  const [queryResult, setQueryResult] = createSignal("");
  let timer: ReturnType<typeof setInterval>;

  onMount(() => {
    const refresh = () => invoke<Metrics>("get_metrics").then(setMetrics).catch(() => {});
    refresh();
    timer = setInterval(refresh, 1500);
  });

  onCleanup(() => clearInterval(timer));

  const askProcesses = async () => {
    const q = query().trim();
    if (!q) return;
    setQueryResult("…");
    try {
      const r = await invoke<string>("ai_query_processes", { query: q });
      setQueryResult(r);
    } catch (e) {
      setQueryResult(String(e));
    }
  };

  const ramPct = () => {
    const m = metrics();
    return m.ram_total_mb > 0 ? (m.ram_used_mb / m.ram_total_mb) * 100 : 0;
  };

  return (
    <div class="metrics-overlay">
      <div class="hud-corners">
        <span class="hc-br" />
        <span class="hc-bl" />
      </div>

      <div class="mo-header">
        <span>SYSTEM</span>
        <span
          style={{ cursor: "pointer", opacity: 0.6 }}
          onClick={() => setStore("metricsOpen", false)}
        >×</span>
      </div>

      <div class="mo-row">
        <span>CPU</span>
        <span>{metrics().cpu_percent.toFixed(1)}%</span>
      </div>
      <div class="mo-bar-bg">
        <div class="mo-bar" style={{ width: `${Math.min(metrics().cpu_percent, 100)}%` }} />
      </div>

      <div class="mo-row">
        <span>RAM</span>
        <span>{metrics().ram_used_mb} / {metrics().ram_total_mb} MB</span>
      </div>
      <div class="mo-bar-bg">
        <div class="mo-bar" style={{ width: `${ramPct().toFixed(1)}%` }} />
      </div>

      {queryResult() && (
        <div style={{ padding: "6px 10px", color: "var(--fg)", "font-size": "11px", "white-space": "pre-wrap" }}>
          {queryResult()}
        </div>
      )}

      <div class="mo-query-row">
        <input
          class="mo-query-input"
          placeholder="what's eating my RAM?"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === "Enter") askProcesses(); }}
        />
      </div>
    </div>
  );
};

export default MetricsOverlay;

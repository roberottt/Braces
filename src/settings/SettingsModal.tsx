import { Component, Show, createSignal, onCleanup, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { store, setStore, type Provider } from "../store/terminalStore";
import { t, type Lang } from "../i18n";

type Tab = "appearance" | "ai" | "keys";

const THEMES = [
  { id: "neon-noir",      label: "Anakin",         accent: "#8aa0ff" },
  { id: "akira",          label: "Mace Windu",     accent: "#9a78d4" },
  { id: "ghost-protocol", label: "Yoda",           accent: "#72aa50" },
  { id: "time-warp",      label: "C-3PO",          accent: "#c08840" },
  { id: "minimal",        label: "Stormtrooper",   accent: "#cccccc" },
] as const;

const PROVIDERS: Provider[] = ["ollama", "anthropic", "openai", "lmstudio", "xai", "gemini"];

const KEY_PROVIDERS = [
  { id: "anthropic", label: "Anthropic",  placeholder: "sk-ant-…" },
  { id: "openai",    label: "OpenAI",     placeholder: "sk-…" },
  { id: "xai",       label: "xAI (Grok)", placeholder: "xai-…" },
  { id: "gemini",    label: "Gemini",     placeholder: "AIza…" },
];

const DEFAULT_MODELS: Partial<Record<Provider, string>> = {
  anthropic: "claude-opus-4-8",
  openai:    "gpt-4o-mini",
  ollama:    "llama3.2",
  lmstudio:  "local-model",
  xai:       "grok-3",
  gemini:    "gemini-2.0-flash",
};

const LANGS: { id: Lang; label: string }[] = [
  { id: "es", label: "Español" },
  { id: "en", label: "English" },
];

const SettingsModal: Component = () => {
  const [tab, setTab] = createSignal<Tab>("appearance");
  const [keyValues, setKeyValues] = createSignal<Record<string, string>>({});
  const [keySet,    setKeySet]    = createSignal<Record<string, boolean>>({});
  const [keySaving, setKeySaving] = createSignal<Record<string, boolean>>({});
  const [keySaved,  setKeySaved]  = createSignal<Record<string, boolean>>({});

  const lang = () => store.language;
  const tr   = (key: Parameters<typeof t>[1]) => t(lang(), key);

  const close = () => setStore("settingsOpen", false);

  onMount(async () => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));

    const status: Record<string, boolean> = {};
    for (const { id } of KEY_PROVIDERS) {
      status[id] = await invoke<boolean>("vault_has_key", { provider: id }).catch(() => false);
    }
    setKeySet(status);
  });

  const applyTheme = (id: string) => {
    setStore("theme", id);
    document.documentElement.setAttribute("data-theme", id);
    localStorage.setItem("braces_theme", id);
  };

  const togglePersistSessions = () => {
    const next = !store.persistSessions;
    setStore("persistSessions", next);
    localStorage.setItem("braces_persist_sessions", String(next));
  };

  const setLang = (l: Lang) => {
    setStore("language", l);
    localStorage.setItem("braces_language", l);
  };

  const saveKey = async (providerId: string) => {
    const key = (keyValues()[providerId] ?? "").trim();
    if (!key) return;
    setKeySaving(s => ({ ...s, [providerId]: true }));
    try {
      await invoke("vault_set_key", { provider: providerId, key });
      setKeySet(s =>    ({ ...s, [providerId]: true }));
      setKeyValues(v => ({ ...v, [providerId]: "" }));
      setKeySaved(s =>  ({ ...s, [providerId]: true }));
      setTimeout(() => setKeySaved(s => ({ ...s, [providerId]: false })), 2000);
    } catch (e) {
      console.error("[braces] vault_set_key:", e);
    } finally {
      setKeySaving(s => ({ ...s, [providerId]: false }));
    }
  };

  return (
    <div
      class="settings-overlay"
      onClick={e => { if ((e.target as Element).classList.contains("settings-overlay")) close(); }}
    >
      <div class="settings-card">

        {/* ── Header ──────────────────────────────────────────────────── */}
        <div class="settings-header">
          <div class="settings-header-left">
            <span class="settings-hex">⬡</span>
            <span class="settings-title">{tr("settings")}</span>
          </div>
          <div class="settings-header-right">
            {/* Language quick-toggle in header */}
            <div class="settings-lang-pill">
              {LANGS.map(l => (
                <button
                  class={`slp-btn${store.language === l.id ? " active" : ""}`}
                  onClick={() => setLang(l.id)}
                  title={l.label}
                >
                  <span class="slp-code">{l.id.toUpperCase()}</span>
                </button>
              ))}
            </div>
            <button class="settings-close" onClick={close} title={tr("close_hint")}>✕</button>
          </div>
        </div>

        {/* ── Tabs ────────────────────────────────────────────────────── */}
        <div class="settings-tabs">
          {(["appearance", "ai", "keys"] as const).map(t_id => (
            <button
              class={`stab${tab() === t_id ? " active" : ""}`}
              onClick={() => setTab(t_id)}
            >
              {t_id === "appearance"
                ? tr("tab_appearance")
                : t_id === "ai"
                  ? tr("tab_ai")
                  : tr("tab_keys")}
            </button>
          ))}
        </div>

        {/* ── Body ────────────────────────────────────────────────────── */}
        <div class="settings-body">

          {/* ── Appearance ──────────────────────────────────────────── */}
          <Show when={tab() === "appearance"}>

            {/* Theme */}
            <div class="sfield">
              <label class="slabel">{tr("theme")}</label>
              <div class="theme-grid">
                {THEMES.map(th => (
                  <button
                    class={`theme-btn${store.theme === th.id ? " active" : ""}`}
                    style={{ "--t-accent": th.accent } as any}
                    onClick={() => applyTheme(th.id)}
                  >
                    <span class="theme-dot" />
                    {th.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Session persistence */}
            <div class="sfield sfield-row">
              <div>
                <label class="slabel">{tr("persist_sessions")}</label>
                <p class="sdesc">{tr("persist_sessions_desc")}</p>
              </div>
              <button class={`stoggle${store.persistSessions ? " on" : ""}`} onClick={togglePersistSessions}>
                {store.persistSessions ? tr("on") : tr("off")}
              </button>
            </div>

          </Show>

          {/* ── AI ──────────────────────────────────────────────────── */}
          <Show when={tab() === "ai"}>
            <div class="sfield">
              <label class="slabel">{tr("main_provider")}</label>
              <select
                class="sselect"
                value={store.provider}
                onChange={e => {
                  const p = e.currentTarget.value as Provider;
                  setStore("provider", p);
                  setStore("model", DEFAULT_MODELS[p] ?? "");
                  localStorage.setItem("braces_provider", p);
                  localStorage.setItem("braces_model", DEFAULT_MODELS[p] ?? "");
                }}
              >
                {PROVIDERS.map(p => <option value={p}>{p}</option>)}
              </select>
            </div>

            <div class="sfield">
              <label class="slabel">{tr("model")}</label>
              <input
                class="sinput"
                type="text"
                value={store.model}
                onInput={e => {
                  const m = e.currentTarget.value;
                  setStore("model", m);
                  localStorage.setItem("braces_model", m);
                }}
                placeholder={DEFAULT_MODELS[store.provider] ?? tr("model_placeholder")}
              />
            </div>

            <Show when={store.provider === "ollama" || store.provider === "lmstudio"}>
              <div class="sfield">
                <label class="slabel">{tr("local_host")}</label>
                <input
                  class="sinput"
                  type="text"
                  value={localStorage.getItem(`braces_host_${store.provider}`) ?? ""}
                  placeholder={store.provider === "ollama"
                    ? tr("ollama_placeholder")
                    : tr("lmstudio_placeholder")}
                  onInput={e => {
                    localStorage.setItem(`braces_host_${store.provider}`, e.currentTarget.value);
                  }}
                />
                <p class="sdesc">{tr("local_host_desc")}</p>
              </div>
            </Show>

            <div class="sfield sfield-row">
              <div>
                <label class="slabel">{tr("autocomplete")}</label>
                <p class="sdesc">{tr("autocomplete_desc")}</p>
              </div>
              <button class="stoggle on">{tr("on")}</button>
            </div>

            <div class="sinfo">
              <span class="sinfo-icon">⬡</span>
              {tr("ai_info")}
            </div>
          </Show>

          {/* ── API Keys ────────────────────────────────────────────── */}
          <Show when={tab() === "keys"}>
            <p class="shint">{tr("keys_hint")}</p>
            {KEY_PROVIDERS.map(({ id, label, placeholder }) => (
              <div class="sfield skey-block">
                <div class="skey-label-row">
                  <label class="slabel">{label}</label>
                  <Show when={keySet()[id]}>
                    <span class="skey-badge">{tr("key_set_badge")}</span>
                  </Show>
                  <Show when={keySaved()[id]}>
                    <span class="skey-badge ok">{tr("key_saved_badge")}</span>
                  </Show>
                </div>
                <div class="skey-input-row">
                  <input
                    class="sinput"
                    type="password"
                    placeholder={keySet()[id] ? `${placeholder}  (replace)` : placeholder}
                    value={keyValues()[id] ?? ""}
                    onInput={e => setKeyValues(v => ({ ...v, [id]: e.currentTarget.value }))}
                    onKeyDown={e => { if (e.key === "Enter") saveKey(id); }}
                  />
                  <button
                    class="skey-save"
                    disabled={!keyValues()[id]?.trim() || keySaving()[id]}
                    onClick={() => saveKey(id)}
                  >
                    {keySaving()[id] ? "…" : tr("save")}
                  </button>
                </div>
              </div>
            ))}
          </Show>

        </div>
      </div>
    </div>
  );
};

export default SettingsModal;

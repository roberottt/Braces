import { Component, createSignal, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { setStore } from "../store/terminalStore";

const PROVIDERS = ["ollama", "anthropic", "openai", "lmstudio", "xai", "gemini", "nvidia"] as const;
type ProviderName = (typeof PROVIDERS)[number];

const NEEDS_KEY: ProviderName[] = ["anthropic", "openai", "xai", "gemini", "nvidia"];
const NEEDS_HOST: ProviderName[] = ["ollama", "lmstudio"];

type Props = { onDone: () => void };

const OnboardingWizard: Component<Props> = (props) => {
  const [step, setStep] = createSignal(0);
  const [provider, setProvider] = createSignal<ProviderName>("ollama");
  const [apiKey, setApiKey] = createSignal("");
  const [host, setHost] = createSignal("http://localhost:11434");
  const THEMES = [
    { id: "neon-noir",      label: "Anakin" },
    { id: "akira",          label: "Mace Windu" },
    { id: "ghost-protocol", label: "Yoda" },
    { id: "c3po",      label: "C-3PO" },
    { id: "minimal",        label: "Stormtrooper" },
  ];
  const [theme, setTheme] = createSignal("neon-noir");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");

  const saveKey = async () => {
    const p = provider();
    if (NEEDS_KEY.includes(p) && apiKey().trim()) {
      await invoke("vault_set_key", { provider: p, key: apiKey().trim() });
    }
  };

  const DEFAULT_MODELS: Record<ProviderName, string> = {
    ollama: "llama3.2", anthropic: "claude-opus-4-8", openai: "gpt-4o-mini",
    lmstudio: "local-model", xai: "grok-3", gemini: "gemini-2.0-flash",
    nvidia: "meta/llama-3.1-8b-instruct",
  };

  const finish = async () => {
    setBusy(true);
    setError("");
    try {
      await saveKey();
      const p = provider();
      const model = DEFAULT_MODELS[p];
      setStore("provider", p as any);
      setStore("model", model);
      setStore("theme", theme());
      document.documentElement.setAttribute("data-theme", theme());
      // Persist so the choices survive a restart (App.tsx reads these on boot).
      localStorage.setItem("braces_provider", p);
      localStorage.setItem("braces_model", model);
      localStorage.setItem("braces_theme", theme());
      if (NEEDS_HOST.includes(p) && host().trim()) {
        localStorage.setItem(`braces_host_${p}`, host().trim());
      }
      props.onDone();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const STEP_COUNT = 3;
  const pct = () => `${Math.round(((step() + 1) / STEP_COUNT) * 100)}%`;

  return (
    <div class="onboarding-overlay" data-tauri-drag-region>
      <div class="onboarding-card">
        <div class="hud-corners">
          <span class="hc-br" />
          <span class="hc-bl" />
        </div>

        <h2>Braces</h2>
        <p class="ow-sub">AI-Native Terminal · First-run setup</p>
        <p class="ow-step">Step {step() + 1} of {STEP_COUNT} — {pct()}</p>

        {/* Step 0: Choose AI provider */}
        <Show when={step() === 0}>
          <div class="ow-field">
            <label class="ow-label">SELECT AI PROVIDER</label>
            <div class="ow-provider-grid">
              {PROVIDERS.map((p) => (
                <button
                  class={`ow-provider-btn${provider() === p ? " selected" : ""}`}
                  onClick={() => {
                    setProvider(p);
                    if (p === "ollama")   setHost("http://localhost:11434");
                    if (p === "lmstudio") setHost("http://localhost:1234");
                  }}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>

          <Show when={NEEDS_KEY.includes(provider())}>
            <div class="ow-field">
              <label class="ow-label">API KEY ({provider().toUpperCase()})</label>
              <input
                type="password"
                class="ow-input"
                placeholder="sk-…"
                value={apiKey()}
                onInput={(e) => setApiKey(e.currentTarget.value)}
              />
            </div>
          </Show>

          <Show when={NEEDS_HOST.includes(provider())}>
            <div class="ow-field">
              <label class="ow-label">HOST URL</label>
              <input
                class="ow-input"
                value={host()}
                onInput={(e) => setHost(e.currentTarget.value)}
              />
            </div>
          </Show>
        </Show>

        {/* Step 1: Visual theme */}
        <Show when={step() === 1}>
          <div class="ow-field">
            <label class="ow-label">THEME</label>
            <div class="ow-provider-grid">
              {THEMES.map(({ id, label }) => (
                <button
                  class={`ow-provider-btn${theme() === id ? " selected" : ""}`}
                  onClick={() => {
                    setTheme(id);
                    document.documentElement.setAttribute("data-theme", id);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

        </Show>

        {/* Step 2: Confirm */}
        <Show when={step() === 2}>
          <div style={{ color: "var(--fg-mid)", "font-size": "13px", "line-height": "1.8" }}>
            <div><span style={{ color: "var(--accent)" }}>Provider:</span> {provider()}</div>
            <div><span style={{ color: "var(--accent)" }}>Theme:</span> {THEMES.find(t => t.id === theme())?.label ?? theme()}</div>
          </div>
          <p style={{ "margin-top": "16px", "font-size": "11px", color: "var(--fg-dim)" }}>
            API keys are encrypted with AES-256-GCM and stored in the OS keychain.
            Config is saved to <code>~/.config/braces/braces.toml</code>.
          </p>
          {error() && (
            <p style={{ color: "var(--accent-red)", "font-size": "11px", "margin-top": "8px" }}>
              {error()}
            </p>
          )}
        </Show>

        <div class="ow-actions">
          <Show when={step() > 0}>
            <button class="ow-btn" onClick={() => setStep((s) => s - 1)}>BACK</button>
          </Show>
          <Show when={step() < STEP_COUNT - 1}>
            <button class="ow-btn primary" onClick={() => setStep((s) => s + 1)}>NEXT</button>
          </Show>
          <Show when={step() === STEP_COUNT - 1}>
            <button class="ow-btn primary" onClick={finish} disabled={busy()}>
              {busy() ? "SAVING…" : "LAUNCH"}
            </button>
          </Show>
        </div>
      </div>
    </div>
  );
};

export default OnboardingWizard;

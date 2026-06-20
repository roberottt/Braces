import { Component, For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import WarpTerminal from "./terminal/WarpTerminal";
import HistoryOverlay from "./terminal/HistoryOverlay";
import StatusBar from "./hud/StatusBar";
import AiSidePanel from "./hud/AiSidePanel";
import ErrorPanel from "./hud/ErrorPanel";
import MetricsOverlay from "./hud/MetricsOverlay";
import FxOverlay from "./fx/FxOverlay";
import OnboardingWizard from "./onboarding/OnboardingWizard";
import SettingsModal from "./settings/SettingsModal";
import TabSidebar from "./hud/TabSidebar";
import GitPanel from "./hud/GitPanel";
import WorkspacePanel from "./hud/WorkspacePanel";
import CodeReviewPanel from "./hud/CodeReviewPanel";
import { store, setStore, genTabId } from "./store/terminalStore";
import { initChats } from "./store/chatStore";
import { t } from "./i18n";

const FIRST_RUN_KEY = "braces_setup_done";

const App: Component = () => {
  const [showOnboarding, setShowOnboarding] = createSignal(false);
  const [glitch, setGlitch] = createSignal(false);

  // ── git status: refresh whenever cwd changes ─────────────────────────────
  const refreshGit = async (cwd: string) => {
    if (!cwd || cwd === "~") return;
    try {
      const status = await invoke<{
        isRepo: boolean; branch: string;
        ahead: number; behind: number;
        files: unknown[];
      }>("git_status", { cwd });
      setStore("gitIsRepo",       status.isRepo);
      setStore("gitBranch",       status.branch  ?? "");
      setStore("gitAhead",        status.ahead   ?? 0);
      setStore("gitBehind",       status.behind  ?? 0);
      setStore("gitChangedCount", status.isRepo ? (status.files?.length ?? 0) : 0);
    } catch { /* git not available or non-repo — ignore */ }
  };

  // Reactive refresh on cwd change (e.g. after cd).
  createEffect(() => { refreshGit(store.cwd); });

  // Event-driven refresh: fired by WarpTerminal after every command.
  onMount(() => {
    const handler = (e: Event) => {
      const cwd = (e as CustomEvent<{ cwd: string }>).detail?.cwd ?? store.cwd;
      refreshGit(cwd);
    };
    window.addEventListener("braces:git-refresh", handler);
    onCleanup(() => window.removeEventListener("braces:git-refresh", handler));
  });

  // Polling fallback: guarantees the branch/count pill stays current even if
  // the event-driven path misses (e.g. git checkout run in the terminal,
  // block never formally closed, etc.). 2 s is imperceptible for the user.
  onMount(() => {
    const id = setInterval(() => {
      const cwd = store.cwd;
      if (cwd && cwd !== "~") refreshGit(cwd);
    }, 2000);
    onCleanup(() => clearInterval(id));
  });

  // ── Persist tabs to DB whenever they change (debounced 400 ms) ─────────────
  let saveTabsTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    if (!store.hydrated || !store.persistSessions) return;
    const tabs = store.tabs.map((t) => ({ ...t }));
    const activeTabId = store.activeTabId;
    if (saveTabsTimer) clearTimeout(saveTabsTimer);
    saveTabsTimer = setTimeout(() => {
      invoke("db_save_tabs", { tabs, activeTabId }).catch((e) =>
        console.error("[braces] db_save_tabs failed:", e)
      );
    }, 400);
  });

  onMount(async () => {
    // ── Hydrate tabs from DB (only when session persistence is enabled) ───────
    try {
      const result = store.persistSessions
        ? await invoke<{
            tabs: { id: string; title: string; cwd: string; lastExitCode: number | null }[];
            activeTabId: string | null;
          }>("db_load_tabs")
        : { tabs: [], activeTabId: null };

      if (result.tabs.length > 0) {
        setStore("tabs", result.tabs);
        const activeId = result.activeTabId;
        const active =
          (activeId && result.tabs.find((t) => t.id === activeId)) ||
          result.tabs[0];
        setStore("activeTabId", active.id);
        setStore("cwd", active.cwd);
        setStore("lastExitCode", active.lastExitCode);
      }
    } catch (e) {
      console.error("[braces] tab hydration failed:", e);
    }
    setStore("hydrated", true);

    // ── Hydrate chats from DB ──────────────────────────────────────────────
    await initChats();

    if (!localStorage.getItem(FIRST_RUN_KEY)) {
      setShowOnboarding(true);
    }

    try {
      const cfg = await invoke<{
        ai: { primary: string };
        providers: Record<string, { model?: string }>;
        visual: { theme: string; effects: boolean };
      }>("get_config");

      const provider = (localStorage.getItem("braces_provider") ?? cfg.ai.primary) as any;
      const model    = localStorage.getItem("braces_model")
                    ?? cfg.providers[cfg.ai.primary]?.model
                    ?? "";
      const theme    = localStorage.getItem("braces_theme")    ?? cfg.visual.theme;
      const effects  = localStorage.getItem("braces_effects") !== null
                    ? localStorage.getItem("braces_effects") === "true"
                    : cfg.visual.effects;

      setStore("provider", provider);
      setStore("model", model);
      setStore("theme", theme);
      setStore("effectsEnabled", effects);
      document.documentElement.setAttribute("data-theme", theme);
    } catch {
      const theme = localStorage.getItem("braces_theme");
      if (theme) {
        setStore("theme", theme);
        document.documentElement.setAttribute("data-theme", theme);
      }
      const effects = localStorage.getItem("braces_effects");
      if (effects !== null) setStore("effectsEnabled", effects === "true");
      const provider = localStorage.getItem("braces_provider");
      if (provider) setStore("provider", provider as any);
      const model = localStorage.getItem("braces_model");
      if (model) setStore("model", model);
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === ",") {
        e.preventDefault();
        setStore("settingsOpen", v => !v);
      }
      // Ctrl+Alt+T → new tab (guard e.repeat so holding the key doesn't flood tabs)
      if (e.ctrlKey && e.altKey && e.key === "t" && !e.repeat) {
        e.preventDefault();
        const id = genTabId();
        setStore("tabs", (prev) => [
          ...prev,
          { id, title: t(store.language, "new_session"), cwd: store.cwd || "~", lastExitCode: null },
        ]);
        setStore("activeTabId", id);
        setStore("tabsSidebarOpen", true);
      }
      // Ctrl+W → close active tab (kept open if it's the last one)
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === "w" && !e.repeat) {
        e.preventDefault();
        if (store.tabs.length > 1) {
          const id = store.activeTabId;
          const idx = store.tabs.findIndex(t => t.id === id);
          const remaining = store.tabs.filter(t => t.id !== id);
          const next = remaining[Math.min(idx, remaining.length - 1)];
          if (next) {
            setStore("activeTabId", next.id);
            setStore("cwd", next.cwd);
            setStore("lastExitCode", next.lastExitCode);
          }
          setStore("tabs", remaining);
          // Remove from persistent storage
          invoke("db_delete_tab", { tabId: id }).catch(() => {});
        }
      }
      // Ctrl+Tab / Ctrl+Shift+Tab → cycle through tabs (forward / backward)
      if (e.ctrlKey && !e.altKey && e.key === "Tab") {
        e.preventDefault();
        const tabs = store.tabs;
        if (tabs.length > 1) {
          const idx = tabs.findIndex(t => t.id === store.activeTabId);
          const next = tabs[(idx + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length];
          setStore("activeTabId", next.id);
          setStore("cwd", next.cwd);
          setStore("lastExitCode", next.lastExitCode);
        }
      }
      // Git panel shortcuts
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "g") {
        e.preventDefault();
        setStore("gitPanelOpen", v => !v);
      }
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "e") {
        e.preventDefault();
        const opening = !store.workspaceOpen;
        setStore("workspaceOpen", opening);
        if (opening) setStore("leftDockView", "files");
      }
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "r") {
        e.preventDefault();
        setStore("codeReviewOpen", v => !v);
      }
    };
    // Window-level singleton: HMR can stack multiple live <App /> trees whose
    // stale listeners never got cleaned up — evict any previous handler so at
    // most ONE shortcut listener exists no matter how many instances mounted.
    const w = window as unknown as { __bracesAppKeyHandler?: (e: KeyboardEvent) => void };
    if (w.__bracesAppKeyHandler) window.removeEventListener("keydown", w.__bracesAppKeyHandler);
    w.__bracesAppKeyHandler = onKey;
    window.addEventListener("keydown", onKey);
    onCleanup(() => {
      window.removeEventListener("keydown", onKey);
      if (w.__bracesAppKeyHandler === onKey) delete w.__bracesAppKeyHandler;
    });

    setInterval(() => {
      if (store.effectsEnabled && Math.random() < 0.25) {
        setGlitch(true);
        setTimeout(() => setGlitch(false), 80 + Math.random() * 150);
      }
    }, 45000);
  });

  const onOnboardingDone = () => {
    localStorage.setItem(FIRST_RUN_KEY, "1");
    setShowOnboarding(false);
  };

  return (
    <div class={`app${glitch() ? " glitch" : ""}`} data-theme={store.theme}>

      <Show when={showOnboarding()}>
        <OnboardingWizard onDone={onOnboardingDone} />
      </Show>

      <StatusBar />

      <div class="workspace">
        {/* Left dock — sessions or files */}
        <Show when={store.tabsSidebarOpen}>
          <Show when={store.leftDockView === "sessions"} fallback={<WorkspacePanel />}>
            <TabSidebar />
          </Show>
        </Show>

        {/* Show-sidebar button when sidebar is hidden — flex sibling, not inside terminal */}
        <Show when={!store.tabsSidebarOpen}>
          <button
            class="tab-sidebar-show-btn"
            title={t(store.language, "show_sessions_tip")}
            onClick={() => setStore("tabsSidebarOpen", true)}
          >
            ›
          </button>
        </Show>

        {/* Terminal area — all tabs mounted, only active visible.
            Rendered only after DB hydration so PTYs are not spawned for seed tabs. */}
        <div class="terminal-area">
          <Show when={store.hydrated}>
            <For each={store.tabs}>
              {(tab) => (
                <div
                  class="tab-panel"
                  classList={{ hidden: tab.id !== store.activeTabId }}
                >
                  <WarpTerminal tabId={tab.id} />
                  <Show when={tab.id === store.activeTabId}>
                    <ErrorPanel />
                    <Show when={store.historySearchOpen}>
                      <HistoryOverlay />
                    </Show>
                  </Show>
                </div>
              )}
            </For>
          </Show>
        </div>

        <Show when={store.sidePanelOpen}>
          <AiSidePanel />
        </Show>
        <Show when={store.gitPanelOpen}>
          <GitPanel />
        </Show>
        <Show when={store.codeReviewOpen}>
          <CodeReviewPanel />
        </Show>
      </div>

      <Show when={store.metricsOpen}>
        <MetricsOverlay />
      </Show>

      <Show when={store.settingsOpen}>
        <SettingsModal />
      </Show>

      <FxOverlay enabled={store.effectsEnabled} />
    </div>
  );
};

export default App;

import { createStore } from "solid-js/store";
import type { Lang } from "../i18n";

export type Provider = "ollama" | "anthropic" | "openai" | "lmstudio" | "xai" | "gemini" | "mock";

export type Tab = {
  id: string;
  title: string;
  cwd: string;
  lastExitCode: number | null;
};

export type TerminalStore = {
  cwd: string;
  lastExitCode: number | null;
  provider: Provider;
  model: string;
  /** True once tabs have been loaded from the DB (or confirmed empty). */
  hydrated: boolean;
  /** Whether terminal sessions and block history persist across app restarts. */
  persistSessions: boolean;
  sidePanelOpen: boolean;
  metricsOpen: boolean;
  effectsEnabled: boolean;
  theme: string;
  // Error intelligence
  errorPanelOpen: boolean;
  errorAnalysis: string;
  errorFix: string;
  // Semantic history search
  historySearchOpen: boolean;
  historyResults: string[];
  // Settings panel
  settingsOpen: boolean;
  language: Lang;
  // Tab management
  tabs: Tab[];
  activeTabId: string;
  tabsSidebarOpen: boolean;
  // Git integration
  gitPanelOpen: boolean;
  codeReviewOpen: boolean;
  workspaceOpen: boolean;
  leftDockView: "sessions" | "files";
  gitIsRepo: boolean;
  gitBranch: string;
  gitAhead: number;
  gitBehind: number;
  gitChangedCount: number;
  gitSelectedFile: string | null;
  gitSelectedStaged: boolean;
};

let _tabCounter = 0;
export const genTabId = () => `tab-${Date.now()}-${_tabCounter++}`;

const initialTabId = genTabId();

export const [store, setStore] = createStore<TerminalStore>({
  cwd: "~",
  lastExitCode: null,
  provider: "ollama",
  model: "llama3.2",
  hydrated: false,
  persistSessions: (localStorage.getItem("braces_persist_sessions") ?? "true") !== "false",
  sidePanelOpen: false,
  metricsOpen: false,
  effectsEnabled: true,
  theme: "neon-noir",
  errorPanelOpen: false,
  errorAnalysis: "",
  errorFix: "",
  historySearchOpen: false,
  historyResults: [],
  settingsOpen: false,
  language: (localStorage.getItem("braces_language") as Lang | null) ?? "es",
  tabs: [{ id: initialTabId, title: (localStorage.getItem("braces_language") === "en" ? "New session" : "Nueva sesión"), cwd: "~", lastExitCode: null }],
  activeTabId: initialTabId,
  tabsSidebarOpen: true,
  // Git integration
  gitPanelOpen: false,
  codeReviewOpen: false,
  workspaceOpen: false,
  leftDockView: "sessions",
  gitIsRepo: false,
  gitBranch: "",
  gitAhead: 0,
  gitBehind: 0,
  gitChangedCount: 0,
  gitSelectedFile: null,
  gitSelectedStaged: false,
});

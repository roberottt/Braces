import { Component, For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { store, setStore } from "../store/terminalStore";
import { t } from "../i18n";
import GitDiffView from "./GitDiffView";
import PanelSizeControls from "./PanelSizeControls";
import PanelResizeHandle from "./PanelResizeHandle";

type GitStatusKind = "modified" | "added" | "deleted" | "renamed" | "copied" | "untracked" | "conflicted";

type GitFileStatus = {
  path: string;
  origPath: string | null;
  indexStatus: GitStatusKind | null;
  worktreeStatus: GitStatusKind | null;
};

type GitStatus = {
  isRepo: boolean;
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  detached: boolean;
  files: GitFileStatus[];
};

type GitCommit = {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
  refs: string[];
};

type GitCommitFile = {
  path: string;
  status: GitStatusKind | null;
};

type GitBranch = {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  upstream: string | null;
  lastDate: string;
  lastSubject: string;
};

type GitStashEntry = {
  index: number;
  message: string;
};

type PanelTab = "changes" | "history" | "branches" | "stash";

const HIST_PAGE = 50;

const GLYPH: Partial<Record<string, string>> = {
  modified: "M", added: "A", deleted: "D", renamed: "R",
  copied: "C", untracked: "?", conflicted: "!",
};

const KIND_COLOR: Partial<Record<string, string>> = {
  modified:   "var(--accent-amber)",
  added:      "var(--accent-lime)",
  deleted:    "var(--accent-red)",
  renamed:    "var(--accent)",
  copied:     "var(--accent)",
  untracked:  "var(--fg-dim)",
  conflicted: "var(--accent-red)",
};

const glyphFor  = (k: string | null | undefined) => k ? (GLYPH[k]      ?? "·") : "·";
const colorFor  = (k: string | null | undefined) => k ? (KIND_COLOR[k] ?? "var(--fg-mid)") : "var(--fg-mid)";
const basename  = (p: string) => p.replace(/\\/g, "/").split("/").pop() ?? p;
const dirOf     = (p: string) => { const parts = p.replace(/\\/g, "/").split("/"); return parts.length > 1 ? parts.slice(0, -1).join("/") + "/" : ""; };

const GitPanel: Component = () => {
  const [status,    setStatus]    = createSignal<GitStatus | null>(null);
  const [commitMsg, setCommitMsg] = createSignal("");
  const [amend,     setAmend]     = createSignal(false);
  const [working,   setWorking]   = createSignal(false);
  const [opError,   setOpError]   = createSignal<string | null>(null);
  const [tab,       setTab]       = createSignal<PanelTab>("changes");

  // Generic inline confirmation bar (discard / delete branch / drop stash)
  const [confirmAction, setConfirmAction] = createSignal<{ message: string; run: () => void } | null>(null);

  // Remote sync
  const [syncing, setSyncing] = createSignal<"fetch" | "pull" | "push" | null>(null);

  // History
  const [commits,     setCommits]     = createSignal<GitCommit[]>([]);
  const [histDone,    setHistDone]    = createSignal(false);
  const [histLoading, setHistLoading] = createSignal(false);
  const [openCommit,  setOpenCommit]  = createSignal<string | null>(null);
  const [commitFiles, setCommitFiles] = createSignal<GitCommitFile[]>([]);
  const [commitDiff,  setCommitDiff]  = createSignal<{ hash: string; shortHash: string; path: string } | null>(null);

  // Branches
  const [branches,      setBranches]      = createSignal<GitBranch[]>([]);
  const [newBranchName, setNewBranchName] = createSignal("");

  // Stash
  const [stashes,        setStashes]        = createSignal<GitStashEntry[]>([]);
  const [stashMsg,       setStashMsg]       = createSignal("");
  const [stashUntracked, setStashUntracked] = createSignal(true);

  const repoCwd = () => {
    const cwd = store.cwd;
    return cwd && cwd !== "~" ? cwd : null;
  };

  const refresh = async () => {
    const cwd = repoCwd();
    if (!cwd) return;
    try {
      const s = await invoke<GitStatus>("git_status", { cwd });
      setStatus(s);
      setStore("gitIsRepo",  s.isRepo);
      setStore("gitBranch",  s.branch  ?? "");
      setStore("gitAhead",   s.ahead   ?? 0);
      setStore("gitBehind",  s.behind  ?? 0);
    } catch { /* ignore */ }
    // Keep the secondary views in sync once they've been opened
    if (commits().length > 0)  loadHistory(true).catch(() => {});
    if (branches().length > 0) loadBranches().catch(() => {});
    if (tab() === "stash")     loadStashes().catch(() => {});
  };

  onMount(() => {
    refresh();
    const handler = () => refresh();
    window.addEventListener("braces:git-refresh", handler);
    onCleanup(() => window.removeEventListener("braces:git-refresh", handler));
  });

  const stagedFiles  = () => (status()?.files ?? []).filter(f => f.indexStatus);
  const changedFiles = () => (status()?.files ?? []).filter(f => !f.indexStatus);

  const notifyRefresh = () =>
    window.dispatchEvent(new CustomEvent("braces:git-refresh", { detail: { cwd: store.cwd } }));

  const mutate = async (op: () => Promise<unknown>) => {
    if (working()) return;
    setWorking(true);
    setOpError(null);
    try {
      await op();
      await refresh();
      notifyRefresh();
    } catch (e) {
      setOpError(String(e));
    } finally {
      setWorking(false);
    }
  };

  // ── changes ────────────────────────────────────────────────────────────────

  const stage    = (path: string) => mutate(() => invoke("git_stage",    { cwd: store.cwd, paths: [path] }));
  const unstage  = (path: string) => mutate(() => invoke("git_unstage",  { cwd: store.cwd, paths: [path] }));
  const stageAll = ()             => mutate(() => invoke("git_stage_all", { cwd: store.cwd }));
  const unstageAll = () => mutate(() =>
    invoke("git_unstage", { cwd: store.cwd, paths: stagedFiles().map(f => f.path) })
  );

  const requestDiscard = (path: string, untracked: boolean) => {
    setConfirmAction({
      message: t(store.language, "discard_confirm_pre") + basename(path) + t(store.language, "discard_confirm_post")
        + (untracked ? t(store.language, "discard_will_delete") : ""),
      run: () => {
        if (store.gitSelectedFile === path) setStore("gitSelectedFile", null);
        mutate(() => invoke("git_discard", {
          cwd:       store.cwd,
          paths:     untracked ? [] : [path],
          untracked: untracked ? [path] : [],
        }));
      },
    });
  };

  const commit = async () => {
    const msg = commitMsg().trim();
    if (!msg || working()) return;
    await mutate(async () => {
      await invoke("git_commit", { cwd: store.cwd, message: msg, amend: amend() });
      setCommitMsg("");
      setAmend(false);
      setStore("gitSelectedFile", null);
    });
  };

  // When enabling amend with an empty message, prefill the last commit's subject
  const toggleAmend = async () => {
    const next = !amend();
    setAmend(next);
    if (next && !commitMsg().trim()) {
      try {
        const last = await invoke<GitCommit[]>("git_log", { cwd: store.cwd, limit: 1, skip: 0 });
        if (last.length > 0 && !commitMsg().trim()) setCommitMsg(last[0].subject);
      } catch { /* ignore */ }
    }
  };

  const selectFile = (path: string, staged: boolean) => {
    if (store.gitSelectedFile === path && store.gitSelectedStaged === staged) {
      setStore("gitSelectedFile", null);
    } else {
      setStore("gitSelectedFile", path);
      setStore("gitSelectedStaged", staged);
    }
  };

  // ── remote sync ────────────────────────────────────────────────────────────

  const sync = async (kind: "fetch" | "pull" | "push") => {
    if (syncing() || !repoCwd()) return;
    setSyncing(kind);
    setOpError(null);
    try {
      await invoke(`git_${kind}`, { cwd: store.cwd });
      await refresh();
      notifyRefresh();
    } catch (e) {
      setOpError(String(e));
    } finally {
      setSyncing(null);
    }
  };

  // ── history ────────────────────────────────────────────────────────────────

  const loadHistory = async (reset: boolean) => {
    const cwd = repoCwd();
    if (!cwd || histLoading()) return;
    setHistLoading(true);
    try {
      const skip = reset ? 0 : commits().length;
      const page = await invoke<GitCommit[]>("git_log", { cwd, limit: HIST_PAGE, skip });
      setCommits(reset ? page : [...commits(), ...page]);
      setHistDone(page.length < HIST_PAGE);
    } catch (e) {
      setOpError(String(e));
    } finally {
      setHistLoading(false);
    }
  };

  const toggleCommit = async (hash: string) => {
    if (openCommit() === hash) {
      setOpenCommit(null);
      setCommitDiff(null);
      return;
    }
    setOpenCommit(hash);
    setCommitDiff(null);
    setCommitFiles([]);
    try {
      const files = await invoke<GitCommitFile[]>("git_commit_files", { cwd: store.cwd, hash });
      if (openCommit() === hash) setCommitFiles(files);
    } catch (e) {
      setOpError(String(e));
    }
  };

  // ── branches ───────────────────────────────────────────────────────────────

  const loadBranches = async () => {
    const cwd = repoCwd();
    if (!cwd) return;
    try {
      setBranches(await invoke<GitBranch[]>("git_branches", { cwd }));
    } catch (e) {
      setOpError(String(e));
    }
  };

  const checkoutBranch = (b: GitBranch) => {
    // "origin/foo" → "foo": git DWIM creates a local tracking branch
    const target = b.isRemote ? b.name.split("/").slice(1).join("/") : b.name;
    if (b.isCurrent || !target) return;
    mutate(() => invoke("git_checkout", { cwd: store.cwd, branch: target }));
  };

  const createBranch = () => {
    const name = newBranchName().trim();
    if (!name) return;
    mutate(async () => {
      await invoke("git_branch_create", { cwd: store.cwd, name });
      setNewBranchName("");
    });
  };

  const requestDeleteBranch = (name: string, force: boolean) => {
    setConfirmAction({
      message: t(store.language, "delete_branch_pre") + name + t(store.language, "delete_branch_post")
        + (force ? t(store.language, "delete_branch_force") : ""),
      run: async () => {
        if (working()) return;
        setWorking(true);
        setOpError(null);
        try {
          await invoke("git_branch_delete", { cwd: store.cwd, name, force });
          await refresh();
          notifyRefresh();
        } catch (e) {
          // Unmerged branch → offer force delete instead of a raw error
          if (!force && String(e).includes("not fully merged")) {
            requestDeleteBranch(name, true);
          } else {
            setOpError(String(e));
          }
        } finally {
          setWorking(false);
        }
      },
    });
  };

  // ── stash ──────────────────────────────────────────────────────────────────

  const loadStashes = async () => {
    const cwd = repoCwd();
    if (!cwd) return;
    try {
      setStashes(await invoke<GitStashEntry[]>("git_stash_list", { cwd }));
    } catch (e) {
      setOpError(String(e));
    }
  };

  const stashPush = () => mutate(async () => {
    await invoke("git_stash_push", {
      cwd: store.cwd,
      message: stashMsg().trim() || null,
      includeUntracked: stashUntracked(),
    });
    setStashMsg("");
  });

  const stashApply = (index: number, pop: boolean) =>
    mutate(() => invoke("git_stash_apply", { cwd: store.cwd, index, pop }));

  const requestStashDrop = (s: GitStashEntry) => {
    setConfirmAction({
      message: t(store.language, "drop_stash_confirm_pre") + s.message + t(store.language, "drop_stash_confirm_post"),
      run: () => mutate(() => invoke("git_stash_drop", { cwd: store.cwd, index: s.index })),
    });
  };

  // ── tabs ───────────────────────────────────────────────────────────────────

  const switchTab = (next: PanelTab) => {
    if (tab() === next) return;
    setTab(next);
    setConfirmAction(null);
    setStore("gitSelectedFile", null);
    setCommitDiff(null);
    if (next === "history"  && commits().length === 0) loadHistory(true);
    if (next === "branches") loadBranches();
    if (next === "stash")    loadStashes();
  };

  const TABS: { id: PanelTab; label: () => string }[] = [
    { id: "changes",  label: () => t(store.language, "git_tab_changes") },
    { id: "history",  label: () => t(store.language, "git_tab_history") },
    { id: "branches", label: () => t(store.language, "git_tab_branches") },
    { id: "stash",    label: () => t(store.language, "git_tab_stash") },
  ];

  return (
    <div
      class="git-panel"
      classList={{ maximized: store.panelMaximized === "git" }}
      style={store.panelWidth.git != null && store.panelMaximized !== "git"
        ? { width: `${store.panelWidth.git}px`, "min-width": `${store.panelWidth.git}px` }
        : undefined}
    >
      <PanelResizeHandle panel="git" />
      <div class="hud-corners"><span class="hc-br" /><span class="hc-bl" /></div>

      {/* Header */}
      <div class="sp-header">
        <span class="sp-title">
          ⎇{" "}
          <Show when={status()?.isRepo} fallback={<span style={{ color: "var(--fg-dim)" }}>—</span>}>
            {status()!.branch || "HEAD"}
            <Show when={(status()?.ahead ?? 0) > 0}> ↑{status()!.ahead}</Show>
            <Show when={(status()?.behind ?? 0) > 0}> ↓{status()!.behind}</Show>
          </Show>
        </span>
        <div class="sp-header-actions">
          <button class="sp-header-btn" title={t(store.language, "refresh")} onClick={refresh}>↻</button>
          <PanelSizeControls panel="git" />
          <button class="sp-header-btn close" title={t(store.language, "close")}
            onClick={() => setStore("gitPanelOpen", false)}>✕</button>
        </div>
      </div>

      {/* Not a repo */}
      <Show when={status() && !status()!.isRepo}>
        <div class="git-empty-state">{t(store.language, "git_not_repo")}</div>
      </Show>

      <Show when={!status() || status()!.isRepo}>
        {/* Sync toolbar */}
        <div class="git-toolbar">
          <button class="git-sync-btn" disabled={syncing() != null}
            classList={{ busy: syncing() === "fetch" }}
            onClick={() => sync("fetch")}>
            ⇣ {t(store.language, "git_fetch")}
          </button>
          <button class="git-sync-btn" disabled={syncing() != null}
            classList={{ busy: syncing() === "pull", highlight: (status()?.behind ?? 0) > 0 }}
            onClick={() => sync("pull")}>
            ↓ {t(store.language, "git_pull")}
            <Show when={(status()?.behind ?? 0) > 0}> ({status()!.behind})</Show>
          </button>
          <button class="git-sync-btn" disabled={syncing() != null}
            classList={{ busy: syncing() === "push", highlight: (status()?.ahead ?? 0) > 0 }}
            onClick={() => sync("push")}>
            ↑ {t(store.language, "git_push")}
            <Show when={(status()?.ahead ?? 0) > 0}> ({status()!.ahead})</Show>
          </button>
        </div>

        {/* Tabs */}
        <div class="git-tabs">
          <For each={TABS}>
            {(tb) => (
              <button class="git-tab" classList={{ active: tab() === tb.id }}
                onClick={() => switchTab(tb.id)}>{tb.label()}</button>
            )}
          </For>
        </div>

        {/* Operation error banner */}
        <Show when={opError()}>
          <div class="git-error-banner">
            <span class="git-error-msg">{opError()}</span>
            <button class="sp-header-btn close" title={t(store.language, "close")}
              onClick={() => setOpError(null)}>✕</button>
          </div>
        </Show>

        {/* Diff pane — worktree/staged file (changes tab) */}
        <Show when={tab() === "changes" && store.gitSelectedFile}>
          <div class="git-diff-area">
            <div class="git-diff-file-bar">
              <span class="git-diff-file-name" title={store.gitSelectedFile!}>
                {basename(store.gitSelectedFile!)}
              </span>
              <span class={`git-diff-file-badge ${store.gitSelectedStaged ? "staged" : "worktree"}`}>
                {store.gitSelectedStaged ? t(store.language, "staged_badge") : t(store.language, "worktree_badge")}
              </span>
              <button class="sp-header-btn close" style={{ "font-size": "10px" }}
                title={t(store.language, "close_diff")}
                onClick={() => setStore("gitSelectedFile", null)}>✕</button>
            </div>
            <GitDiffView path={store.gitSelectedFile!} staged={store.gitSelectedStaged} />
          </div>
        </Show>

        {/* Diff pane — file inside a commit (history tab) */}
        <Show when={tab() === "history" && commitDiff()}>
          <div class="git-diff-area">
            <div class="git-diff-file-bar">
              <span class="git-diff-file-name" title={commitDiff()!.path}>
                {basename(commitDiff()!.path)}
              </span>
              <span class="git-diff-file-badge commit">{commitDiff()!.shortHash}</span>
              <button class="sp-header-btn close" style={{ "font-size": "10px" }}
                title={t(store.language, "close_diff")}
                onClick={() => setCommitDiff(null)}>✕</button>
            </div>
            <GitDiffView path={commitDiff()!.path} staged={false} commit={commitDiff()!.hash} />
          </div>
        </Show>

        {/* Scrollable body */}
        <div class="git-panel-scroll">
          {/* ── CHANGES ── */}
          <Show when={tab() === "changes"}>
            <div class="git-commit-area">
              <textarea
                placeholder={t(store.language, "git_commit_ph")}
                value={commitMsg()}
                onInput={e => setCommitMsg(e.currentTarget.value)}
                rows={2}
              />
              <div class="git-commit-row">
                <button
                  class="git-commit-btn"
                  disabled={!commitMsg().trim() || (stagedFiles().length === 0 && !amend()) || working()}
                  onClick={commit}
                >
                  {working() ? t(store.language, "committing") : `${t(store.language, "commit")}${stagedFiles().length > 0 ? ` (${stagedFiles().length})` : ""}`}
                </button>
                <label class="git-amend-toggle" title={t(store.language, "git_amend_tip")}>
                  <input type="checkbox" checked={amend()} onChange={toggleAmend} />
                  {t(store.language, "git_amend")}
                </label>
              </div>
            </div>

            {/* Staged */}
            <Show when={stagedFiles().length > 0}>
              <div class="git-section staged">
                <div class="git-section-header">
                  <span class="git-section-title">{t(store.language, "git_staged_section")}</span>
                  <span class="git-section-count">{stagedFiles().length}</span>
                  <button class="git-section-btn" title={t(store.language, "unstage_all")} onClick={unstageAll}>
                    {t(store.language, "unstage_all")}
                  </button>
                </div>
                <For each={stagedFiles()}>
                  {(file) => (
                    <div
                      class="git-file-row"
                      classList={{ active: store.gitSelectedFile === file.path && store.gitSelectedStaged }}
                      onClick={() => selectFile(file.path, true)}
                    >
                      <span class="git-status-pill" style={{ "--pill-color": colorFor(file.indexStatus) } as any}>
                        {glyphFor(file.indexStatus)}
                      </span>
                      <div class="git-file-info">
                        <div class="git-file-name" title={file.path}>{basename(file.path)}</div>
                        <Show when={dirOf(file.path)}>
                          <div class="git-file-dir">{dirOf(file.path)}</div>
                        </Show>
                      </div>
                      <div class="git-file-actions">
                        <button class="git-file-btn unstage" title={t(store.language, "unstage")}
                          onClick={e => { e.stopPropagation(); unstage(file.path); }}>−</button>
                        <button class="git-file-btn discard" title={t(store.language, "discard")}
                          onClick={e => { e.stopPropagation(); requestDiscard(file.path, false); }}>✕</button>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </Show>

            {/* Changes */}
            <Show when={changedFiles().length > 0}>
              <div class="git-section changes">
                <div class="git-section-header">
                  <span class="git-section-title">{t(store.language, "changes")}</span>
                  <span class="git-section-count">{changedFiles().length}</span>
                  <button class="git-section-btn" title={t(store.language, "stage_all")} onClick={stageAll}>
                    {t(store.language, "stage_all")}
                  </button>
                </div>
                <For each={changedFiles()}>
                  {(file) => {
                    const isUntracked = () => file.worktreeStatus === "untracked";
                    return (
                      <div
                        class="git-file-row"
                        classList={{ active: store.gitSelectedFile === file.path && !store.gitSelectedStaged }}
                        style={{ cursor: "pointer" }}
                        onClick={() => selectFile(file.path, false)}
                      >
                        <span class="git-status-pill" style={{ "--pill-color": colorFor(file.worktreeStatus) } as any}>
                          {glyphFor(file.worktreeStatus)}
                        </span>
                        <div class="git-file-info">
                          <div class="git-file-name" title={file.path}>{basename(file.path)}</div>
                          <Show when={dirOf(file.path)}>
                            <div class="git-file-dir">{dirOf(file.path)}</div>
                          </Show>
                        </div>
                        <div class="git-file-actions">
                          <button class="git-file-btn stage" title={t(store.language, "stage")}
                            onClick={e => { e.stopPropagation(); stage(file.path); }}>+</button>
                          <button class="git-file-btn discard" title={t(store.language, "discard")}
                            onClick={e => { e.stopPropagation(); requestDiscard(file.path, isUntracked()); }}>✕</button>
                        </div>
                      </div>
                    );
                  }}
                </For>
              </div>
            </Show>

            {/* Empty state */}
            <Show when={stagedFiles().length === 0 && changedFiles().length === 0 && status()?.isRepo}>
              <div class="git-empty-state">{t(store.language, "git_clean")}</div>
            </Show>
          </Show>

          {/* ── HISTORY ── */}
          <Show when={tab() === "history"}>
            <Show when={commits().length === 0 && !histLoading()}>
              <div class="git-empty-state">{t(store.language, "git_history_empty")}</div>
            </Show>
            <For each={commits()}>
              {(c) => (
                <div class="git-commit-item" classList={{ open: openCommit() === c.hash }}>
                  <div class="git-commit-head" onClick={() => toggleCommit(c.hash)}>
                    <span class="git-commit-hash">{c.shortHash}</span>
                    <div class="git-commit-info">
                      <div class="git-commit-subject" title={c.subject}>{c.subject}</div>
                      <div class="git-commit-meta">
                        {c.author} · {c.date}
                        <For each={c.refs}>
                          {(r) => <span class="git-ref-badge" classList={{ remote: r.includes("/") }}>{r}</span>}
                        </For>
                      </div>
                    </div>
                  </div>
                  <Show when={openCommit() === c.hash}>
                    <div class="git-commit-files">
                      <For each={commitFiles()}>
                        {(f) => (
                          <div class="git-file-row"
                            classList={{ active: commitDiff()?.path === f.path }}
                            onClick={() => setCommitDiff({ hash: c.hash, shortHash: c.shortHash, path: f.path })}
                          >
                            <span class="git-status-pill" style={{ "--pill-color": colorFor(f.status) } as any}>
                              {glyphFor(f.status)}
                            </span>
                            <div class="git-file-info">
                              <div class="git-file-name" title={f.path}>{basename(f.path)}</div>
                              <Show when={dirOf(f.path)}>
                                <div class="git-file-dir">{dirOf(f.path)}</div>
                              </Show>
                            </div>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              )}
            </For>
            <Show when={commits().length > 0 && !histDone()}>
              <button class="git-load-more" disabled={histLoading()} onClick={() => loadHistory(false)}>
                {histLoading() ? t(store.language, "loading") : t(store.language, "git_load_more")}
              </button>
            </Show>
          </Show>

          {/* ── BRANCHES ── */}
          <Show when={tab() === "branches"}>
            <div class="git-branch-create">
              <input
                type="text"
                placeholder={t(store.language, "git_new_branch_ph")}
                value={newBranchName()}
                onInput={e => setNewBranchName(e.currentTarget.value)}
                onKeyDown={e => { if (e.key === "Enter") createBranch(); }}
              />
              <button class="git-section-btn" disabled={!newBranchName().trim() || working()} onClick={createBranch}>
                {t(store.language, "git_create_branch")}
              </button>
            </div>

            <For each={[false, true]}>
              {(remote) => {
                const group = () => branches().filter(b => b.isRemote === remote);
                return (
                  <Show when={group().length > 0}>
                    <div class="git-section" classList={{ staged: !remote }}>
                      <div class="git-section-header">
                        <span class="git-section-title">
                          {t(store.language, remote ? "git_remote_branches" : "git_local_branches")}
                        </span>
                        <span class="git-section-count">{group().length}</span>
                      </div>
                      <For each={group()}>
                        {(b) => (
                          <div class="git-branch-row"
                            classList={{ current: b.isCurrent }}
                            title={b.isCurrent ? undefined : t(store.language, "git_checkout_tip")}
                            onClick={() => checkoutBranch(b)}
                          >
                            <span class="git-branch-dot">{b.isCurrent ? "●" : "○"}</span>
                            <div class="git-file-info">
                              <div class="git-file-name" title={b.name}>{b.name}</div>
                              <div class="git-file-dir">{b.lastDate} · {b.lastSubject}</div>
                            </div>
                            <Show when={!b.isRemote && !b.isCurrent}>
                              <div class="git-file-actions">
                                <button class="git-file-btn discard" title={t(store.language, "git_delete_branch_tip")}
                                  onClick={e => { e.stopPropagation(); requestDeleteBranch(b.name, false); }}>✕</button>
                              </div>
                            </Show>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                );
              }}
            </For>
          </Show>

          {/* ── STASH ── */}
          <Show when={tab() === "stash"}>
            <div class="git-stash-create">
              <input
                type="text"
                placeholder={t(store.language, "git_stash_ph")}
                value={stashMsg()}
                onInput={e => setStashMsg(e.currentTarget.value)}
              />
              <div class="git-stash-create-row">
                <button class="git-section-btn"
                  disabled={working() || (stagedFiles().length === 0 && changedFiles().length === 0)}
                  onClick={stashPush}>
                  {t(store.language, "git_stash_save")}
                </button>
                <label class="git-amend-toggle">
                  <input type="checkbox" checked={stashUntracked()}
                    onChange={() => setStashUntracked(!stashUntracked())} />
                  {t(store.language, "git_stash_untracked")}
                </label>
              </div>
            </div>

            <Show when={stashes().length === 0}>
              <div class="git-empty-state">{t(store.language, "git_stash_empty")}</div>
            </Show>
            <For each={stashes()}>
              {(s) => (
                <div class="git-stash-row">
                  <span class="git-stash-index">{`{${s.index}}`}</span>
                  <div class="git-file-info">
                    <div class="git-file-name" title={s.message}>{s.message}</div>
                  </div>
                  <div class="git-stash-actions">
                    <button class="git-file-btn stage" title={t(store.language, "git_stash_apply")}
                      onClick={() => stashApply(s.index, false)}>{t(store.language, "git_stash_apply")}</button>
                    <button class="git-file-btn unstage" title={t(store.language, "git_stash_pop")}
                      onClick={() => stashApply(s.index, true)}>{t(store.language, "git_stash_pop")}</button>
                    <button class="git-file-btn discard" title={t(store.language, "git_stash_drop")}
                      onClick={() => requestStashDrop(s)}>✕</button>
                  </div>
                </div>
              )}
            </For>
          </Show>
        </div>
      </Show>

      {/* Inline confirmation */}
      <Show when={confirmAction()}>
        <div class="git-confirm">
          <span class="git-confirm-msg">{confirmAction()!.message}</span>
          <button class="git-confirm-btn danger"
            onClick={() => { const c = confirmAction()!; setConfirmAction(null); c.run(); }}>
            {t(store.language, "discard_yes")}
          </button>
          <button class="git-confirm-btn" onClick={() => setConfirmAction(null)}>
            {t(store.language, "discard_no")}
          </button>
        </div>
      </Show>
    </div>
  );
};

export default GitPanel;

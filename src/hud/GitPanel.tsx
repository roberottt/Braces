import { Component, For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { store, setStore } from "../store/terminalStore";
import { t } from "../i18n";
import GitDiffView from "./GitDiffView";

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
  const [status,        setStatus]        = createSignal<GitStatus | null>(null);
  const [commitMsg,     setCommitMsg]     = createSignal("");
  const [working,       setWorking]       = createSignal(false);
  const [confirmTarget, setConfirmTarget] = createSignal<{ path: string; untracked: boolean } | null>(null);

  const refresh = async () => {
    const cwd = store.cwd;
    if (!cwd || cwd === "~") return;
    try {
      const s = await invoke<GitStatus>("git_status", { cwd });
      setStatus(s);
      setStore("gitIsRepo",  s.isRepo);
      setStore("gitBranch",  s.branch  ?? "");
      setStore("gitAhead",   s.ahead   ?? 0);
      setStore("gitBehind",  s.behind  ?? 0);
    } catch { /* ignore */ }
  };

  onMount(() => {
    refresh();
    const handler = () => refresh();
    window.addEventListener("braces:git-refresh", handler);
    onCleanup(() => window.removeEventListener("braces:git-refresh", handler));
  });

  const stagedFiles  = () => (status()?.files ?? []).filter(f => f.indexStatus);
  const changedFiles = () => (status()?.files ?? []).filter(f => !f.indexStatus);

  const mutate = async (op: () => Promise<unknown>) => {
    if (working()) return;
    setWorking(true);
    try {
      await op();
      await refresh();
      window.dispatchEvent(new CustomEvent("braces:git-refresh", { detail: { cwd: store.cwd } }));
    } catch (e) {
      console.error("git op failed:", e);
    } finally {
      setWorking(false);
    }
  };

  const stage    = (path: string) => mutate(() => invoke("git_stage",    { cwd: store.cwd, paths: [path] }));
  const unstage  = (path: string) => mutate(() => invoke("git_unstage",  { cwd: store.cwd, paths: [path] }));
  const stageAll = ()             => mutate(() => invoke("git_stage_all", { cwd: store.cwd }));
  const unstageAll = () => mutate(() =>
    invoke("git_unstage", { cwd: store.cwd, paths: stagedFiles().map(f => f.path) })
  );

  const requestDiscard = (path: string, untracked: boolean) =>
    setConfirmTarget({ path, untracked });
  const cancelDiscard  = () => setConfirmTarget(null);
  const doDiscard      = () => {
    const t = confirmTarget();
    if (!t) return;
    setConfirmTarget(null);
    if (store.gitSelectedFile === t.path) setStore("gitSelectedFile", null);
    mutate(() => invoke("git_discard", {
      cwd:       store.cwd,
      paths:     t.untracked ? [] : [t.path],
      untracked: t.untracked ? [t.path] : [],
    }));
  };

  const commit = async () => {
    const msg = commitMsg().trim();
    if (!msg || working()) return;
    setWorking(true);
    try {
      await invoke("git_commit", { cwd: store.cwd, message: msg, amend: false });
      setCommitMsg("");
      setStore("gitSelectedFile", null);
      await refresh();
      window.dispatchEvent(new CustomEvent("braces:git-refresh", { detail: { cwd: store.cwd } }));
    } catch (e) {
      console.error("git commit failed:", e);
    } finally {
      setWorking(false);
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

  return (
    <div class="git-panel">
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
          <button class="sp-header-btn close" title={t(store.language, "close")}
            onClick={() => setStore("gitPanelOpen", false)}>✕</button>
        </div>
      </div>

      {/* Not a repo */}
      <Show when={status() && !status()!.isRepo}>
        <div class="git-empty-state">{t(store.language, "git_not_repo")}</div>
      </Show>

      <Show when={!status() || status()!.isRepo}>
        {/* Diff pane — shown when a file is selected */}
        <Show when={store.gitSelectedFile}>
          <div class="git-diff-area">
            <div class="git-diff-file-bar">
              <span class="git-diff-file-name" title={store.gitSelectedFile!}>
                {basename(store.gitSelectedFile!)}
              </span>
              <span class={`git-diff-file-badge ${store.gitSelectedStaged ? "staged" : "worktree"}`}>
                {store.gitSelectedStaged ? "staged" : "worktree"}
              </span>
              <button class="sp-header-btn close" style={{ "font-size": "10px" }}
                title={t(store.language, "close_diff")}
                onClick={() => setStore("gitSelectedFile", null)}>✕</button>
            </div>
            <GitDiffView path={store.gitSelectedFile!} staged={store.gitSelectedStaged} />
          </div>
        </Show>

        {/* Scrollable body */}
        <div class="git-panel-scroll">
          {/* Commit area */}
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
                disabled={!commitMsg().trim() || stagedFiles().length === 0 || working()}
                onClick={commit}
              >
                {working() ? t(store.language, "committing") : `Commit${stagedFiles().length > 0 ? ` (${stagedFiles().length})` : ""}`}
              </button>
            </div>
          </div>

          {/* Staged */}
          <Show when={stagedFiles().length > 0}>
            <div class="git-section staged">
              <div class="git-section-header">
                <span class="git-section-title">Staged</span>
                <span class="git-section-count">{stagedFiles().length}</span>
                <button class="git-section-btn" title="Unstage all" onClick={unstageAll}>
                  Unstage all
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
                      <button class="git-file-btn unstage" title="Unstage"
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
                <button class="git-section-btn" title="Stage all" onClick={stageAll}>
                  Stage all
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
                        <button class="git-file-btn stage" title="Stage"
                          onClick={e => { e.stopPropagation(); stage(file.path); }}>+</button>
                        <button class="git-file-btn discard" title="Descartar"
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
        </div>
      </Show>

      {/* Discard confirmation */}
      <Show when={confirmTarget()}>
        <div class="git-confirm">
          <span class="git-confirm-msg">
            {t(store.language, "discard_confirm_pre")}{basename(confirmTarget()!.path)}{t(store.language, "discard_confirm_post")}
            <Show when={confirmTarget()!.untracked}>{t(store.language, "discard_will_delete")}</Show>
          </span>
          <button class="git-confirm-btn danger" onClick={doDiscard}>{t(store.language, "discard_yes")}</button>
          <button class="git-confirm-btn" onClick={cancelDiscard}>{t(store.language, "discard_no")}</button>
        </div>
      </Show>
    </div>
  );
};

export default GitPanel;

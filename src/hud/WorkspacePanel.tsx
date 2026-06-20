import { Component, For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { store, setStore } from "../store/terminalStore";
import { t } from "../i18n";

type GitStatusKind = string;

type GitTreeNode = {
  name: string;
  relPath: string;
  isDir: boolean;
  status: GitStatusKind | null;
  children: GitTreeNode[];
};

const STATUS_GLYPH: Record<string, string> = {
  modified: "M", added: "A", deleted: "D", renamed: "R",
  copied: "C", untracked: "?", conflicted: "!",
};

const STATUS_COLOR: Record<string, string> = {
  modified:   "var(--accent-amber)",
  added:      "var(--accent-lime)",
  deleted:    "var(--accent-red)",
  renamed:    "var(--accent)",
  copied:     "var(--accent)",
  untracked:  "var(--fg-dim)",
  conflicted: "var(--accent-red)",
};

// ── recursive tree node ──────────────────────────────────────────────────────

function TreeNode(props: { node: GitTreeNode; depth: number }) {
  const [open, setOpen] = createSignal(props.depth < 2);
  const indent = () => `${props.depth * 10 + 8}px`;

  const handleClick = () => {
    if (props.node.isDir) {
      setOpen(v => !v);
    } else {
      setStore("gitSelectedFile",   props.node.relPath);
      setStore("gitSelectedStaged", false);
      if (!store.gitPanelOpen) setStore("gitPanelOpen", true);
    }
  };

  return (
    <>
      <div
        class="ws-node"
        classList={{
          "ws-dir":  props.node.isDir,
          "ws-file": !props.node.isDir,
          active:    !props.node.isDir && store.gitSelectedFile === props.node.relPath,
        }}
        style={{ "padding-left": indent() }}
        onClick={handleClick}
        title={props.node.relPath || props.node.name}
      >
        <span class="ws-icon">
          {props.node.isDir ? (open() ? "▾" : "▸") : "·"}
        </span>
        <span class="ws-name">{props.node.name}</span>
        <Show when={props.node.status}>
          <span
            class="ws-badge"
            style={{ color: STATUS_COLOR[props.node.status!] ?? "var(--fg-dim)" }}
          >
            {STATUS_GLYPH[props.node.status!] ?? "·"}
          </span>
        </Show>
      </div>
      <Show when={props.node.isDir && open()}>
        <For each={props.node.children}>
          {(child) => <TreeNode node={child} depth={props.depth + 1} />}
        </For>
      </Show>
    </>
  );
}

// ── panel ────────────────────────────────────────────────────────────────────

const WorkspacePanel: Component = () => {
  const [tree,    setTree]    = createSignal<GitTreeNode | null>(null);
  const [loading, setLoading] = createSignal(false);

  const refresh = async () => {
    const cwd = store.cwd;
    if (!cwd || cwd === "~") return;
    setLoading(true);
    try {
      const t = await invoke<GitTreeNode>("git_file_tree", { cwd });
      setTree(t);
    } catch {
      setTree(null);
    } finally {
      setLoading(false);
    }
  };

  onMount(() => {
    refresh();
    const handler = () => refresh();
    window.addEventListener("braces:git-refresh", handler);
    onCleanup(() => window.removeEventListener("braces:git-refresh", handler));
  });

  const close = () => {
    setStore("tabsSidebarOpen", false);
    setStore("workspaceOpen",   false);
  };

  const switchToSessions = () => setStore("leftDockView", "sessions");

  return (
    <div class="tab-sidebar">
      {/* Header */}
      <div class="tab-sidebar-header">
        <div class="ws-dock-toggle">
          <button class="ws-dock-btn" onClick={switchToSessions}>{t(store.language, "sessions")}</button>
          <button class="ws-dock-btn active">{t(store.language, "files_label")}</button>
        </div>
        <div class="tab-sidebar-actions">
          <button class="tab-sidebar-btn" title={t(store.language, "refresh")} onClick={refresh}>↻</button>
          <button class="tab-sidebar-btn" title={t(store.language, "hide_panel")} onClick={close}>‹</button>
        </div>
      </div>

      {/* Repo root label */}
      <Show when={tree()}>
        <div class="ws-root-label" title={store.cwd}>
          {store.cwd.replace(/\\/g, "/").split("/").slice(-2).join("/")}
        </div>
      </Show>

      {/* Tree */}
      <div class="tab-list" style={{ "padding-top": "2px" }}>
        <Show when={loading()}>
          <div class="git-empty-state">{t(store.language, "loading")}</div>
        </Show>
        <Show when={!loading() && tree()}>
          <For each={tree()!.children}>
            {(node) => <TreeNode node={node} depth={0} />}
          </For>
        </Show>
        <Show when={!loading() && !tree()}>
          <div class="git-empty-state">{t(store.language, "no_read_dir")}</div>
        </Show>
      </div>
    </div>
  );
};

export default WorkspacePanel;

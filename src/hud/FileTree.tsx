import { Component, For, Show, createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { store } from "../store/terminalStore";
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

type FileClickHandler = (relPath: string, name: string) => void;

// ── recursive tree node ──────────────────────────────────────────────────────
//
// Rendered like the classic unix `tree` command (├── / └── / │) since this is
// a terminal app — connectors are plain monospace text, not icon glyphs.
//
// Directories are loaded lazily: a node's children are only fetched from the
// backend the first time it's expanded. Eagerly walking the whole tree used
// to let one huge subtree (e.g. a `.cargo` registry with tens of thousands of
// entries) exhaust the node budget before its siblings were even listed.

function TreeNode(props: {
  node: GitTreeNode;
  prefix: string;
  isLast: boolean;
  depth: number;
  refreshEpoch: number;
  selectedPath?: string | null;
  onFileClick: FileClickHandler;
}) {
  const [open,     setOpen]     = createSignal(false);
  const [children, setChildren] = createSignal<GitTreeNode[]>([]);
  const [fetched,  setFetched]  = createSignal(false);

  const connector   = () => (props.isLast ? "└── " : "├── ");
  const childPrefix = () => props.prefix + (props.isLast ? "    " : "│   ");

  const loadChildren = async () => {
    try {
      const kids = await invoke<GitTreeNode[]>("git_dir_children", { cwd: store.cwd, relPath: props.node.relPath });
      setChildren(kids);
    } catch {
      setChildren([]);
    } finally {
      setFetched(true);
    }
  };

  // Re-fetch already-expanded directories when a refresh is triggered (e.g.
  // after staging/committing), so git-status badges stay current.
  createEffect(on(() => props.refreshEpoch, (_epoch, prevEpoch) => {
    if (prevEpoch !== undefined && props.node.isDir && fetched()) loadChildren();
  }));

  const handleClick = () => {
    if (props.node.isDir) {
      const next = !open();
      setOpen(next);
      if (next && !fetched()) loadChildren();
    } else {
      props.onFileClick(props.node.relPath, props.node.name);
    }
  };

  return (
    <>
      <div
        class="ws-node"
        classList={{
          "ws-dir":  props.node.isDir,
          "ws-file": !props.node.isDir,
          active:    !props.node.isDir && props.selectedPath === props.node.relPath,
        }}
        onClick={handleClick}
        title={props.node.relPath || props.node.name}
      >
        <span class="ws-prefix">{props.prefix}{connector()}</span>
        <span class="ws-chevron">{props.node.isDir ? (open() ? "▾" : "▸") : ""}</span>
        <span class="ws-name">
          {props.node.name}
          <Show when={props.node.isDir}><span class="ws-slash">/</span></Show>
        </span>
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
        <For each={children()}>
          {(child, i) => (
            <TreeNode
              node={child}
              prefix={childPrefix()}
              isLast={i() === children().length - 1}
              depth={props.depth + 1}
              refreshEpoch={props.refreshEpoch}
              selectedPath={props.selectedPath}
              onFileClick={props.onFileClick}
            />
          )}
        </For>
      </Show>
    </>
  );
}

// ── tree ─────────────────────────────────────────────────────────────────────

type Props = {
  onFileClick: FileClickHandler;
  selectedPath?: string | null;
};

const FileTree: Component<Props> = (props) => {
  const [roots,        setRoots]        = createSignal<GitTreeNode[] | null>(null);
  const [loading,      setLoading]      = createSignal(false);
  const [refreshEpoch, setRefreshEpoch] = createSignal(0);

  const refresh = async () => {
    const cwd = store.cwd;
    if (!cwd || cwd === "~") return;
    setLoading(true);
    try {
      const kids = await invoke<GitTreeNode[]>("git_dir_children", { cwd, relPath: "" });
      setRoots(kids);
    } catch {
      setRoots(null);
    } finally {
      setLoading(false);
      setRefreshEpoch(e => e + 1);
    }
  };

  onMount(() => {
    refresh();
    const handler = () => refresh();
    window.addEventListener("braces:git-refresh", handler);
    onCleanup(() => window.removeEventListener("braces:git-refresh", handler));
  });

  return (
    <>
      <Show when={roots()}>
        <div class="ws-root-label" title={store.cwd}>
          {store.cwd.replace(/\\/g, "/").split("/").slice(-2).join("/")}
        </div>
      </Show>

      <div class="tab-list" style={{ "padding-top": "2px" }}>
        <Show when={loading()}>
          <div class="git-empty-state">{t(store.language, "loading")}</div>
        </Show>
        <Show when={!loading() && roots()}>
          <For each={roots()!}>
            {(node, i) => (
              <TreeNode
                node={node}
                prefix=""
                isLast={i() === roots()!.length - 1}
                depth={0}
                refreshEpoch={refreshEpoch()}
                selectedPath={props.selectedPath}
                onFileClick={props.onFileClick}
              />
            )}
          </For>
        </Show>
        <Show when={!loading() && !roots()}>
          <div class="git-empty-state">{t(store.language, "no_read_dir")}</div>
        </Show>
      </div>
    </>
  );
};

export default FileTree;

import { Component, For, Show, createEffect, createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { store } from "../store/terminalStore";
import { t } from "../i18n";
import { shiftWheelScroll } from "./shiftWheelScroll";

type GitDiffLine = {
  origin: string;
  content: string;
  oldNo: number | null;
  newNo: number | null;
};

type GitDiffHunk = {
  header: string;
  lines: GitDiffLine[];
};

type GitFileDiff = {
  path: string;
  hunks: GitDiffHunk[];
  isBinary: boolean;
  rawUnified: string;
};

type Props = {
  path: string;
  staged: boolean;
};

const GitDiffView: Component<Props> = (props) => {
  const [diff, setDiff] = createSignal<GitFileDiff | null>(null);
  const [loading, setLoading] = createSignal(false);

  createEffect(async () => {
    const path   = props.path;
    const staged = props.staged;
    if (!path) { setDiff(null); return; }
    const cwd = store.cwd;
    if (!cwd || cwd === "~") return;
    setLoading(true);
    try {
      const d = await invoke<GitFileDiff>("git_diff_file", { cwd, path, staged });
      setDiff(d);
    } catch {
      setDiff(null);
    } finally {
      setLoading(false);
    }
  });

  const lineClass = (origin: string) =>
    origin === "+" ? "add" : origin === "-" ? "del" : "ctx";

  return (
    <div class="git-diff-scroll" onWheel={shiftWheelScroll}>
      <Show when={loading()}>
        <div class="git-diff-empty">{t(store.language, "loading")}</div>
      </Show>
      <Show when={!loading() && diff()?.isBinary}>
        <div class="git-diff-binary">{t(store.language, "binary_file")}</div>
      </Show>
      <Show when={!loading() && diff() && !diff()!.isBinary && diff()!.hunks.length === 0}>
        <div class="git-diff-empty">{t(store.language, "no_changes_diff")}</div>
      </Show>
      <For each={diff()?.hunks ?? []}>
        {(hunk) => (
          <div class="diff-hunk">
            <div class="diff-hunk-header">{hunk.header}</div>
            <For each={hunk.lines}>
              {(line) => (
                <div class={`diff-line ${lineClass(line.origin)}`}>
                  <span class="diff-gutter">{line.oldNo ?? ""}</span>
                  <span class="diff-gutter">{line.newNo ?? ""}</span>
                  <span class="diff-origin">{line.origin === " " ? " " : line.origin}</span>
                  <span class="diff-content">{line.content}</span>
                </div>
              )}
            </For>
          </div>
        )}
      </For>
    </div>
  );
};

export default GitDiffView;

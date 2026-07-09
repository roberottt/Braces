import { Component, Show, createSignal, createMemo, For } from "solid-js";
import type { JSX } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { store, setStore } from "../store/terminalStore";
import { t } from "../i18n";
import PanelSizeControls from "./PanelSizeControls";
import PanelResizeHandle from "./PanelResizeHandle";
import { shiftWheelScroll } from "./shiftWheelScroll";

const REVIEW_PROMPT = (diff: string) =>
  `You are a senior software engineer doing a code review. Analyze the following git diff and give concise, actionable feedback grouped by file. Focus on: bugs, security issues, logic errors, and significant style problems. Be direct. Always wrap code, diff excerpts and commands in fenced code blocks (\`\`\`), never as plain text.\n\n\`\`\`diff\n${diff}\n\`\`\``;

function renderInline(text: string): JSX.Element {
  const parts: JSX.Element[] = [];
  const regex = /(\*\*[^*]+\*\*)|(`[^`]+`)/g;
  let lastIdx = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIdx) {
      parts.push(<span>{text.slice(lastIdx, match.index)}</span>);
    }
    if (match[0].startsWith("**")) {
      parts.push(<strong class="rv-bold">{match[0].slice(2, -2)}</strong>);
    } else {
      parts.push(<code class="rv-code">{match[0].slice(1, -1)}</code>);
    }
    lastIdx = regex.lastIndex;
  }
  if (lastIdx < text.length) {
    parts.push(<span>{text.slice(lastIdx)}</span>);
  }
  return <>{parts}</>;
}

function renderLine(line: string): JSX.Element {
  if (line.startsWith("### ")) {
    return <div class="rv-h3">{renderInline(line.slice(4))}</div>;
  }
  if (line.startsWith("## ")) {
    return <div class="rv-h2">{renderInline(line.slice(3))}</div>;
  }
  if (line.startsWith("# ")) {
    return <div class="rv-h1">{renderInline(line.slice(2))}</div>;
  }
  const numMatch = line.match(/^(\d+)\.\s+(.*)/);
  if (numMatch) {
    return (
      <div class="rv-li">
        <span class="rv-li-num">{numMatch[1]}.</span>
        <span class="rv-li-body">{renderInline(numMatch[2])}</span>
      </div>
    );
  }
  if (line.startsWith("- ") || line.startsWith("* ")) {
    return (
      <div class="rv-bullet">
        <span class="rv-bullet-dot">▸</span>
        <span>{renderInline(line.slice(2))}</span>
      </div>
    );
  }
  if (line.trim() === "") {
    return <div class="rv-spacer" />;
  }
  return <div class="rv-p">{renderInline(line)}</div>;
}

type ReviewSegment =
  | { kind: "code"; text: string }
  | { kind: "line"; text: string };

/** Split the review into plain lines and fenced code blocks (``` … ```). */
function parseSegments(text: string): ReviewSegment[] {
  const out: ReviewSegment[] = [];
  let codeBuf: string[] | null = null;
  for (const line of text.split("\n")) {
    if (/^```/.test(line)) {
      if (codeBuf !== null) {
        out.push({ kind: "code", text: codeBuf.join("\n") });
        codeBuf = null;
      } else {
        codeBuf = [];
      }
      continue;
    }
    if (codeBuf !== null) codeBuf.push(line);
    else out.push({ kind: "line", text: line });
  }
  // Unterminated fence — happens mid-stream; render what we have so far.
  if (codeBuf !== null) out.push({ kind: "code", text: codeBuf.join("\n") });
  return out;
}

const CodeReviewPanel: Component = () => {
  const [review,    setReview]    = createSignal("");
  const [streaming, setStreaming] = createSignal(false);
  const [error,     setError]     = createSignal("");

  const startReview = async (staged: boolean) => {
    if (streaming()) return;
    const cwd = store.cwd;
    if (!cwd || cwd === "~") { setError(t(store.language, "review_no_cwd")); return; }

    setReview("");
    setError("");
    setStreaming(true);

    let diff: string;
    try {
      diff = await invoke<string>("git_diff_all", { cwd, staged });
    } catch (e) {
      setError(t(store.language, "review_diff_err") + e);
      setStreaming(false);
      return;
    }

    if (!diff.trim()) {
      setError(staged ? t(store.language, "review_no_staged") : t(store.language, "review_no_worktree"));
      setStreaming(false);
      return;
    }

    const providerName = store.provider;
    const model        = store.model;
    const host         = localStorage.getItem(`braces_host_${providerName}`) ?? undefined;

    const unlisten = await listen<string>("ai-chat-token", (ev) => {
      setReview(prev => prev + ev.payload);
    });

    try {
      const result = await invoke<string>("ai_chat", {
        query:       REVIEW_PROMPT(diff.slice(0, 12_000)),
        cwd,
        history:     [],
        providerName,
        model,
        host,
        activeTabId: store.activeTabId,
      });
      if (result && result.length > review().length) setReview(result);
    } catch (e) {
      setError("Error: " + e);
    } finally {
      unlisten();
      setStreaming(false);
    }
  };

  const segments = createMemo(() => parseSegments(review()));

  return (
    <div
      class="side-panel"
      classList={{ maximized: store.panelMaximized === "review" }}
      style={store.panelWidth.review != null && store.panelMaximized !== "review"
        ? { width: `${store.panelWidth.review}px`, "min-width": `${store.panelWidth.review}px` }
        : undefined}
    >
      <PanelResizeHandle panel="review" />
      <div class="hud-corners"><span class="hc-br" /><span class="hc-bl" /></div>

      <div class="sp-header">
        <span class="sp-title">{t(store.language, "code_review_title")}</span>
        <div class="sp-header-actions">
          <PanelSizeControls panel="review" />
          <button class="sp-header-btn close" title={t(store.language, "close")}
            onClick={() => setStore("codeReviewOpen", false)}>✕</button>
        </div>
      </div>

      <div class="review-actions">
        <button
          class="review-btn"
          classList={{ active: streaming() }}
          disabled={streaming()}
          onClick={() => startReview(true)}
        >
          <span class="review-btn-icon">⊕</span>
          <span class="review-btn-label">
            {streaming() ? t(store.language, "reviewing") : t(store.language, "review_staged")}
            <span class="review-btn-sub">{t(store.language, "review_staged_sub")}</span>
          </span>
        </button>
        <button
          class="review-btn"
          disabled={streaming()}
          onClick={() => startReview(false)}
        >
          <span class="review-btn-icon">⊘</span>
          <span class="review-btn-label">
            {t(store.language, "review_worktree_btn")}
            <span class="review-btn-sub">{t(store.language, "review_worktree_sub")}</span>
          </span>
        </button>
      </div>

      <Show when={error()}>
        <div class="review-error">{error()}</div>
      </Show>

      <div class="sp-messages review-scroll" onWheel={shiftWheelScroll}>
        <Show when={!review() && !streaming() && !error()}>
          <div class="sp-empty">
            {t(store.language, "review_empty_hint")}
          </div>
        </Show>
        <Show when={streaming() && !review()}>
          <div class="sp-empty">{t(store.language, "review_generating")}</div>
        </Show>
        <Show when={review()}>
          <div class="review-body">
            <For each={segments()}>
              {(seg) =>
                seg.kind === "code"
                  ? <pre class="rv-codeblock">{seg.text}</pre>
                  : renderLine(seg.text)
              }
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
};

export default CodeReviewPanel;

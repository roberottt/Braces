import { Component, createSignal, For, Show, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { store, setStore } from "../store/terminalStore";
import {
  chatStore,
  setChatStore,
  newChat,
  switchChat,
  deleteChat,
  persistActiveChat,
  type Msg,
  type UserMsg,
  type AssistMsg,
  type ExecMsg,
} from "../store/chatStore";
import { t } from "../i18n";
import PanelSizeControls from "./PanelSizeControls";
import PanelResizeHandle from "./PanelResizeHandle";

/** Build ChatMessage history for the backend, embedding exec results into context. */
function buildHistory(msgs: Msg[]): { role: string; content: string }[] {
  const result: { role: string; content: string }[] = [];
  let i = 0;
  while (i < msgs.length) {
    const m = msgs[i];
    if (m.kind === "user") {
      result.push({ role: "user", content: m.content });
      i++;
    } else if (m.kind === "assistant") {
      // Collect this AI message and any exec blocks that follow it
      let combined = m.content;
      let j = i + 1;
      while (j < msgs.length && msgs[j].kind === "exec") {
        const ex = msgs[j] as ExecMsg;
        if (ex.out !== null) {
          combined += `\nEXEC: ${ex.cmd}\nOutput:\n${ex.out}`;
        }
        j++;
      }
      result.push({ role: "assistant", content: combined });
      i = j;
    } else {
      // standalone exec (shouldn't normally appear without a prior assistant msg)
      i++;
    }
  }
  return result;
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

const AiSidePanel: Component = () => {
  const [query, setQuery] = createSignal("");
  const [streaming, setStreaming] = createSignal(false);
  let bottomRef: HTMLDivElement | undefined;
  let inputRef: HTMLTextAreaElement | undefined;

  const scrollBottom = () =>
    requestAnimationFrame(() => bottomRef?.scrollIntoView({ behavior: "smooth" }));

  const ensureAssistantTail = () => {
    setChatStore("messages", (prev) => {
      const last = prev[prev.length - 1];
      if (last?.kind === "assistant") return prev;
      return [...prev, { kind: "assistant" as const, content: "" }];
    });
  };

  const send = async (q: string) => {
    q = q.trim();
    if (!q || streaming()) return;

    // Snapshot history BEFORE appending the new user message
    const history = buildHistory(chatStore.messages);

    setChatStore("messages", (prev) => [...prev, { kind: "user" as const, content: q }]);
    setQuery("");
    setStreaming(true);
    scrollBottom();

    // Register listener BEFORE invoke so no events are missed
    const unlisten = await listen<Record<string, unknown>>("ai-agent-event", (ev) => {
      const evt = ev.payload;

      if (evt.t === "token" && typeof evt.text === "string") {
        setChatStore("messages", (prev) => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          if (last?.kind === "assistant") {
            copy[copy.length - 1] = { ...last, content: last.content + (evt.text as string) };
          } else {
            copy.push({ kind: "assistant" as const, content: evt.text as string });
          }
          return copy;
        });
        scrollBottom();

      } else if (evt.t === "new_block") {
        setChatStore("messages", (prev) => [...prev, { kind: "assistant" as const, content: "" }]);
        scrollBottom();

      } else if (evt.t === "exec_start" && typeof evt.cmd === "string") {
        setChatStore("messages", (prev) => [
          ...prev,
          { kind: "exec" as const, cmd: evt.cmd as string, out: null, ok: null },
        ]);
        scrollBottom();

      } else if (evt.t === "exec_done" && typeof evt.cmd === "string") {
        setChatStore("messages", (prev) => {
          const copy = [...prev];
          for (let i = copy.length - 1; i >= 0; i--) {
            const m = copy[i];
            if (m.kind === "exec" && m.cmd === (evt.cmd as string) && m.out === null) {
              copy[i] = {
                ...m,
                out: (evt.out as string | undefined) ?? "(no output)",
                ok: (evt.ok as boolean | undefined) ?? false,
              };
              break;
            }
          }
          return copy;
        });
        scrollBottom();
      }
    });

    // Ensure there is an assistant bubble ready for the first token
    ensureAssistantTail();

    const providerName = store.provider;
    const model = store.model;
    const host = localStorage.getItem(`braces_host_${providerName}`) ?? undefined;

    try {
      await invoke<string>("ai_agent", {
        query: q,
        cwd: store.cwd,
        history,
        providerName,
        model,
        host,
        activeTabId: store.activeTabId,
      });
    } catch (e) {
      setChatStore("messages", (prev) => {
        const copy = [...prev];
        const last = copy[copy.length - 1];
        if (last?.kind === "assistant" && last.content === "") {
          copy[copy.length - 1] = { ...last, content: `Error: ${e}` };
          return copy;
        }
        return [...prev, { kind: "assistant" as const, content: `Error: ${e}` }];
      });
    } finally {
      unlisten();
      setStreaming(false);
      scrollBottom();
      // Persist to DB after each completed exchange
      await persistActiveChat();
    }
  };

  const applyFix = () => {
    const allContent = chatStore.messages
      .filter((m): m is AssistMsg => m.kind === "assistant")
      .map((m) => m.content)
      .join("\n");
    const fixLine = allContent.split("\n").find((l) => l.startsWith("FIX:"));
    if (fixLine) {
      const cmd = fixLine.replace(/^FIX:\s*/, "").trim();
      window.dispatchEvent(new CustomEvent("braces:inject-cmd", { detail: cmd }));
    }
  };

  onMount(() => inputRef?.focus());

  const isStreaming = () => streaming();
  const isLastMsg = (idx: () => number) => idx() === chatStore.messages.length - 1;

  return (
    <div
      class="side-panel"
      classList={{ maximized: store.panelMaximized === "ai" }}
      style={store.panelWidth.ai != null && store.panelMaximized !== "ai"
        ? { width: `${store.panelWidth.ai}px`, "min-width": `${store.panelWidth.ai}px` }
        : undefined}
    >
      <PanelResizeHandle panel="ai" />
      <div class="hud-corners">
        <span class="hc-br" />
        <span class="hc-bl" />
      </div>

      {/* ── Header ── */}
      <div class="sp-header">
        <span class="sp-model" title={t(store.language, "provider_model_tip")}>
          {store.provider}{store.model ? ` · ${store.model}` : ""}
        </span>
        <span style={{ flex: 1 }} />
        <div class="sp-header-actions">
          <Show when={chatStore.messages.some(m => m.kind === "assistant" && (m as AssistMsg).content.includes("FIX:"))}>
            <button class="sp-header-btn" title={t(store.language, "apply_fix_hint")} onClick={applyFix}>
              <svg class="sp-header-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
              </svg>
            </button>
          </Show>
          <button class="sp-header-btn" title={t(store.language, "new_chat")} onClick={newChat} disabled={streaming()}>
            <svg class="sp-header-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          <button
            class="sp-header-btn"
            classList={{ active: chatStore.historyOpen }}
            title={t(store.language, "chat_history")}
            onClick={() => setChatStore("historyOpen", v => !v)}
          >
            <svg class="sp-header-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="4" y1="6" x2="20" y2="6" />
              <line x1="4" y1="12" x2="20" y2="12" />
              <line x1="4" y1="18" x2="20" y2="18" />
            </svg>
          </button>
          <PanelSizeControls panel="ai" />
          <button
            class="sp-header-btn close"
            title={t(store.language, "close")}
            onClick={() => setStore("sidePanelOpen", false)}
          >
            <svg class="sp-header-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      {/* ── History overlay ── */}
      <Show when={chatStore.historyOpen}>
        <div class="sp-history">
          <div class="sp-history-title">{t(store.language, "chat_history")}</div>
          <Show
            when={chatStore.chats.length > 0}
            fallback={<div class="sp-history-empty">{t(store.language, "no_chats")}</div>}
          >
            <For each={chatStore.chats}>
              {(chat) => (
                <div
                  class="sp-history-item"
                  classList={{ active: chat.id === chatStore.activeChatId }}
                  onClick={() => switchChat(chat.id)}
                >
                  <div class="sp-history-item-title">{chat.title || t(store.language, "untitled_chat")}</div>
                  <div class="sp-history-item-date">{formatDate(chat.updatedAt)}</div>
                  <button
                    class="sp-history-item-del"
                    title={t(store.language, "delete_chat")}
                    onClick={(e) => { e.stopPropagation(); deleteChat(chat.id); }}
                  >
                    ×
                  </button>
                </div>
              )}
            </For>
          </Show>
        </div>
      </Show>

      {/* ── Messages ── */}
      <div class="sp-messages">
        <For
          each={chatStore.messages}
          fallback={
            <div class="sp-empty">
              {t(store.language, "agent_empty")}
            </div>
          }
        >
          {(msg, idx) => (
            <>
              <Show when={msg.kind === "user"}>
                <div class="sp-msg sp-msg-user">
                  <div class="sp-msg-label">{t(store.language, "msg_you")}</div>
                  <div class="sp-msg-body">{(msg as UserMsg).content}</div>
                </div>
              </Show>

              <Show when={msg.kind === "assistant"}>
                <div class="sp-msg sp-msg-assistant">
                  <div class="sp-msg-label">
                    {t(store.language, "msg_ai")}
                    <Show when={isStreaming() && isLastMsg(idx)}>
                      <span class="sp-cursor">▌</span>
                    </Show>
                  </div>
                  <div class="sp-msg-body">{(msg as AssistMsg).content}</div>
                </div>
              </Show>

              <Show when={msg.kind === "exec"}>
                <div
                  class={`sp-exec-block ${
                    (msg as ExecMsg).out === null
                      ? "running"
                      : (msg as ExecMsg).ok
                      ? "ok"
                      : "err"
                  }`}
                >
                  <div class="sp-exec-cmd">
                    <span class="sp-exec-prompt">$</span>{" "}
                    {(msg as ExecMsg).cmd}
                  </div>
                  <Show when={(msg as ExecMsg).out === null}>
                    <div class="sp-exec-running">
                      <span class="sp-exec-spin">⟳</span> {t(store.language, "exec_running")}
                    </div>
                  </Show>
                  <Show when={(msg as ExecMsg).out !== null}>
                    <pre class="sp-exec-out">{(msg as ExecMsg).out}</pre>
                  </Show>
                </div>
              </Show>
            </>
          )}
        </For>
        <div ref={bottomRef} />
      </div>

      {/* ── Composer ── */}
      <div class="sp-composer">
        <div class="sp-composer-box">
          <textarea
            ref={inputRef}
            class="sp-input"
            placeholder={t(store.language, "ai_input_ph")}
            value={query()}
            rows={1}
            onInput={(e) => {
              setQuery(e.currentTarget.value);
              e.currentTarget.style.height = "auto";
              e.currentTarget.style.height = `${e.currentTarget.scrollHeight}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(query());
                e.currentTarget.style.height = "auto";
              }
            }}
            disabled={streaming()}
          />
          <button
            class="sp-send"
            title={t(store.language, "ai_input_hint")}
            onClick={() => send(query())}
            disabled={streaming() || !query().trim()}
          >
            {streaming() ? "◌" : "↑"}
          </button>
        </div>
        <div class="sp-composer-hint">{t(store.language, "ai_input_hint")}</div>
      </div>
    </div>
  );
};

export default AiSidePanel;

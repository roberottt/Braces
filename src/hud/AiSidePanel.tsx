import { Component, createSignal, For, Show, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { store, setStore } from "../store/terminalStore";
import { t } from "../i18n";

type UserMsg   = { kind: "user";      content: string };
type AssistMsg = { kind: "assistant"; content: string };
type ExecMsg   = { kind: "exec";      cmd: string; out: string | null; ok: boolean | null };
type Msg = UserMsg | AssistMsg | ExecMsg;

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

const AiSidePanel: Component = () => {
  const [messages, setMessages] = createSignal<Msg[]>([]);
  const [query, setQuery] = createSignal("");
  const [streaming, setStreaming] = createSignal(false);
  let bottomRef: HTMLDivElement | undefined;
  let inputRef: HTMLTextAreaElement | undefined;

  const scrollBottom = () =>
    requestAnimationFrame(() => bottomRef?.scrollIntoView({ behavior: "smooth" }));

  const ensureAssistantTail = () => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.kind === "assistant") return prev;
      return [...prev, { kind: "assistant", content: "" }];
    });
  };

  const send = async (q: string) => {
    q = q.trim();
    if (!q || streaming()) return;

    // Snapshot history BEFORE appending the new user message
    const history = buildHistory(messages());

    setMessages((prev) => [...prev, { kind: "user", content: q }]);
    setQuery("");
    setStreaming(true);
    scrollBottom();

    // Register listener BEFORE invoke so no events are missed
    const unlisten = await listen<Record<string, unknown>>("ai-agent-event", (ev) => {
      const evt = ev.payload;

      if (evt.t === "token" && typeof evt.text === "string") {
        setMessages((prev) => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          if (last?.kind === "assistant") {
            copy[copy.length - 1] = { ...last, content: last.content + (evt.text as string) };
          } else {
            copy.push({ kind: "assistant", content: evt.text as string });
          }
          return copy;
        });
        scrollBottom();

      } else if (evt.t === "new_block") {
        // Start a fresh AI bubble after a sequence of exec blocks
        setMessages((prev) => [...prev, { kind: "assistant", content: "" }]);
        scrollBottom();

      } else if (evt.t === "exec_start" && typeof evt.cmd === "string") {
        setMessages((prev) => [
          ...prev,
          { kind: "exec", cmd: evt.cmd as string, out: null, ok: null },
        ]);
        scrollBottom();

      } else if (evt.t === "exec_done" && typeof evt.cmd === "string") {
        setMessages((prev) => {
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
      setMessages((prev) => {
        const copy = [...prev];
        const last = copy[copy.length - 1];
        if (last?.kind === "assistant" && last.content === "") {
          copy[copy.length - 1] = { ...last, content: `Error: ${e}` };
          return copy;
        }
        return [...prev, { kind: "assistant", content: `Error: ${e}` }];
      });
    } finally {
      unlisten();
      setStreaming(false);
      scrollBottom();
    }
  };

  const analyzeError = async () => {
    if (streaming()) return;
    setStreaming(true);
    setMessages((prev) => [
      ...prev,
      { kind: "user", content: "Analyze the last terminal error and suggest a fix." },
      { kind: "assistant", content: "" },
    ]);
    scrollBottom();

    const unlisten = await listen<string>("ai-analysis-token", (ev) => {
      setMessages((prev) => {
        const copy = [...prev];
        const last = copy[copy.length - 1];
        if (last?.kind === "assistant") {
          copy[copy.length - 1] = { ...last, content: last.content + ev.payload };
        }
        return copy;
      });
      scrollBottom();
    });

    try {
      const result = await invoke<string>("ai_analyze_error", {
        activeTabId: store.activeTabId,
      });
      if (result) {
        setMessages((prev) => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          if (last?.kind === "assistant" && last.content.length < result.length) {
            copy[copy.length - 1] = { ...last, content: result };
          }
          return copy;
        });
      }
    } catch (e) {
      setMessages((prev) => {
        const copy = [...prev];
        const last = copy[copy.length - 1];
        if (last?.kind === "assistant") {
          copy[copy.length - 1] = { ...last, content: `Error: ${e}` };
        }
        return copy;
      });
    } finally {
      unlisten();
      setStreaming(false);
      scrollBottom();
    }
  };

  const applyFix = () => {
    const allContent = messages()
      .filter((m): m is AssistMsg => m.kind === "assistant")
      .map((m) => m.content)
      .join("\n");
    const fixLine = allContent.split("\n").find((l) => l.startsWith("FIX:"));
    if (fixLine) {
      const cmd = fixLine.replace(/^FIX:\s*/, "").trim();
      window.dispatchEvent(new CustomEvent("braces:inject-cmd", { detail: cmd }));
    }
  };

  const clearChat = () => setMessages([]);

  onMount(() => inputRef?.focus());

  const isStreaming = () => streaming();
  const isLastMsg = (idx: () => number) => idx() === messages().length - 1;

  return (
    <div class="side-panel">
      <div class="hud-corners">
        <span class="hc-br" />
        <span class="hc-bl" />
      </div>

      <div class="sp-header">
        <span class="sp-model" title={t(store.language, "provider_model_tip")}>
          {store.provider}{store.model ? ` · ${store.model}` : ""}
        </span>
        <span class="sp-agent-badge">AGENT</span>
        <span style={{ flex: 1 }} />
        <div class="sp-header-actions">
          <button class="sp-header-btn" title={t(store.language, "analyze")} onClick={analyzeError} disabled={streaming()}>
            ▲
          </button>
          <Show when={messages().some(m => m.kind === "assistant" && m.content.includes("FIX:"))}>
            <button class="sp-header-btn" title={t(store.language, "apply_fix_hint")} onClick={applyFix}>
              ⚡
            </button>
          </Show>
          <button class="sp-header-btn" title={t(store.language, "clear_chat")} onClick={clearChat}>
            ⌫
          </button>
          <button
            class="sp-header-btn close"
            title={t(store.language, "close")}
            onClick={() => setStore("sidePanelOpen", false)}
          >
            ✕
          </button>
        </div>
      </div>

      <div class="sp-messages">
        <For
          each={messages()}
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
                  <div class="sp-msg-label">YOU</div>
                  <div class="sp-msg-body">{(msg as UserMsg).content}</div>
                </div>
              </Show>

              <Show when={msg.kind === "assistant"}>
                <div class="sp-msg sp-msg-assistant">
                  <div class="sp-msg-label">
                    AI
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
                      <span class="sp-exec-spin">⟳</span> running…
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

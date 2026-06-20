import { createStore } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";

// ── Message types (also exported for AiSidePanel) ────────────────────────────

export type UserMsg   = { kind: "user";      content: string };
export type AssistMsg = { kind: "assistant"; content: string };
export type ExecMsg   = { kind: "exec";      cmd: string; out: string | null; ok: boolean | null };
export type Msg = UserMsg | AssistMsg | ExecMsg;

export type ChatMeta = { id: string; title: string; createdAt: number; updatedAt: number };

// ── Internal backend record shape ────────────────────────────────────────────

type ChatMsgRecord = {
  kind: string;
  content: string | null;
  cmd: string | null;
  out: string | null;
  ok: boolean | null;
};

// ── Store ────────────────────────────────────────────────────────────────────

type ChatStoreType = {
  chats: ChatMeta[];
  activeChatId: string | null;
  messages: Msg[];
  historyOpen: boolean;
};

export const [chatStore, setChatStore] = createStore<ChatStoreType>({
  chats: [],
  activeChatId: null,
  messages: [],
  historyOpen: false,
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function genChatId(): string {
  return `chat-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function deriveChatTitle(msgs: Msg[]): string {
  const first = msgs.find((m): m is UserMsg => m.kind === "user");
  if (!first) return "Chat";
  const text = first.content.trim();
  return text.length > 42 ? text.slice(0, 42) + "…" : text;
}

function msgsToRecords(msgs: Msg[]): ChatMsgRecord[] {
  return msgs.map((m) => {
    if (m.kind === "user" || m.kind === "assistant") {
      return { kind: m.kind, content: (m as UserMsg | AssistMsg).content, cmd: null, out: null, ok: null };
    }
    const ex = m as ExecMsg;
    return { kind: "exec", content: null, cmd: ex.cmd, out: ex.out, ok: ex.ok };
  });
}

function recordsToMsgs(records: ChatMsgRecord[]): Msg[] {
  return records.map((r) => {
    if (r.kind === "user")      return { kind: "user"      as const, content: r.content ?? "" };
    if (r.kind === "assistant") return { kind: "assistant" as const, content: r.content ?? "" };
    return { kind: "exec" as const, cmd: r.cmd ?? "", out: r.out, ok: r.ok };
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Load all chats + restore the active chat.
 * Called once from App.tsx onMount after tab hydration.
 */
export async function initChats(): Promise<void> {
  try {
    const chats = await invoke<ChatMeta[]>("db_list_chats");
    setChatStore("chats", chats);

    const activeId = await invoke<string | null>("db_get_active_chat");

    if (chats.length === 0) {
      // First launch — create an empty chat
      const id = genChatId();
      const now = Date.now();
      await invoke("db_create_chat", { chatId: id, title: "Chat" });
      await invoke("db_set_active_chat", { chatId: id });
      setChatStore("chats", [{ id, title: "Chat", createdAt: now, updatedAt: now }]);
      setChatStore("activeChatId", id);
      setChatStore("messages", []);
      return;
    }

    // Resolve active chat: use stored id if it still exists, else the most recent
    const resolved =
      activeId && chats.some((c) => c.id === activeId)
        ? activeId
        : chats[0].id;

    setChatStore("activeChatId", resolved);
    const records = await invoke<ChatMsgRecord[]>("db_load_chat", { chatId: resolved });
    setChatStore("messages", recordsToMsgs(records));
  } catch (e) {
    console.error("[braces] chat init failed:", e);
  }
}

/**
 * Persist the current active chat to the DB.
 * Called when a message stream ends.
 */
export async function persistActiveChat(): Promise<void> {
  const id = chatStore.activeChatId;
  if (!id) return;

  const msgs = chatStore.messages;
  if (msgs.length === 0) return;

  const title = deriveChatTitle(msgs);
  const records = msgsToRecords(msgs);

  try {
    await invoke("db_save_chat", { chatId: id, title, messages: records });
    const now = Date.now();
    // Update title + updatedAt in the local chats list, then re-sort
    setChatStore("chats", (c) => c.id === id, "title", title);
    setChatStore("chats", (c) => c.id === id, "updatedAt", now);
    setChatStore("chats", (prev) => [...prev].sort((a, b) => b.updatedAt - a.updatedAt));
  } catch (e) {
    console.error("[braces] persistActiveChat failed:", e);
  }
}

/**
 * Create a fresh empty chat and make it active.
 * The previous chat remains in the history list.
 */
export async function newChat(): Promise<void> {
  await persistActiveChat();

  const id = genChatId();
  const now = Date.now();
  try {
    await invoke("db_create_chat", { chatId: id, title: "Chat" });
    await invoke("db_set_active_chat", { chatId: id });
    setChatStore("chats", (prev) => [
      { id, title: "Chat", createdAt: now, updatedAt: now },
      ...prev,
    ]);
    setChatStore("activeChatId", id);
    setChatStore("messages", []);
    setChatStore("historyOpen", false);
  } catch (e) {
    console.error("[braces] newChat failed:", e);
  }
}

/**
 * Switch to a previously saved chat.
 */
export async function switchChat(id: string): Promise<void> {
  if (id === chatStore.activeChatId) {
    setChatStore("historyOpen", false);
    return;
  }
  await persistActiveChat();
  try {
    const records = await invoke<ChatMsgRecord[]>("db_load_chat", { chatId: id });
    await invoke("db_set_active_chat", { chatId: id });
    setChatStore("activeChatId", id);
    setChatStore("messages", recordsToMsgs(records));
    setChatStore("historyOpen", false);
  } catch (e) {
    console.error("[braces] switchChat failed:", e);
  }
}

/**
 * Delete a chat from both DB and the local list.
 * If the deleted chat was active, switches to the next most recent one
 * (or creates a new empty chat if none remain).
 */
export async function deleteChat(id: string): Promise<void> {
  try {
    await invoke("db_delete_chat", { chatId: id });
    setChatStore("chats", (prev) => prev.filter((c) => c.id !== id));

    if (chatStore.activeChatId === id) {
      const remaining = chatStore.chats; // already updated above
      if (remaining.length > 0) {
        await switchChat(remaining[0].id);
      } else {
        await newChat();
      }
    }
  } catch (e) {
    console.error("[braces] deleteChat failed:", e);
  }
}

// Chat tab — a single default IRC channel (#aeolus). Auto-connects once on
// first view (same convention as the Play tab), then renders whatever the
// chat slice holds; messages and the online-user list update themselves as
// the backend pushes events. Pure: select state + dispatch commands.

import { useEffect, useRef, useState } from "react";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { Button } from "../../design-system/Button";
import type { ChatStatus } from "../../ipc/bindings";

const STATUS_LABEL: Record<ChatStatus, string> = {
  disconnected: "Disconnected",
  connecting: "Connecting…",
  connected: "Live",
};

const connect = (username: string) =>
  ipc.dispatch({ kind: "Chat", command: { type: "connect", payload: { username } } });
const disconnect = () => ipc.dispatch({ kind: "Chat", command: { type: "disconnect" } });
const sendMessage = (content: string) =>
  ipc.dispatch({ kind: "Chat", command: { type: "sendMessage", payload: { content } } });

function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function ChatView() {
  const chat = useAppStore((s) => s.state.chat);
  const username = useAppStore((s) => s.state.auth.player?.name);
  const [draft, setDraft] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Connect once on first mount if idle and we know who we are — deliberately
  // not keyed on status, so a user-initiated disconnect doesn't reconnect.
  useEffect(() => {
    const s = useAppStore.getState().state;
    if (s.chat.status === "disconnected" && s.auth.player) {
      connect(s.auth.player.name);
    }
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [chat.messages.length]);

  const isLive = chat.status === "connected" || chat.status === "connecting";

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const content = draft.trim();
    if (!content) return;
    sendMessage(content);
    setDraft("");
  };

  return (
    <div className="chat">
      <div className="chat-head">
        <h2>#aeolus</h2>
        <span className="muted">{STATUS_LABEL[chat.status]}</span>
        <span className="spacer" />
        <Button onClick={() => (isLive ? disconnect() : connect(username ?? ""))}>
          {isLive ? "Disconnect" : "Connect"}
        </Button>
      </div>

      <div className="chat-body">
        <div className="chat-messages">
          {chat.messages.length === 0 ? (
            <p className="muted">No messages yet.</p>
          ) : (
            chat.messages.map((m) => (
              <div key={m.id} className="chat-message">
                <span className="chat-message-time muted">{formatTime(m.timestamp)}</span>
                <span className="chat-message-sender">{m.sender}</span>
                <span className="chat-message-content">{m.content}</span>
              </div>
            ))
          )}
          <div ref={messagesEndRef} />
        </div>

        <ul className="chat-users">
          {chat.users.map((u) => (
            <li key={u}>{u}</li>
          ))}
        </ul>
      </div>

      <form className="chat-compose" onSubmit={submit}>
        <input
          className="chat-compose-input"
          type="text"
          placeholder={isLive ? "Message #aeolus…" : "Not connected"}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={!isLive}
        />
        <Button variant="primary" disabled={!isLive || !draft.trim()}>
          Send
        </Button>
      </form>
    </div>
  );
}

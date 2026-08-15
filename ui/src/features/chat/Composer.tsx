// The message input.
//
// Both reference clients treat this as a mIRC-style line editor rather than a
// plain text box, and the two behaviours that matter are:
//
//  * Tab completes the partial nickname before the caret, and pressing Tab
//    again cycles through the other matches (Java's `AutoCompletionHelper`,
//    Python's `ChatLineEdit.try_completion`). A completion at the start of the
//    line gets a `: ` suffix, which is how people address each other in #aeolus.
//  * Up/Down walk the history of sent lines (Python's `prev_history`/
//    `next_history`), so correcting a typo doesn't mean retyping.
//
// Slash commands are *not* interpreted here: the backend owns that grammar
// (`faf-domain::protocol::chat_input`). This component only sends raw text.

import { useEffect, useRef, useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { useTranslation } from "../../i18n/useTranslation";
import { EmojiPicker } from "./EmojiPicker";

/** How many sent lines to keep for Up/Down recall. */
const MAX_HISTORY = 50;

interface Props {
  channel: string;
  nicknames: string[];
  disabled: boolean;
  onSend: (content: string) => void;
  /** The message being answered, or `null` for an ordinary line. */
  replyTo?: { msgid: string; sender: string } | null;
  onCancelReply?: () => void;
  /**
   * Report composing state for a named channel. The channel is explicit rather
   * than implied by `props.channel`, because the one case that matters is
   * retracting in the channel being *left*, by which time `props.channel` is
   * already the new one. The backend throttles the wire traffic.
   *
   * Optional: party chat reuses this composer over the lobby protocol, which
   * has no typing notices to send.
   */
  onTyping?: (composing: boolean, channel: string) => void;
}

interface Completion {
  /** Text before the word being completed. */
  prefix: string;
  matches: string[];
  index: number;
}

export function Composer({
  channel,
  nicknames,
  disabled,
  onSend,
  onTyping = () => {},
  replyTo = null,
  onCancelReply,
}: Props) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const completion = useRef<Completion | null>(null);
  const history = useRef<string[]>([]);
  // `null` means "editing a fresh line", not browsing history.
  const historyIndex = useRef<number | null>(null);

  const edit = (value: string) => {
    setDraft(value);
    completion.current = null;
    historyIndex.current = null;
    // Emptying the box is a retraction, not a pause: whoever was waiting for
    // the line should stop being told one is coming.
    onTyping(value.trim() !== "", channel);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const content = draft.trim();
    if (!content) return;
    onSend(content);
    // The message itself already tells everyone we stopped, but saying so
    // explicitly means a client that ignores the message still takes the
    // indicator down.
    onTyping(false, channel);
    history.current = [...history.current, content].slice(-MAX_HISTORY);
    historyIndex.current = null;
    completion.current = null;
    setDraft("");
  };

  const complete = () => {
    const active = completion.current;
    if (active) {
      // Subsequent Tab: cycle to the next candidate for the same partial word.
      const index = (active.index + 1) % active.matches.length;
      completion.current = { ...active, index };
      setDraft(active.prefix + suffixed(active.matches[index], active.prefix));
      return;
    }

    const separator = draft.lastIndexOf(" ");
    const partial = draft.slice(separator + 1);
    if (!partial) return;
    const matches = nicknames
      .filter((n) => n.toLowerCase().startsWith(partial.toLowerCase()))
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    if (matches.length === 0) return;

    const prefix = draft.slice(0, separator + 1);
    completion.current = { prefix, matches, index: 0 };
    setDraft(prefix + suffixed(matches[0], prefix));
  };

  /**
   * Insert at the caret rather than appending.
   *
   * Appending would be simpler and wrong: people reach for the picker while
   * fixing the middle of a half-written line as often as at the end. The caret
   * is restored after the inserted characters so typing continues where the
   * emoji left off, which also survives picking several in a row.
   */
  const insert = (text: string) => {
    const input = inputRef.current;
    const at = input?.selectionStart ?? draft.length;
    const to = input?.selectionEnd ?? at;
    const next = draft.slice(0, at) + text + draft.slice(to);
    completion.current = null;
    historyIndex.current = null;
    setDraft(next);

    const caret = at + text.length;
    // After React has written the new value, or the browser puts the caret at
    // the end of it.
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(caret, caret);
    });
  };

  const recall = (delta: -1 | 1) => {
    const entries = history.current;
    if (entries.length === 0) return;
    const current = historyIndex.current ?? entries.length;
    const next = Math.min(Math.max(current + delta, 0), entries.length);
    historyIndex.current = next;
    completion.current = null;
    // Walking past the newest entry returns to the empty line being composed.
    setDraft(next === entries.length ? "" : entries[next]);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Tab" && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      complete();
      return;
    }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      recall(e.key === "ArrowUp" ? -1 : 1);
      return;
    }
    // Escape drops the answer rather than the draft: the text is the
    // expensive part, the anchor is one click to restore.
    if (e.key === "Escape" && replyTo) {
      e.preventDefault();
      onCancelReply?.();
      return;
    }
    // Any other key ends the completion run, so the next Tab starts fresh.
    if (e.key.length === 1 || e.key === "Backspace" || e.key === "Delete") {
      completion.current = null;
    }
  };

  // Leaving a channel mid-draft retracts *there* rather than leaving the
  // notice to age out in a conversation nobody is watching any more.
  const previousChannel = useRef(channel);
  useEffect(() => {
    const left = previousChannel.current;
    if (left === channel) return;
    previousChannel.current = channel;
    onTyping(false, left);
    setDraft("");
    completion.current = null;
    historyIndex.current = null;
    // `onTyping` is intentionally not a dependency: it is a fresh closure on
    // every render, and re-running this on each one would retract constantly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel]);

  return (
    <form className="chat-compose-shell" onSubmit={submit}>
      {replyTo ? (
        <div className="chat-reply-banner">
          <span>{t("chat.reply.banner", { name: replyTo.sender })}</span>
          <button
            type="button"
            aria-label={t("chat.reply.cancel")}
            title={t("chat.reply.cancel")}
            onClick={onCancelReply}
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      ) : null}
      <div className="chat-compose">
      <input
        ref={inputRef}
        className="chat-input chat-compose-input"
        type="text"
        maxLength={500}
        value={draft}
        placeholder={
          disabled ? t("chat.composer.disabled") : t("chat.composer.placeholder", { channel })
        }
        aria-label={t("chat.composer.aria", { channel })}
        disabled={disabled}
        onChange={(e) => edit(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <EmojiPicker disabled={disabled} onPick={insert} />
      <Button type="submit" variant="primary" disabled={disabled || !draft.trim()}>
        {t("chat.send")}
      </Button>
      </div>
    </form>
  );
}

/** A nickname completed at the start of a line addresses that person. */
const suffixed = (nickname: string, prefix: string) =>
  prefix === "" ? `${nickname}: ` : nickname;

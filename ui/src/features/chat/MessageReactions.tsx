// Reactions under a chat message, and the controls that add and remove one.
//
// The IRCv3 draft this rides on (`+draft/react` anchored by `+draft/reply`)
// defines no *retraction*. Removal therefore travels on a client tag of this
// client's own, `+draft/unreact`, which other clients will not understand:
// between two of these clients a removal is seen by both, and to a client that
// only knows the draft the reaction stays. That limit belongs to the protocol
// and cannot be designed away here.
//
// Clicking a reaction you are part of takes yours back; clicking one you are
// not adds yours. A message the server never gave a `msgid` cannot be reacted
// to at all, so the control is not rendered for one rather than offered and
// then failing.

import { useState } from "react";
import type { Reaction } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";
import { ALL_EMOJI } from "./emoji";

/** The shortlist offered inline. The full picker lives in the composer. */
const QUICK_REACTIONS = ["👍", "😂", "🔥", "❤️", "👏", "🤔"] as const;

interface Props {
  msgid: string;
  reactions: readonly Reaction[];
  /** Our own nick, to mark reactions we are already part of. */
  self: string;
  pickerOpen?: boolean;
  onTogglePicker?: () => void;
  onClosePicker?: () => void;
  onReact: (emoji: string) => void;
  onUnreact: (emoji: string) => void;
}

export function MessageReactions({
  msgid,
  reactions,
  self,
  pickerOpen = false,
  onTogglePicker,
  onClosePicker,
  onReact,
  onUnreact,
}: Props) {
  const { t } = useTranslation();
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = onTogglePicker ? pickerOpen : internalOpen;
  const toggle = onTogglePicker ?? (() => setInternalOpen((o) => !o));
  const close = onClosePicker ?? (() => setInternalOpen(false));

  if (msgid === "") return null;
  if (reactions.length === 0 && !isOpen) return null;

  const react = (emoji: string) => {
    close();
    onReact(emoji);
  };

  return (
    <div className="chat-reactions">
      {reactions.map((reaction) => {
        const mine = reaction.senders.some(
          (sender) => sender.toLowerCase() === self.toLowerCase(),
        );
        return (
          <button
            type="button"
            key={reaction.emoji}
            className={`chat-reaction${mine ? " is-mine" : ""}`}
            // The senders are the whole answer to "who?", and there is nowhere
            // else in the UI that would show them.
            title={reaction.senders.join(", ")}
            aria-label={t(mine ? "chat.reaction.remove" : "chat.reaction.by", {
              emoji: reaction.emoji,
              people: reaction.senders.join(", "),
            })}
            onClick={() => (mine ? onUnreact(reaction.emoji) : react(reaction.emoji))}
          >
            <span aria-hidden="true">{reaction.emoji}</span>
            <span className="chat-reaction-count">{reaction.senders.length}</span>
          </button>
        );
      })}

      <div className="chat-reaction-add">
        <button
          type="button"
          className="chat-reaction-trigger"
          aria-expanded={isOpen}
          aria-label={t("chat.reaction.add")}
          title={t("chat.reaction.add")}
          onClick={toggle}
        >
          +
        </button>
        {isOpen ? (
          <div className="chat-reaction-menu" role="menu">
            {QUICK_REACTIONS.map((emoji) => (
              <button
                type="button"
                key={emoji}
                role="menuitem"
                className="chat-reaction-option"
                aria-label={nameOf(emoji)}
                title={nameOf(emoji)}
                onClick={() => react(emoji)}
              >
                {emoji}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The picker's own name for an emoji, so labels stay consistent with it. */
function nameOf(char: string): string {
  return ALL_EMOJI.find((entry) => entry.char === char)?.name ?? char;
}

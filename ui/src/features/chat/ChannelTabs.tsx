// Channel switcher: the same underline tab strip the Play tab uses for its
// modes (`SectionTabs`), so switching channel looks like every other in-feature
// switch in the client. It cannot be that component directly, because a channel
// tab carries a close button, and a button cannot nest inside a button: so the
// markup is built here and the *styling* is shared by reusing the
// `section-tabs` classes rather than forking them.
//
// Shape follows the Java client's `ChatController` tab pane: the default
// channel is pinned first and not closable, every other channel and private
// conversation gets a close button, and unread traffic shows as a count on the
// tab.
//
// The "+" opens an inline join field rather than keeping a permanent text box
// in the strip, so the row stays quiet when you aren't joining anything. It
// sits directly after the last tab, where the channel it adds will appear,
// rather than parked at the far right of the bar.

import { useEffect, useRef, useState } from "react";
import type { ChatChannel } from "../../ipc/bindings";
import { isPrivateChannel } from "../../store/reducer";
import { Icon } from "../../design-system/Icon";
import "../../design-system/section-tabs.css";
import { useTranslation } from "../../i18n/useTranslation";

interface Props {
  channels: ChatChannel[];
  active: string;
  defaultChannel: string;
  onSelect: (channel: string) => void;
  onJoin: (channel: string) => void;
  onLeave: (channel: string) => void;
}

export function ChannelTabs({
  channels,
  active,
  defaultChannel,
  onSelect,
  onJoin,
  onLeave,
}: Props) {
  const { t } = useTranslation();
  const [joining, setJoining] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (joining) inputRef.current?.focus();
  }, [joining]);

  const close = () => {
    setJoining(false);
    setDraft("");
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const name = draft.trim();
    if (!name) return close();
    // The Java client's join field adds the `#` for the user; so does ours.
    // (Private conversations are opened from the roster, not from here.)
    onJoin(name.startsWith("#") ? name : `#${name}`);
    close();
  };

  return (
    <nav className="section-tabs chat-tabs" role="tablist" aria-label={t("chat.channels.aria")}>
      {channels.map((channel) => {
        const isActive = channel.name === active;
        const closable = channel.name !== defaultChannel;
        return (
          // The wrapper only exists to anchor the close button, so it is
          // hidden from assistive tech and the tab stays owned by the list.
          <div
            key={channel.name}
            role="presentation"
            className={`chat-tab${closable ? " is-closable" : ""}`}
          >
            <button
              type="button"
              role="tab"
              aria-selected={isActive}
              className={`chat-tab-button${isActive ? " active" : ""}`}
              title={channel.name}
              onClick={() => onSelect(channel.name)}
            >
              <Icon name={isPrivateChannel(channel.name) ? "users" : "chat"} size={15} />
              <span className="section-tab-label chat-tab-name">{channel.name}</span>
              {channel.unread > 0 && (
                <span
                  className={`section-tab-count${channel.unreadMentions > 0 ? " is-mention" : ""}`}
                  aria-label={`${channel.unread} unread`}
                >
                  {channel.unread > 99 ? "99+" : channel.unread}
                </span>
              )}
            </button>
            {closable && (
              <button
                type="button"
                className="chat-tab-close"
                aria-label={`Leave ${channel.name}`}
                title={`Leave ${channel.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onLeave(channel.name);
                }}
              >
                <Icon name="close" size={11} />
              </button>
            )}
          </div>
        );
      })}

      {/* This stays mounted while the field is open so it can close it again. */}
      <button
        type="button"
        className={`chat-tab-add${joining ? " is-active" : ""}`}
        aria-label={joining ? t("chat.channels.closeJoinField") : t("chat.channels.join")}
        aria-expanded={joining}
        title={joining ? t("chat.channels.close") : t("chat.channels.join")}
        onClick={() => (joining ? close() : setJoining(true))}
      >
        <Icon name={joining ? "close" : "plus"} size={14} />
      </button>

      {joining && (
        <form className="chat-tab-join" onSubmit={submit}>
          <input
            ref={inputRef}
            className="chat-input"
            type="text"
            value={draft}
            placeholder={t("chat.channels.placeholder")}
            aria-label={t("chat.channels.inputAria")}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && close()}
          />
        </form>
      )}
    </nav>
  );
}

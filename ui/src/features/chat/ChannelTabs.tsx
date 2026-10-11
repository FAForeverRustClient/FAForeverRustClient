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

import { useOverlayLayer } from "../../design-system/useOverlayLayer";
import { useEffect, useRef, useState } from "react";
import type { ChatChannel } from "../../ipc/bindings";
import { isPrivateChannel } from "../../store/reducer";
import { partyChannelLabel } from "../../shared/partyChat";
import { Icon } from "../../design-system/Icon";
import { InactiveSectionPanels, nextTabIndex, sectionPanelId, sectionTabId } from "../../design-system/SectionTabs";
import "../../design-system/section-tabs.css";
import { useTranslation } from "../../i18n/useTranslation";

export const CHAT_TABS_ID = "chat-channel";

interface Props {
  channels: ChatChannel[];
  active: string;
  defaultChannel: string;
  /**
   * The party's room, which is not the user's to close.
   *
   * It is opened and closed by the party itself (`AppShell` joins it when a
   * party forms and parts when it dissolves), so a close button on it offered
   * a way out that the client then disagreed with: the room went, the party
   * did not, and nothing would rejoin it until the party changed. Same
   * treatment as the default channel, for the same reason.
   */
  partyChannel?: string | null;
  onSelect: (channel: string) => void;
  onJoin: (channel: string) => void;
  onLeave: (channel: string) => void;
}

/**
 * Whether this tab is one the user may not close.
 *
 * IRC channel names are case insensitive and the party room's is built from a
 * login, so the comparison has to be too: `#Dog'sParty` and `#dog'sparty` are
 * one room, and only one of the two spellings would otherwise be pinned.
 */
export function isPinnedChannel(
  name: string,
  defaultChannel: string,
  partyChannel: string | null,
): boolean {
  const same = (left: string, right: string) =>
    left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
  return same(name, defaultChannel) || (!!partyChannel && same(name, partyChannel));
}

export function ChannelTabs({
  channels,
  active,
  defaultChannel,
  partyChannel = null,
  onSelect,
  onJoin,
  onLeave,
}: Props) {
  const { t } = useTranslation();
  const [joining, setJoining] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const addRef = useRef<HTMLButtonElement>(null);
  const tabStop = channels.some((channel) => channel.name === active) ? active : channels[0]?.name;

  const leave = (name: string) => {
    const tab = tabRefs.current.get(name);
    if (tab?.parentElement?.contains(document.activeElement)) {
      const index = channels.findIndex((channel) => channel.name === name);
      const next = channels[index + 1] ?? channels[index - 1];
      if (next) {
        tabRefs.current.get(next.name)?.focus();
        onSelect(next.name);
      } else addRef.current?.focus();
    }
    onLeave(name);
  };

  useEffect(() => {
    if (joining) inputRef.current?.focus();
  }, [joining]);

  const close = () => {
    setJoining(false);
    setDraft("");
  };

  useOverlayLayer(joining, () => { close(); addRef.current?.focus(); });

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
    <>
      <nav className="section-tabs chat-tabs" role="tablist" aria-label={t("chat.channels.aria")}>
        {channels.map((channel) => {
          const isActive = channel.name === active;
          const closable = !isPinnedChannel(channel.name, defaultChannel, partyChannel);
          return (
            // The wrapper only exists to anchor the close button, so it is
            // hidden from assistive tech and the tab stays owned by the list.
            <div
              key={channel.name}
              role="presentation"
              className={`chat-tab${closable ? " is-closable" : ""}`}
              onMouseDown={(e) => {
                if (closable && e.button === 1) {
                  e.preventDefault();
                }
              }}
              onAuxClick={(e) => {
                if (closable && e.button === 1) {
                  e.preventDefault();
                  leave(channel.name);
                }
              }}
            >
              <button
                type="button"
                role="tab"
                id={sectionTabId(CHAT_TABS_ID, channel.name)}
                aria-controls={sectionPanelId(CHAT_TABS_ID, channel.name)}
                ref={(node) => {
                  if (node) tabRefs.current.set(channel.name, node);
                  else tabRefs.current.delete(channel.name);
                }}
                tabIndex={channel.name === tabStop ? 0 : -1}
                aria-selected={isActive}
                className={`chat-tab-button${isActive ? " active" : ""}`}
                title={channel.name}
                onClick={() => onSelect(channel.name)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
                  if (event.key === "Delete" && closable) {
                    event.preventDefault();
                    leave(channel.name);
                    return;
                  }
                  const index = channels.findIndex((item) => item.name === channel.name);
                  const next = nextTabIndex(event.key, index, channels.length);
                  if (next === null) return;
                  event.preventDefault();
                  const name = channels[next].name;
                  tabRefs.current.get(name)?.focus();
                  onSelect(name);
                }}
                onMouseDown={(e) => {
                  if (closable && e.button === 1) {
                    e.preventDefault();
                  }
                }}
                onAuxClick={(e) => {
                  if (closable && e.button === 1) {
                    e.preventDefault();
                    e.stopPropagation();
                    leave(channel.name);
                  }
                }}
              >
                <Icon name={isPrivateChannel(channel.name) ? "users" : "chat"} size={15} />
                {/* The label reads as words; the tooltip above is the name every
                    command is sent with. They differ for one room only: IRC
                    forbids the space in "#Somebody's Party". */}
                <span className="section-tab-label chat-tab-name">
                  {partyChannelLabel(channel.name)}
                </span>
                {channel.unread > 0 && (
                  <span
                    className={`section-tab-count${channel.unreadMentions > 0 ? " is-mention" : ""}`}
                    aria-label={t("chat.channels.unread", { count: channel.unread })}
                  >
                    {channel.unread > 99 ? "99+" : channel.unread}
                  </span>
                )}
              </button>
              {closable && (
                <button
                  type="button"
                  className="chat-tab-close"
                  tabIndex={channel.name === tabStop ? 0 : -1}
                  aria-label={t("chat.channels.leave", { channel: partyChannelLabel(channel.name) })}
                  title={t("chat.channels.leave", { channel: partyChannelLabel(channel.name) })}
                  onClick={(e) => {
                    e.stopPropagation();
                    leave(channel.name);
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
          ref={addRef}
          className={`chat-tab-add${joining ? " is-active" : ""}`}
          aria-label={joining ? t("chat.channels.closeJoinField") : t("chat.channels.join")}
          aria-expanded={joining}
          title={joining ? t("chat.channels.close") : t("chat.channels.join")}
          onClick={() => (joining ? close() : setJoining(true))}
        >
          <Icon name={joining ? "close" : "plus"} size={16} />
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
            />
          </form>
        )}
      </nav>
      <InactiveSectionPanels prefix={CHAT_TABS_ID} active={active} items={channels.map((channel) => ({ id: channel.name }))} />
    </>
  );
}

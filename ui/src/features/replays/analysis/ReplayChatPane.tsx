import { useMemo, useState } from "react";
import { MultiSelect } from "../../../design-system/MultiSelect";
import { useAppStore } from "../../../store/store";
import { ipc } from "../../../ipc/client";
import { useTranslation } from "../../../i18n/useTranslation";
import type { BrowsingPreferences, ReplayChatMessage, ReplayChatTransfers } from "../../../ipc/bindings";
import { channelLabel, chatSenders, formatChatTime, isTransferMessage } from "./replayInsightRows";

export function useReplayChat(chatMessages: ReplayChatMessage[]) {
  const [chatSearch, setChatSearch] = useState("");
  // Channel and transfers are a way of reading chat rather than a fact about
  // one game, so they are remembered in the settings and every replay opens
  // with them. Held here as well so a change shows at once rather than after
  // the round trip.
  const savedChannel = useAppStore((s) => s.state.settings.browsing.replayChatChannel);
  const savedTransfers = useAppStore((s) => s.state.settings.browsing.replayChatTransfers);
  const [chatChannel, setChatChannel] = useState(savedChannel);
  // The people whose lines to show; empty shows everyone. A list rather than
  // one name: following a conversation means following both sides of it. Not
  // remembered: the names belong to this game.
  const [chatFrom, setChatFrom] = useState<string[]>([]);
  // In a team game the energy and unit lines can be half the chat: hidden to
  // read what people said, or alone to see who fed whom.
  const [chatTransfers, setChatTransfers] = useState<ReplayChatTransfers>(savedTransfers);

  const rememberChat = (patch: Pick<BrowsingPreferences, "replayChatChannel"> | Pick<BrowsingPreferences, "replayChatTransfers">) => {
    void ipc.send({
      kind: "Settings",
      command: { type: "patchBrowsing", payload: { patch } },
    });
  };

  // The channels this game's chat actually used, so the filter offers what is
  // there. The Python client's tab has the same one, as four checkboxes.
  const chatChannels = useMemo(
    () => [...new Set(chatMessages.map((message) => message.to ?? "").filter(Boolean))].sort(),
    [chatMessages],
  );
  const hasTransfers = useMemo(
    () => chatMessages.some((message) => isTransferMessage(message.message)),
    [chatMessages],
  );
  // A remembered choice this game cannot honour is set aside rather than
  // obeyed: "allies only" on a game nobody wrote to allies in, or "only
  // transfers" on one with none, would be an empty log with the control that
  // emptied it not even on screen.
  const activeChannel = chatChannels.includes(chatChannel) ? chatChannel : "";
  const activeTransfers: ReplayChatTransfers = hasTransfers ? chatTransfers : "show";

  // Every filter but "From", which is what the counts in the From list are
  // taken over: a name's number is how many of its lines the other filters
  // leave, so it says what ticking that name would show.
  const chatBeforeFrom = useMemo(() => {
    const needle = chatSearch.trim().toLowerCase();
    return chatMessages.filter((message) => {
      if (activeChannel && (message.to ?? "") !== activeChannel) return false;
      if (activeTransfers !== "show") {
        const transfer = isTransferMessage(message.message);
        if (activeTransfers === "hide" ? transfer : !transfer) return false;
      }
      if (!needle) return true;
      return message.message.toLowerCase().includes(needle)
        || message.sender.toLowerCase().includes(needle);
    });
  }, [activeChannel, activeTransfers, chatMessages, chatSearch]);
  const senders = useMemo(() => chatSenders(chatMessages, chatBeforeFrom), [chatMessages, chatBeforeFrom]);
  const filteredChat = useMemo(() => {
    if (chatFrom.length === 0) return chatBeforeFrom;
    const from = new Set(chatFrom);
    return chatBeforeFrom.filter((message) => from.has(message.sender));
  }, [chatBeforeFrom, chatFrom]);

  return {
    chatMessages, chatSearch, setChatSearch, chatFrom, setChatFrom, setChatChannel,
    setChatTransfers, rememberChat, chatChannels, hasTransfers, activeChannel, activeTransfers,
    senders, filteredChat
  };
}

export function ReplayChatPane({ chat }: { chat: ReturnType<typeof useReplayChat> }) {
  const { t } = useTranslation();
  const { chatMessages, chatSearch, setChatSearch, chatFrom, setChatFrom, setChatChannel,
    setChatTransfers, rememberChat, chatChannels, hasTransfers, activeChannel, activeTransfers,
    senders, filteredChat } = chat;
  return (
    <>
      <div className="replay-insights-toolbar">
        {/* Whose lines to read: tick one or several, nothing ticked
                    is everyone. Each name carries how many lines it wrote. */}
        {senders.length > 1 && (
          <MultiSelect
            layout="inline"
            label={t("replays.insights.from")}
            anyLabel={t("replays.insights.everyone")}
            options={senders.map((sender) => ({
              value: sender.name,
              label: sender.name,
              detail: String(sender.lines),
            }))}
            selected={chatFrom}
            onChange={setChatFrom}
          />
        )}
        {chatChannels.length > 1 && (
          <label className="replay-insights-filter">
            <span className="muted">{t("replays.insights.channel")}</span>
            <select
              className="vault-input"
              value={activeChannel}
              onChange={(event) => {
                setChatChannel(event.target.value);
                rememberChat({ replayChatChannel: event.target.value });
              }}
            >
              <option value="">{t("replays.insights.everyChannel")}</option>
              {chatChannels.map((channel) => (
                <option key={channel} value={channel}>{channelLabel(channel, t)}</option>
              ))}
            </select>
          </label>
        )}
        {/* Offered only where there is something to hide or keep. */}
        {hasTransfers && (
          <label className="replay-insights-filter" title={t("replays.insights.transfersHint")}>
            <span className="muted">{t("replays.insights.transfers")}</span>
            <select
              className="vault-input"
              value={activeTransfers}
              onChange={(event) => {
                const value = event.target.value as ReplayChatTransfers;
                setChatTransfers(value);
                rememberChat({ replayChatTransfers: value });
              }}
            >
              <option value="show">{t("replays.insights.transfersShow")}</option>
              <option value="hide">{t("replays.insights.transfersHide")}</option>
              <option value="only">{t("replays.insights.transfersOnly")}</option>
            </select>
          </label>
        )}
        <input
          type="search"
          className="vault-input replay-options-filter"
          placeholder={t("replays.insights.searchChat")}
          value={chatSearch}
          onChange={(event) => setChatSearch(event.target.value)}
        />
      </div>
      <div className="replay-table-scroll">
        <table className="replay-data-table">
          <thead>
            <tr>
              <th>{t("replays.detail.chatTime")}</th>
              <th>{t("replays.detail.chatSender")}</th>
              <th>{t("replays.insights.channel")}</th>
              <th>{t("replays.detail.chatMessage")}</th>
            </tr>
          </thead>
          <tbody>
            {filteredChat.length > 0 ? (
              filteredChat.map((message, index) => (
                <tr key={`${message.timeSeconds}-${message.sender}-${index}`}>
                  <td className="replay-chat-time">{formatChatTime(message.timeSeconds)}</td>
                  <td className="replay-chat-sender" title={message.sender}>{message.sender}</td>
                  <td className="muted">{channelLabel(message.to ?? "", t)}</td>
                  <td className="replay-chat-message">{message.message}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={4} className="replay-table-empty muted">
                  {t(chatMessages.length > 0
                    ? "replays.insights.noChatMatch"
                    : "replays.detail.noChat")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

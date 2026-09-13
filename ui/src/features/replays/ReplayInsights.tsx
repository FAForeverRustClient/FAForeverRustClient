// Everything a replay file says that the detail panel has no room for, in one
// overlay with tabs across the top.
//
// It used to be a button called "Load more info" that unfolded two tables
// underneath the panel, below the fold: the report was that you had to scroll
// for it and that what you found there was squeezed into a column. The three
// things it held (the game's options, its chat log, its simulation mods) are
// the same three things here, each with the width of the dialog to itself, plus
// the one the file has always carried and nothing ever read: how many orders
// each player gave.
//
// Deliberately not a second `Modal`: `Modal` closes on Escape from a
// bubble-phase document listener, so two stacked would close both at once. This
// takes Escape in the capture phase, the way the map preview next door does,
// and leaves the same three ways out: the button, the scrim and Escape.

import { useEffect, useMemo, useState } from "react";
import { Icon } from "../../design-system/Icon";
import { SectionTabs } from "../../design-system/SectionTabs";
import type { ReplayAnalysis, ReplayDetails, ReplayPlayer, ReplayTeam } from "../../ipc/bindings";
import { ReplayActivityChart } from "./ReplayActivityChart";
import { ReplayEventsPanel, ReplayPlayersPanel } from "./ReplayAnalysisPanels";
import { ReplayGameStats } from "./ReplayGameStats";
import { ReplayHeatmap } from "./ReplayHeatmap";
import { FactionIcon } from "../../shared/FactionIcon";
import { PlayerName } from "../../shared/nameColors";
import { formatDecimal, type MessageKey } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";
import { isObserverTeam } from "./ReplayRoster";

type InsightTab =
  | "options"
  | "chat"
  | "players"
  | "events"
  | "graph"
  | "heatmap"
  | "stats"
  | "mods";

/** The tabs that need the whole command stream rather than the cheap read. */
const ANALYSIS_TABS: ReadonlySet<InsightTab> = new Set<InsightTab>([
  "events",
  "graph",
  "heatmap",
  "stats",
]);

/**
 * What to call the channel a line was typed into.
 *
 * `all` and `allies` are the two the game names; anything else is the army
 * number a whisper went to, which is a number the reader has no way to resolve
 * and so reads as "whisper".
 */
function channelLabel(channel: string, t: (key: MessageKey) => string): string {
  if (channel === "all") return t("replays.insights.channelAll");
  if (channel === "allies") return t("replays.insights.channelAllies");
  if (!channel) return "";
  return t("replays.insights.channelWhisper");
}

/** `1:23:45`, the way the Java client stamps a line of replay chat. */
export function formatChatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * One row of the activity tab: what the stream counted, and who the lineup says
 * that was.
 */
interface ActivityRow {
  player: string;
  commands: number;
  /** Commands per minute of game time, or `null` for a game with no length. */
  perMinute: number | null;
  faction: number | null;
  rating: number | null;
  team: number | null;
}

/**
 * Join the command counts to the lineup.
 *
 * The two come from different places and agree on nothing but the login: the
 * counts are from the replay file's own client table, the lineup is the API's
 * record of the match (or the file's army table, for a local replay). Matching
 * is case-insensitive because the two do not always agree on capitals, and a
 * player the lineup does not know is still listed: an observer is in the file
 * and not in the lineup, and "who was watching" is worth seeing.
 */
export function activityRows(
  stats: NonNullable<ReplayDetails["commandStats"]>,
  teams: ReplayTeam[],
  simSeconds: number,
): ActivityRow[] {
  const byLogin = new Map<string, { player: ReplayPlayer; team: number }>();
  for (const team of teams) {
    for (const player of team.players) {
      byLogin.set(player.name.toLocaleLowerCase(), { player, team: team.team });
    }
  }
  const minutes = simSeconds / 60;
  return stats
    .map((entry) => {
      const found = byLogin.get(entry.player.toLocaleLowerCase());
      return {
        player: entry.player,
        commands: entry.commands,
        perMinute: minutes > 0 ? entry.commands / minutes : null,
        faction: found?.player.faction ?? null,
        rating: found?.player.rating ?? null,
        team: found?.team ?? null,
      };
    })
    .sort((left, right) => right.commands - left.commands);
}

export function ReplayInsights({
  details,
  analysis,
  analysisLoading,
  analysisError,
  teams,
  title,
  mapPreviewUrl,
  loading,
  error,
  onClose,
}: {
  /**
   * `null` until the replay file has been read.
   *
   * The panel opens on the click rather than on the answer. A vault replay
   * that is not on disk yet has to be downloaded first, and the button used to
   * sit there disabled with nothing else happening: "load more infos in
   * replays passiert lange zeit garnichts". It now opens immediately and says
   * what it is waiting for.
   */
  details: ReplayDetails | null;
  /**
   * The whole command stream, which is the expensive read.
   *
   * `null` until it lands, and it lands behind the details: the options and
   * the chat are what the panel opens on, and everything a reader has to wait
   * for is behind a tab that says it is still reading.
   */
  analysis: ReplayAnalysis | null;
  analysisLoading: boolean;
  analysisError: string;
  /** The lineup, for the faction and rating beside a command count. */
  teams: ReplayTeam[];
  /** The game being looked at, for the dialog's heading. */
  title: string;
  /** The map, for the heatmap to draw its cells over. */
  mapPreviewUrl?: string;
  loading: boolean;
  error: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<InsightTab>("options");
  const [optionFilter, setOptionFilter] = useState("");
  const [chatSearch, setChatSearch] = useState("");
  const [chatChannel, setChatChannel] = useState("");

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  // Absent on a file whose stream could not be walked, and on a legacy
  // `.scfareplay` with no header in front of it.
  const simMods = details?.simMods ?? [];
  const gameOptions = details?.gameOptions ?? [];
  // Memoised rather than defaulted inline: an empty array literal is a new
  // value on every render, and two of the filters below are keyed on it.
  const chatMessages = useMemo(() => details?.chatMessages ?? [], [details?.chatMessages]);
  const rows = useMemo(
    () => activityRows(details?.commandStats ?? [], teams, details?.simSeconds ?? 0),
    [details?.commandStats, details?.simSeconds, teams],
  );

  // The channels this game's chat actually used, so the filter offers what is
  // there. The Python client's tab has the same one, as four checkboxes.
  const chatChannels = useMemo(
    () => [...new Set(chatMessages.map((message) => message.to ?? "").filter(Boolean))].sort(),
    [chatMessages],
  );
  const filteredChat = useMemo(() => {
    const needle = chatSearch.trim().toLowerCase();
    return chatMessages.filter((message) => {
      if (chatChannel && (message.to ?? "") !== chatChannel) return false;
      if (!needle) return true;
      return message.message.toLowerCase().includes(needle)
        || message.sender.toLowerCase().includes(needle);
    });
  }, [chatChannel, chatMessages, chatSearch]);

  const filteredOptions = useMemo(() => {
    const options = details?.gameOptions ?? [];
    const query = optionFilter.trim().toLowerCase();
    if (!query) return options;
    return options.filter(
      (option) =>
        option.key.toLowerCase().includes(query) || option.value.toLowerCase().includes(query),
    );
  }, [details?.gameOptions, optionFilter]);

  // The busiest row, so the bars underneath the numbers are relative to the
  // game rather than to a scale nothing in it reaches.
  const busiest = rows.reduce((most, row) => Math.max(most, row.commands), 0);

  // Counts only once there is something to count: a tab reading "Chat 0"
  // while the file is still being read says the game had no chat.
  const count = (value: number) => (details ? value : undefined);
  const tabs = [
    { id: "options" as const, label: t("replays.detail.gameOptions"), count: count(gameOptions.length) },
    { id: "chat" as const, label: t("replays.detail.chat"), count: count(chatMessages.length) },
    { id: "players" as const, label: t("replays.insights.activity"), count: count(rows.length) },
    { id: "events" as const, label: t("replays.insights.events"), count: analysis?.notices.length },
    { id: "graph" as const, label: t("replays.insights.graph") },
    { id: "heatmap" as const, label: t("replays.insights.heatmap") },
    { id: "stats" as const, label: t("replays.insights.gameStats"), count: analysis?.stats.length },
    ...(simMods.length > 0
      ? [{ id: "mods" as const, label: t("replays.detail.simMods"), count: simMods.length }]
      : []),
  ];

  // A tab that needs the stream says so itself rather than leaving the reader
  // in front of an empty panel.
  const waitingForAnalysis = ANALYSIS_TABS.has(tab) && !analysis;
  const analysisNotice = waitingForAnalysis
    ? (
      analysisError
        ? <p className="replay-download-error surface-error">{analysisError}</p>
        : (
          <p className="replay-insights-loading muted">
            <Icon name="refresh" size={15} className="spin" />
            <span>{t(analysisLoading
              ? "replays.insights.walking"
              : "replays.insights.reading")}</span>
          </p>
        )
    )
    : null;

  return (
    <div className="replay-preview-scrim" role="presentation" onClick={onClose}>
      <div
        className="replay-insights"
        role="dialog"
        aria-label={t("replays.insights.aria", { name: title })}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="replay-insights-head">
          <div className="replay-insights-heading">
            <span className="replay-insights-kicker">{t("replays.insights.kicker")}</span>
            <h2 title={title}>{title}</h2>
          </div>
          <button
            type="button"
            className="replay-card-icon-btn"
            aria-label={t("replays.insights.close")}
            title={t("replays.insights.close")}
            onClick={onClose}
          >
            <Icon name="close" size={15} />
          </button>
        </header>

        <SectionTabs
          active={tab}
          ariaLabel={t("replays.insights.tabsAria")}
          items={tabs}
          onChange={setTab}
        />

        <div className="replay-insights-body">
          {/* One state for the whole panel while the file is on its way: the
              tabs are already there to be read, and putting the same spinner
              in each of them would say four different things are loading. */}
          {!details && (
            error
              ? <p className="replay-download-error surface-error">{error}</p>
              : (
                <p className="replay-insights-loading muted">
                  <Icon name="refresh" size={15} className="spin" />
                  <span>{t(loading ? "replays.insights.reading" : "replays.detail.loadingDetails")}</span>
                </p>
              )
          )}

          {analysisNotice}

          {analysis && tab === "events" && <ReplayEventsPanel analysis={analysis} />}
          {analysis && tab === "graph" && <ReplayActivityChart analysis={analysis} />}
          {analysis && tab === "heatmap" && (
            <ReplayHeatmap analysis={analysis} mapPreviewUrl={mapPreviewUrl} />
          )}
          {analysis && tab === "stats" && <ReplayGameStats stats={analysis.stats} />}

          {/* The lineup and their rates. Drawn from the stream once it is
              here, because that is where a player's colour, faction and own
              last action come from; from the cheap read until then, which
              knows the names and the counts. */}
          {analysis && tab === "players" && <ReplayPlayersPanel analysis={analysis} />}

          {!analysis && details && tab === "players" && (
            rows.length === 0 ? (
              <p className="replay-detail-empty muted">{t("replays.insights.noActivity")}</p>
            ) : (
              <>
                {/* Said once, above the table, rather than implied by a column
                    heading nobody can interrogate. The number is honest about
                    what it counts and the reader can decide what it is worth:
                    a hotkey that reissues an order counts twice, and one click
                    onto forty units counts once. */}
                <p className="replay-insights-note muted">
                  <Icon name="info" size={13} />
                  <span>{t("replays.insights.explainer")}</span>
                </p>
                <div className="replay-table-scroll">
                  <table className="replay-data-table replay-activity-table">
                    <thead>
                      <tr>
                        <th>{t("replays.insights.player")}</th>
                        <th>{t("replays.detail.avgRating")}</th>
                        <th>{t("replays.insights.commands")}</th>
                        <th>{t("replays.insights.perMinute")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr key={row.player}>
                          <td className="replay-activity-player">
                            {row.team !== null && !isObserverTeam(row.team) && row.faction ? (
                              <FactionIcon className="replay-player-faction" faction={row.faction} size={14} />
                            ) : (
                              <span className="replay-player-faction replay-player-faction-empty" aria-hidden />
                            )}
                            <PlayerName name={row.player} />
                          </td>
                          <td>{row.rating === null ? "N/A" : row.rating}</td>
                          <td className="replay-activity-count">{row.commands}</td>
                          <td>
                            <span className="replay-activity-rate">
                              <span className="replay-activity-rate-value">
                                {row.perMinute === null ? "N/A" : formatDecimal(row.perMinute)}
                              </span>
                              {/* The bar is the comparison the table is for:
                                  the numbers alone need reading twice to see
                                  who was twice as busy as whom. */}
                              <span
                                className="replay-activity-bar"
                                aria-hidden
                                style={{ width: busiest > 0 ? `${(row.commands / busiest) * 100}%` : "0%" }}
                              />
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )
          )}

          {details && tab === "chat" && (
            <>
              <div className="replay-insights-toolbar">
                {chatChannels.length > 1 && (
                  <label className="replay-insights-filter">
                    <span className="muted">{t("replays.insights.channel")}</span>
                    <select
                      className="vault-input"
                      value={chatChannel}
                      onChange={(event) => setChatChannel(event.target.value)}
                    >
                      <option value="">{t("replays.insights.everyChannel")}</option>
                      {chatChannels.map((channel) => (
                        <option key={channel} value={channel}>{channelLabel(channel, t)}</option>
                      ))}
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
          )}

          {details && tab === "options" && (
            <>
              <div className="replay-insights-toolbar">
                <input
                  type="search"
                  className="vault-input replay-options-filter"
                  placeholder={t("replays.detail.filterOptions")}
                  value={optionFilter}
                  onChange={(event) => setOptionFilter(event.target.value)}
                />
              </div>
              <div className="replay-table-scroll">
                <table className="replay-data-table replay-options-table">
                  <thead>
                    <tr>
                      <th>{t("replays.detail.optionName")}</th>
                      <th>{t("replays.detail.optionValue")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredOptions.length > 0 ? (
                      filteredOptions.map((option) => (
                        <tr key={option.key}>
                          <td><strong>{option.key}</strong></td>
                          <td>{option.value}</td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={2} className="replay-table-empty muted">
                          {t("replays.detail.noOptionsMatch")}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {details && tab === "mods" && (
            <ul className="replay-sim-mod-list">
              {simMods.map((mod) => (
                <li key={mod} className="surface-chip">{mod}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

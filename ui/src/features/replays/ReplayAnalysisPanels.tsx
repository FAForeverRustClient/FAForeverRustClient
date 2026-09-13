// Two of the analysis panels: who did how much, and what the game announced
// while they were doing it.
//
// Both are the Python client's own tabs (`maintab.py` and `events_tab.py` in
// FAForever/client), drawn as tables rather than as the HTML that client builds
// and without its icon sheets: the enhancement pictures are game assets this
// client does not ship, so an upgrade is named rather than drawn.

import { useMemo, useState } from "react";
import { Icon } from "../../design-system/Icon";
import type { ReplayAnalysis } from "../../ipc/bindings";
import { FactionIcon } from "../../shared/FactionIcon";
import { PlayerName } from "../../shared/nameColors";
import { formatDecimal } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";
import { analysedPlayers, formatGameTime, playerColor } from "./replayAnalysis";

/**
 * The lineup, with what each player did in the game.
 *
 * The Python client puts this beside the map preview on its info tab: colour,
 * faction, country, rating and commands per minute, by team.
 */
export function ReplayPlayersPanel({ analysis }: { analysis: ReplayAnalysis }) {
  const { t } = useTranslation();
  const players = useMemo(() => analysedPlayers(analysis), [analysis]);
  const busiest = players.reduce((most, player) => Math.max(most, player.commands), 0);

  if (players.length === 0) {
    return <p className="replay-detail-empty muted">{t("replays.insights.noActivity")}</p>;
  }

  return (
    <>
      <p className="replay-insights-note muted">
        <Icon name="info" size={13} />
        <span>{t("replays.insights.explainer")}</span>
      </p>
      <div className="replay-table-scroll">
        <table className="replay-data-table replay-activity-table">
          <thead>
            <tr>
              <th>{t("replays.insights.player")}</th>
              <th>{t("replays.roster.team")}</th>
              <th>{t("replays.detail.avgRating")}</th>
              <th>{t("replays.insights.commands")}</th>
              <th>{t("replays.insights.perMinute")}</th>
              <th>{t("replays.insights.lastAction")}</th>
            </tr>
          </thead>
          <tbody>
            {players.map((player) => (
              <tr key={`${player.source}-${player.name}`}>
                {/* The swatch, the faction glyph and the name are laid out by
                    a span inside the cell rather than by the cell itself. A
                    `td` told to be a flex container stops being a table cell:
                    the row's collapsed border then breaks at that column --
                    the line under Player did not meet the one under Team --
                    and the glyphs, no longer measured by the table, sat on
                    top of the name they belong to. */}
                <td>
                  <span className="replay-activity-player">
                    {/* The colour this player was on the map, which is the one
                        thing a replay carries that nothing else in this client
                        shows. */}
                    <span
                      className="replay-activity-swatch"
                      style={{ background: player.color }}
                      aria-hidden
                    />
                    {player.faction > 0 && player.faction < 5 ? (
                      <FactionIcon className="replay-player-faction" faction={player.faction} size={14} />
                    ) : (
                      <span className="replay-player-faction replay-player-faction-empty" aria-hidden />
                    )}
                    <PlayerName name={player.name} />
                    {player.country && (
                      <span className="replay-activity-country muted">{player.country.toUpperCase()}</span>
                    )}
                  </span>
                </td>
                <td>{player.team > 1 ? player.team - 1 : t("replays.roster.freeForAll")}</td>
                <td>{player.rating === null ? "N/A" : player.rating}</td>
                <td className="replay-activity-count">{player.commands}</td>
                <td>
                  <span className="replay-activity-rate">
                    <span className="replay-activity-rate-value">
                      {player.perMinute === null ? "N/A" : formatDecimal(player.perMinute)}
                    </span>
                    <span
                      className="replay-activity-bar"
                      aria-hidden
                      style={{ width: busiest > 0 ? `${(player.commands / busiest) * 100}%` : "0%" }}
                    />
                  </span>
                </td>
                <td>{formatGameTime(player.lastTick)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/**
 * What the in-game notification mod announced, as a timeline.
 *
 * These are not chat. The game sends them through the same callback with the
 * channel set to `notify`, which is how a client knows that somebody started or
 * finished an upgrade without watching the game. The Python client turns each
 * into an icon; this names it, because the pictures are the game's own assets.
 */
export function ReplayEventsPanel({ analysis }: { analysis: ReplayAnalysis }) {
  const { t } = useTranslation();
  const [player, setPlayer] = useState("");
  const bySource = useMemo(
    () => new Map(analysis.armies.map((army) => [army.source, army])),
    [analysis.armies],
  );
  const events = useMemo(
    () => analysis.notices.filter((notice) => {
      if (!player) return true;
      return bySource.get(notice.source)?.name === player;
    }),
    [analysis.notices, bySource, player],
  );

  if (analysis.notices.length === 0) {
    return <p className="replay-detail-empty muted">{t("replays.insights.noEvents")}</p>;
  }

  return (
    <>
      <div className="replay-insights-toolbar">
        <label className="replay-insights-filter">
          <span className="muted">{t("replays.insights.player")}</span>
          <select
            className="vault-input"
            value={player}
            onChange={(event) => setPlayer(event.target.value)}
          >
            <option value="">{t("replays.insights.everyone")}</option>
            {analysis.armies.map((army) => (
              <option key={`${army.source}-${army.name}`} value={army.name}>{army.name}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="replay-table-scroll">
        <table className="replay-data-table">
          <thead>
            <tr>
              <th>{t("replays.detail.chatTime")}</th>
              <th>{t("replays.insights.player")}</th>
              <th>{t("replays.insights.event")}</th>
            </tr>
          </thead>
          <tbody>
            {events.length > 0 ? (
              events.map((notice, index) => {
                const army = bySource.get(notice.source);
                return (
                  <tr key={`${notice.tick}-${notice.source}-${index}`}>
                    <td className="replay-chat-time">{formatGameTime(notice.tick)}</td>
                    <td>
                      <span className="replay-activity-player">
                        {army && (
                          <span
                            className="replay-activity-swatch"
                            style={{ background: playerColor(army.color) }}
                            aria-hidden
                          />
                        )}
                        <span>{army?.name ?? t("replays.insights.unknownPlayer")}</span>
                      </span>
                    </td>
                    <td>{notice.text}</td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan={3} className="replay-table-empty muted">
                  {t("replays.insights.noEventsForPlayer")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

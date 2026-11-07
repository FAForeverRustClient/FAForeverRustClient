// Two of the analysis panels: who did how much, and what the game announced
// while they were doing it.
//
// The summary is drawn as a table. The event panel is kept separately and
// reads its unit and enhancement pictures from the installed game.

import { useMemo } from "react";
import { Icon } from "../../../design-system/Icon";
import type { ReplayAnalysis } from "../../../ipc/bindings";
import { FactionIcon } from "../../../shared/components/FactionIcon";
import { PlayerName } from "../../../shared/components/nameColors";
import { formatDecimal } from "../../../i18n";
import { useTranslation } from "../../../i18n/useTranslation";
import { analysedPlayers, formatGameTime } from "./replayAnalysis";

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
                <td>{player.rating === null ? t("common.notAvailable") : player.rating}</td>
                <td className="replay-activity-count">{player.commands}</td>
                <td>
                  <span className="replay-activity-rate">
                    <span className="replay-activity-rate-value">
                      {player.perMinute === null ? t("common.notAvailable") : formatDecimal(player.perMinute)}
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

export { ReplayEventsPanel } from "./ReplayEventsPanel";

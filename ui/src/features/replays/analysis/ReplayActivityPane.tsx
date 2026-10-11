import { Icon } from "../../../design-system/Icon";
import { FactionIcon } from "../../../shared/components/FactionIcon";
import { PlayerName } from "../../../shared/components/nameColors";
import { formatDecimal } from "../../../i18n";
import { useTranslation } from "../../../i18n/useTranslation";
import { isObserverTeam } from "../ReplayRoster";
import type { ActivityRow } from "./replayInsightRows";

export function ReplayActivityPane({ rows }: { rows: ActivityRow[] }) {
  const { t } = useTranslation();
  const busiest = rows.reduce((most, row) => Math.max(most, row.commands), 0);
  return (
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
                  <td>
                    <span className="replay-activity-player">
                      {row.team !== null && !isObserverTeam(row.team) && row.faction ? (
                        <FactionIcon className="replay-player-faction" faction={row.faction} size={14} />
                      ) : (
                        <span className="replay-player-faction replay-player-faction-empty" aria-hidden />
                      )}
                      <PlayerName name={row.player} />
                    </span>
                  </td>
                  <td>{row.rating === null ? t("common.notAvailable") : row.rating}</td>
                  <td className="replay-activity-count">{row.commands}</td>
                  <td>
                    <span className="replay-activity-rate">
                      <span className="replay-activity-rate-value">
                        {row.perMinute === null ? t("common.notAvailable") : formatDecimal(row.perMinute)}
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
  );
}

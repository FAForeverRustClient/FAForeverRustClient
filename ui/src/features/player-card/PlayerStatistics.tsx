import type { ReactNode } from "react";
import type { PlayerCardProfile } from "../../ipc/bindings";
import { FactionIcon } from "../../shared/components/FactionIcon";
import { factionLabel } from "../../shared/factions";
import { formatNumber, type MessageKey } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";

const EVENTS = {
  airBuilt: "3ebb0c4d-5e92-4446-bf52-d17ba9c5cd3c",
  airLost: "225e9b2e-ae09-4ae1-a198-eca8780b0fcd",
  landBuilt: "ea123d7f-bb2e-4a71-bd31-88859f0c3c00",
  landLost: "a1a3fd33-abe2-4e56-800a-b72f4c925825",
  navalBuilt: "b5265b42-1747-4ba1-936c-292202637ce6",
  navalLost: "3a7b3667-0f79-4ac7-be63-ba841fd5ef05",
  tech1Built: "a8ee4f40-1e30-447b-bc2c-b03065219795",
  tech1Lost: "3dd3ed78-ce78-4006-81fd-10926738fbf3",
  tech2Built: "89d4f391-ed2d-4beb-a1ca-6b93db623c04",
  tech2Lost: "aebd750b-770b-4869-8e37-4d4cfdc480d0",
  tech3Built: "92617974-8c1f-494d-ab86-65c2a95d1486",
  tech3Lost: "7f15c2be-80b7-4573-8f41-135f84773e0f",
  engineersBuilt: "60bb1fc0-601b-45cd-bd26-83b1a1ac979b",
  engineersLost: "e8e99a68-de1b-4676-860d-056ad2207119",
  experimentalsBuilt: "ed9fd79d-5ec7-4243-9ccf-f18c4f5baef1",
  experimentalsLost: "701ca426-0943-4931-85af-6a08d36d9aaa",
  aeonPlays: "96ccc66a-c5a0-4f48-acaa-888b00778b57",
  aeonWins: "a6b51c26-64e6-4e7a-bda7-ea1cfe771ebb",
  cybranPlays: "ad193982-e7ca-465c-80b0-5493f9739559",
  cybranWins: "56b06197-1890-42d0-8b59-25e1add8dc9a",
  uefPlays: "1b900d26-90d2-43d0-a64e-ed90b74c3704",
  uefWins: "7be6fdc5-7867-4467-98ce-f7244a66625a",
  seraphimPlays: "fefcb392-848f-4836-9683-300b283bc308",
  seraphimWins: "15b6c19a-6084-4e82-ada9-6c30e282191f",
} as const;

interface Metric {
  label: string;
  /** Drawn before the label, for a row that has a mark of its own. */
  icon?: ReactNode;
  first: number;
  second: number;
}

/**
 * A chart as a small table: the name, one bar, then the two counts and the
 * share of the first.
 *
 * It was two bars per row with each count printed inside its bar, in dark
 * text on saturated green and red at the smallest size the client allows, and
 * moved outside the bar whenever the bar was too short to hold it. The counts
 * now sit in columns of their own in the text colour, where they line up and
 * read at a glance; the bar only shows the proportions. One stacked bar per
 * row rather than two, so its length is the row's total against the largest
 * total and the split inside it is the ratio, which is what the two separate
 * bars made the reader work out.
 *
 * `share` is for a count that has no opposite of its own. FAF records games
 * played and games won, per faction and per queue, and nothing about draws,
 * so "played minus won" is losses and draws together and no honest name fits
 * it. Those charts show wins against the total instead: the second column is
 * the games themselves and the rest of the bar is neutral rather than red.
 */
function MetricChart({ title, firstLabel, secondLabel, rateLabel, metrics, share = false }: {
  title: string;
  firstLabel: string;
  secondLabel: string;
  rateLabel: string;
  metrics: Metric[];
  share?: boolean;
}) {
  const max = Math.max(1, ...metrics.map((metric) => metric.first + metric.second));
  return (
    <section className="player-stats-chart surface-panel">
      <h3>{title}</h3>
      <div className="player-metric-table" role="table" aria-label={title}>
        <div className="player-metric-head" role="row">
          <span role="columnheader" />
          <span role="columnheader" />
          <span role="columnheader"><i className="is-first" aria-hidden />{firstLabel}</span>
          <span role="columnheader">{!share && <i className="is-second" aria-hidden />}{secondLabel}</span>
          <span role="columnheader">{rateLabel}</span>
        </div>
        {metrics.map((metric) => {
          const total = metric.first + metric.second;
          return (
            <div className="player-metric" role="row" key={metric.label}>
              <span className="player-metric-label" role="rowheader">{metric.icon}{metric.label}</span>
              <span className="player-metric-bar" role="cell" aria-hidden>
                {total > 0 && (
                  <span style={{ width: `${(total / max) * 100}%` }}>
                    <span className="is-first" style={{ flexGrow: metric.first }} />
                    <span className={share ? "is-rest" : "is-second"} style={{ flexGrow: metric.second }} />
                  </span>
                )}
              </span>
              <span className="player-metric-count" role="cell">{formatNumber(metric.first)}</span>
              <span className="player-metric-count" role="cell">{formatNumber(share ? total : metric.second)}</span>
              <span className="player-metric-rate" role="cell">
                {total > 0 ? `${Math.round((metric.first / total) * 100)}%` : "N/A"}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// The number is the faction's id: its emblem and, through the catalog, its
// name. The unit classes carry a message key.
const FACTIONS: Array<[number, string, string]> = [
  [2, EVENTS.aeonPlays, EVENTS.aeonWins],
  [3, EVENTS.cybranPlays, EVENTS.cybranWins],
  [1, EVENTS.uefPlays, EVENTS.uefWins],
  [4, EVENTS.seraphimPlays, EVENTS.seraphimWins],
];

const UNITS: Array<[MessageKey, string, string]> = [
  ["playerCard.stats.unit.air", EVENTS.airBuilt, EVENTS.airLost],
  ["playerCard.stats.unit.land", EVENTS.landBuilt, EVENTS.landLost],
  ["playerCard.stats.unit.naval", EVENTS.navalBuilt, EVENTS.navalLost],
  ["playerCard.stats.unit.tech1", EVENTS.tech1Built, EVENTS.tech1Lost],
  ["playerCard.stats.unit.tech2", EVENTS.tech2Built, EVENTS.tech2Lost],
  ["playerCard.stats.unit.tech3", EVENTS.tech3Built, EVENTS.tech3Lost],
  ["playerCard.stats.unit.engineers", EVENTS.engineersBuilt, EVENTS.engineersLost],
  ["playerCard.stats.unit.experimentals", EVENTS.experimentalsBuilt, EVENTS.experimentalsLost],
];

export function PlayerStatistics({ profile }: { profile: PlayerCardProfile }) {
  const { t } = useTranslation();
  const counts = new Map(profile.events.map((event) => [event.eventId, event.count]));
  const count = (id: string) => counts.get(id) ?? 0;
  const factions = FACTIONS.map(([faction, plays, wins]) => ({
    label: factionLabel(faction),
    // The name beside it says which faction, so the emblem is decoration to
    // a screen reader.
    icon: <FactionIcon faction={faction} size={16} aria-hidden="true" role="presentation" />,
    first: count(wins),
    second: Math.max(0, count(plays) - count(wins)),
  }));
  const units = UNITS.map(([label, built, lost]) => ({
    label: t(label),
    first: Math.max(0, count(built) - count(lost)),
    second: count(lost),
  }));
  const games = profile.ratings.map((rating) => ({
    label: leaderboardLabel(rating.technicalName),
    first: rating.wonGames,
    second: Math.max(0, rating.gamesPlayed - rating.wonGames),
  }));

  return (
    <div className="player-statistics-grid">
      {/* Wins out of games, not wins against losses: see `share`. */}
      <MetricChart share title={t("playerCard.stats.factionsTitle")} firstLabel={t("playerCard.stats.wins")} secondLabel={t("playerCard.stats.games")} rateLabel={t("playerCard.stats.winRate")} metrics={factions} />
      <MetricChart share title={t("playerCard.stats.queuesTitle")} firstLabel={t("playerCard.stats.wins")} secondLabel={t("playerCard.stats.games")} rateLabel={t("playerCard.stats.winRate")} metrics={games} />
      <MetricChart title={t("playerCard.stats.unitsTitle")} firstLabel={t("playerCard.stats.survived")} secondLabel={t("playerCard.stats.lost")} rateLabel={t("playerCard.stats.survivalRate")} metrics={units} />
    </div>
  );
}

// Per-map record for one player.
//
// The profile already reports games and wins *per leaderboard* and plays and
// wins *per faction*, so neither is repeated here. What was missing is the
// question a host actually asks before starting a game: how much has this
// player played the map I am about to host, and how did it go?

import { useEffect, useMemo, useState } from "react";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { formatNumber } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";
import { MapThumbnail } from "../../shared/MapThumbnail";
import { formatDateTime } from "../../shared/dates";

interface Props {
  playerId: number;
}

/** Win rate in whole percent, or `null` when nothing has been decided. */
function winRate(wins: number, losses: number): number | null {
  const decided = wins + losses;
  return decided > 0 ? Math.round((wins / decided) * 100) : null;
}

export function PlayerMapStatistics({ playerId }: Props) {
  const { t } = useTranslation();
  const stats = useAppStore((state) => state.state.playerCard.mapStats);
  // The vault supplies map art; without it every thumbnail is a placeholder.
  const vault = useAppStore((state) => state.state.maps.vault);
  const status = useAppStore((state) => state.state.playerCard.mapStatsStatus);
  const error = useAppStore((state) => state.state.playerCard.mapStatsError);
  const [search, setSearch] = useState("");

  // Loaded when this tab is opened rather than with the profile: the scan walks
  // the player's entire history, and someone who only wanted their rating
  // should not pay for it.
  useEffect(() => {
    ipc.send({ kind: "PlayerCard", command: { type: "loadMapStats", payload: { playerId } } });
  }, [playerId]);

  const generatedLabel = t("playerCard.maps.generated");
  const label = (entry: { map: string; generated: boolean }) =>
    entry.generated ? generatedLabel : entry.map;

  const maps = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const all = stats?.maps ?? [];
    if (!query) return all;
    return all.filter((entry) =>
      (entry.generated ? generatedLabel : entry.map).toLocaleLowerCase().includes(query),
    );
  }, [generatedLabel, search, stats]);

  if (status === "loading") {
    return <div className="player-card-empty muted">{t("playerCard.maps.loading")}</div>;
  }
  if (status === "failed") {
    return <div className="player-card-empty muted">{error || t("playerCard.maps.failed")}</div>;
  }
  if (!stats || stats.totalGames === 0) {
    return <div className="player-card-empty muted">{t("playerCard.maps.empty")}</div>;
  }

  const overall = winRate(stats.wins, stats.losses);

  return (
    <div className="player-maps-view">
      <div className="player-maps-summary surface-panel">
        <div className="player-maps-figure">
          <span className="player-maps-value">{formatNumber(stats.totalGames)}</span>
          <span className="player-maps-label">{t("playerCard.maps.gamesTotal")}</span>
        </div>
        <div className="player-maps-figure">
          <span className="player-maps-value">
            {overall === null ? "–" : `${overall}%`}
          </span>
          <span className="player-maps-label">{t("playerCard.maps.winRate")}</span>
        </div>
        <div className="player-maps-figure">
          <span className="player-maps-value">
            {formatNumber(stats.wins)} / {formatNumber(stats.losses)}
          </span>
          <span className="player-maps-label">{t("playerCard.maps.record")}</span>
        </div>
        <div className="player-maps-figure">
          <span className="player-maps-value">{formatNumber(stats.maps.length)}</span>
          <span className="player-maps-label">{t("playerCard.maps.distinctMaps")}</span>
        </div>
      </div>

      {/* Said plainly rather than hidden: the numbers cover a prefix of the
          history, and a reader comparing them to the profile deserves to know. */}
      {stats.truncated && (
        <p className="player-maps-note muted">{t("playerCard.maps.truncated")}</p>
      )}

      {/* Without this the header and the table simply disagree, with nothing to
          explain the gap. Locally generated maps are the usual reason: the API
          has no map to point at, so the game counts but lands in no row. */}
      {stats.unattributed > 0 && (
        <p className="player-maps-note muted">
          {t("playerCard.maps.unattributed", { count: stats.unattributed })}
        </p>
      )}

      <div className="search-field player-maps-search">
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t("playerCard.maps.searchPlaceholder")}
          aria-label={t("playerCard.maps.searchAria")}
        />
      </div>

      <table className="surface-panel player-maps-table">
        <thead>
          <tr>
            <th>{t("playerCard.maps.map")}</th>
            <th>{t("playerCard.maps.games")}</th>
            <th>{t("playerCard.maps.record")}</th>
            <th>{t("playerCard.maps.winRate")}</th>
            <th>{t("playerCard.maps.lastPlayed")}</th>
          </tr>
        </thead>
        <tbody>
          {maps.map((entry) => {
            const rate = winRate(entry.wins, entry.losses);
            return (
              <tr key={entry.generated ? "@generated" : entry.map}>
                <td className="player-maps-name">
                  <span className="player-maps-map">
                    <MapThumbnail
                      mapName={entry.map}
                      vault={vault}
                      className="player-maps-thumb"
                      placeholderClassName="player-maps-thumb player-maps-thumb-empty"
                    />
                    <span className="player-maps-map-name" title={label(entry)}>
                      {label(entry)}
                    </span>
                  </span>
                </td>
                <td>{formatNumber(entry.games)}</td>
                <td>
                  {formatNumber(entry.wins)} / {formatNumber(entry.losses)}
                </td>
                <td>{rate === null ? "–" : `${rate}%`}</td>
                <td>{entry.lastPlayed ? formatDateTime(entry.lastPlayed) : "–"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {maps.length === 0 && <p className="muted">{t("playerCard.maps.noMatch")}</p>}
    </div>
  );
}

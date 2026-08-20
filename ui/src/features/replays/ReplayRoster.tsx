import { Fragment } from "react";
import { Icon } from "../../design-system/Icon";
import type { ReplayPlayer, ReplayTeam } from "../../ipc/bindings";
import { FactionIcon } from "../../shared/FactionIcon";
import { openPlayerCard } from "../player-card/playerCardActions";
import { t } from "../../i18n";
import { useLocale } from "../../i18n/useTranslation";
import { PlayerName } from "../../shared/nameColors";

// Team 1 is the FAF server's "no team" bucket. Calling that "No team" reads as
// missing data; for a game where it holds everyone it is simply a free-for-all,
// which is what the Java client's lineup shows too.
function teamName(team: number, soleTeam: boolean): string {
  if (team < 0) return t("replays.roster.observers");
  if (team > 1) return `Team ${team - 1}`;
  return soleTeam ? t("replays.roster.freeForAll") : t("replays.roster.unassigned");
}

export function isObserverTeam(team: number): boolean {
  return team < 0;
}

function ReplayPlayerMarker({ player, observer, size }: { player: ReplayPlayer; observer: boolean; size: number }) {
  if (observer) {
    return (
      <span className="replay-player-faction replay-player-observer" title={t("replays.roster.observer")} aria-label={t("replays.roster.observer")}>
        <Icon name="eye" size={size} />
      </span>
    );
  }
  return player.faction ? (
    <FactionIcon className="replay-player-faction" faction={player.faction} size={size} />
  ) : null;
}

export type OutcomeKind = "victory" | "defeat" | "draw" | "";

export function parseOutcome(outcome: string): OutcomeKind {
  switch (outcome.toLocaleUpperCase()) {
    case "VICTORY": return "victory";
    case "DEFEAT": return "defeat";
    case "DRAW":
    case "MUTUAL_DRAW": return "draw";
    default: return "";
  }
}

export function outcomeLabel(outcome: string): string {
  const kind = parseOutcome(outcome);
  switch (kind) {
    case "victory": return t("replays.roster.victory");
    case "defeat": return t("replays.roster.defeat");
    case "draw": return t("replays.roster.draw");
    default: return "";
  }
}

export function ReplayCardRoster({ teams }: { teams: ReplayTeam[] }) {
  useLocale();
  if (teams.length === 0) return null;
  const soleTeam = teams.filter((team) => !isObserverTeam(team.team)).length === 1;
  return (
    <div className="replay-card-teams">
      {teams.map((team) => {
        const observer = isObserverTeam(team.team);
        return (
          <section key={team.team} className="replay-card-team">
            <header className="replay-card-team-title">
              <span>{teamName(team.team, soleTeam)}</span>
              <span>
                {team.players.length} {observer
                  ? (team.players.length === 1 ? "observer" : "observers")
                  : (team.players.length === 1 ? "player" : "players")}
              </span>
            </header>
            {team.players.map((player) => (
              <div key={player.name} className="replay-player">
                <span className="replay-player-identity">
                  <ReplayPlayerMarker player={player} observer={observer} size={17} />
                  <PlayerName name={player.name} />
                </span>
                {player.rating !== null && <span className="muted">{player.rating}</span>}
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}

export function ReplayDetailRoster({
  teams,
  showResults = false,
}: {
  teams: ReplayTeam[];
  showResults?: boolean;
}) {
  useLocale();
  if (teams.length === 0) return null;
  const soleTeam = teams.filter((team) => !isObserverTeam(team.team)).length === 1;
  // Two teams get a versus divider between them, the way both reference clients
  // present a matchup. More than two is a grid, because a chain of "vs" reads
  // as a bracket rather than a lineup.
  const versus = teams.length === 2 && teams.every((team) => !isObserverTeam(team.team));
  return (
    <div className="replay-detail-teams" data-layout={versus ? "versus" : undefined}>
      {teams.map((team, index) => {
        const observer = isObserverTeam(team.team);
        const ratings = observer
          ? []
          : team.players.flatMap((player) => player.rating === null ? [] : [player.rating]);
        const teamRating = ratings.length === 0
          ? null
          : ratings.reduce((sum, rating) => sum + rating, 0);
        const outcomeKind = observer
          ? ""
          : team.players.map((player) => parseOutcome(player.outcome)).find(Boolean) ?? "";
        const outcomeText = outcomeKind ? outcomeLabel(outcomeKind) : "";
        return (
          <Fragment key={team.team}>
            {versus && index === 1 && <span className="replay-detail-versus" aria-hidden>vs</span>}
            <section className="replay-detail-team surface-panel">
              <header className="replay-detail-team-title">
                <span>{teamName(team.team, soleTeam)}</span>
                <span className="replay-detail-team-summary">
                  {teamRating !== null && (
                    <span title={t("replays.roster.combinedRating")}>{teamRating} rating</span>
                  )}
                  {showResults && outcomeKind && (
                    <span className={`replay-team-outcome ${outcomeKind}`}>{outcomeText}</span>
                  )}
                </span>
              </header>
              <div className="replay-detail-roster">
                {team.players.map((player) => (
                  <div key={player.name} className="replay-detail-player">
                    <button
                      type="button"
                      className="replay-player-identity replay-player-link"
                      title={`Open ${player.name}'s profile`}
                      onClick={() => openPlayerCard(null, player.name)}
                    >
                      {observer || player.faction ? (
                        <ReplayPlayerMarker player={player} observer={observer} size={18} />
                      ) : (
                        <span className="replay-player-faction replay-player-faction-empty" aria-hidden />
                      )}
                      <PlayerName name={player.name} />
                    </button>
                    <span className="replay-player-stats">
                      {player.rating !== null && (
                        <span className="replay-player-rating" title={t("replays.roster.rating") || "Rating"}>
                          {player.rating}
                        </span>
                      )}
                      {showResults && player.score !== null && (
                        <span
                          className={`replay-player-score ${
                            player.score > 0 ? "positive" : player.score < 0 ? "negative" : "zero"
                          }`}
                          title={`${t("replays.roster.score") || "Score"}: ${player.score}`}
                        >
                          {player.score > 0
                            ? `+${new Intl.NumberFormat("en-US").format(player.score)}`
                            : new Intl.NumberFormat("en-US").format(player.score)}
                        </span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          </Fragment>
        );
      })}
    </div>
  );
}

export function playerCount(teams: ReplayTeam[]): number {
  return teams.reduce((sum, team) => sum + (isObserverTeam(team.team) ? 0 : team.players.length), 0);
}

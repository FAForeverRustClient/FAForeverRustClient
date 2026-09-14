import { Fragment } from "react";
import { Icon } from "../../design-system/Icon";
import type { LocalReplayTeam, ReplayPlayer, ReplayTeam } from "../../ipc/bindings";
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
  if (soleTeam) {
    return team === 1 ? t("replays.roster.freeForAll") : t("replays.roster.players");
  }
  if (team > 1) return `Team ${team - 1}`;
  return t("replays.roster.unassigned");
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

/**
 * One team's result, by the priority Java's `calculateTeamOutcome` uses:
 * a victory anywhere in the team wins, then a draw, then a defeat, and only a
 * team where nobody has a recorded outcome is unknown.
 *
 * Taking the first player who happens to have one, as this did, is not the
 * same thing: the roster is in server order, so a team-mate who resigned early
 * could put "Defeat" on the team that won.
 */
export function teamOutcome(players: ReplayPlayer[]): OutcomeKind | "unknown" {
  const kinds = players.map((player) => parseOutcome(player.outcome)).filter(Boolean);
  if (kinds.includes("victory")) return "victory";
  if (kinds.includes("draw")) return "draw";
  if (kinds.includes("defeat")) return "defeat";
  return "unknown";
}

/**
 * Local replay headers can contain the exact rating even when the vault
 * response has no rating journal included. Keep the richer vault player data
 * and fill only values that are missing from it.
 */
export function mergeReplayTeamsWithLocal(
  teams: ReplayTeam[],
  localTeams?: LocalReplayTeam[],
): ReplayTeam[] {
  if (!localTeams || localTeams.length === 0) return teams;
  const localByTeam = new Map(localTeams.map((team) => [team.team, team]));
  // The JSON header uses the engine's team numbers, while the vault API can
  // use a different offset for the same teams. Player names are the stable
  // identity across both sources, so keep a fallback index as well.
  const localByPlayer = new Map(
    localTeams.flatMap((team) =>
      team.players.map((player) => [player.name.toLocaleLowerCase(), player] as const),
    ),
  );
  const enriched = teams.map((team) => {
    const localTeam = localByTeam.get(String(team.team));
    return {
      ...team,
      players: team.players.map((player) => {
        const key = player.name.toLocaleLowerCase();
        const localPlayer = localTeam?.players.find(
          (candidate) => candidate.name.toLocaleLowerCase() === key,
        ) ?? localByPlayer.get(key);
        if (!localPlayer) return player;
        return {
          ...player,
          faction: player.faction ?? localPlayer.faction,
          rating: player.rating ?? localPlayer.rating,
        };
      }),
    };
  });

  // Everyone the file has and the listing does not, which in practice means
  // the AI. The vault's roster is `playerStats`, one row per account, so a
  // game against three AI arrives from the server as a lineup of one; the
  // replay's own army table has all four. The grid card reads that table
  // directly and showed them, the panel took the server's list and did not,
  // and the same game therefore had two different lineups depending on where
  // you looked at it.
  const online = new Set(
    enriched.flatMap((team) => team.players.map((player) => player.name.toLocaleLowerCase())),
  );

  // Which listed team each local team turned into. The two number their teams
  // differently often enough that the key cannot be trusted, so it is derived
  // from where the players that *are* in both ended up; a local team whose
  // players are all missing from the listing keeps its own number.
  const teamOf = new Map<string, number>();
  for (const localTeam of localTeams) {
    const landed = enriched.find((team) => team.players.some((player) =>
      localTeam.players.some((local) =>
        local.name.toLocaleLowerCase() === player.name.toLocaleLowerCase())));
    if (landed) teamOf.set(localTeam.team, landed.team);
  }

  const merged = enriched.map((team) => ({ ...team, players: [...team.players] }));
  for (const localTeam of localTeams) {
    const missing = localTeam.players.filter(
      (player) => !online.has(player.name.toLocaleLowerCase()),
    );
    if (missing.length === 0) continue;
    const added = missing.map((player) => ({
      name: player.name,
      faction: player.faction,
      rating: player.rating,
      // The server never rated them and never will, so there is no outcome and
      // no score to claim one from.
      outcome: "",
      score: null,
    }));
    const number = teamOf.get(localTeam.team)
      ?? (localTeam.team === "null" ? -1 : Number.parseInt(localTeam.team, 10) || 0);
    const target = merged.find((team) => team.team === number);
    if (target) target.players.push(...added);
    else merged.push({ team: number, players: added });
  }
  return merged;
}

/**
 * The tallest a team's list is allowed to get on a *card*.
 *
 * A card is a summary, and its height is shared with every other card in its
 * row: one 6v6 among nine 1v1s made that whole row twice as tall and left the
 * host line of every card in it floating somewhere different from the row
 * above. Four rows per team, so a team of six shows three names and says how
 * many more there are, and every card in the grid ends at the same place.
 *
 * The split layout below is exempt: it is already two columns, so eight
 * players are four rows there too. The panel and the table still show
 * everyone; this is the one place that cannot afford to.
 */
/**
 * How many players a team can hold before its names are laid out in two
 * columns rather than one.
 *
 * There is no cut any more. A card used to show three names and "+2 more",
 * which is the one thing a lineup must not do: the name somebody is scanning
 * for was as likely to be in the two as in the three. Every player is listed,
 * and a long team goes wide instead of long.
 */
const CARD_TEAM_SPLIT_AT = 4;

export function ReplayCardRoster({
  teams,
  interactive = false,
}: {
  teams: ReplayTeam[];
  /**
   * Whether a name in here opens the player card.
   *
   * Off by default, and it has to be: the vault's card is itself one large
   * `<button>`, and a button inside a button is not markup a browser will
   * accept. The live grid's card is an `<article>`, so its names can be the
   * handle on a player that every other list in this client makes them.
   */
  interactive?: boolean;
}) {
  useLocale();
  if (teams.length === 0) return null;
  const nonObserverTeams = teams.filter((team) => !isObserverTeam(team.team));
  const soleTeam = nonObserverTeams.length === 1;
  const isSingleTeamGame = teams.length === 1;
  return (
    <div className="replay-card-teams" data-sole-team={soleTeam ? "true" : undefined}>
      {teams.map((team) => {
        const observer = isObserverTeam(team.team);
        // Two columns only where a team has the card's full width to itself.
        // Side by side with another team, half a card split again is a column
        // too narrow for a name.
        const isSplit = (isSingleTeamGame || soleTeam) && team.players.length > CARD_TEAM_SPLIT_AT;
        const rowCount = isSplit ? Math.ceil(team.players.length / 2) : undefined;
        return (
          <section key={team.team} className="replay-card-team">
            {!isSingleTeamGame && (
              <header className="replay-card-team-title">
                <span>{teamName(team.team, soleTeam)}</span>
                <span>
                  {team.players.length} {observer
                    ? (team.players.length === 1 ? "observer" : "observers")
                    : (team.players.length === 1 ? "player" : "players")}
                </span>
              </header>
            )}
            <div
              className={`replay-card-team-roster ${isSplit ? "is-split" : ""}`}
              style={rowCount ? { gridTemplateRows: `repeat(${rowCount}, auto)` } : undefined}
            >
              {team.players.map((player) => (
                <div key={player.name} className="replay-player">
                  {interactive ? (
                    <button
                      type="button"
                      className="replay-player-identity replay-player-link"
                      title={t("lobby.browser.openProfile", { name: player.name })}
                      onClick={(event) => {
                        // The card around this one opens the game; this opens
                        // the player. Both are reasonable readings of a click
                        // on a name, and the nearer target wins.
                        event.stopPropagation();
                        openPlayerCard(null, player.name);
                      }}
                    >
                      <ReplayPlayerMarker player={player} observer={observer} size={17} />
                      {/* The class the hover underline hangs off, which is how
                          a name says it can be clicked before it is. Same one
                          the detail roster's names carry. */}
                      <PlayerName name={player.name} className="replay-player-name-text" />
                    </button>
                  ) : (
                    <span className="replay-player-identity">
                      <ReplayPlayerMarker player={player} observer={observer} size={17} />
                      <PlayerName name={player.name} />
                    </span>
                  )}
                  {player.rating !== null && <span className="muted">{player.rating}</span>}
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function ReplayPlayerAvatar({
  player,
  avatarByLogin,
}: {
  player: ReplayPlayer;
  avatarByLogin?: ReadonlyMap<string, string>;
}) {
  const url = player.avatarUrl || avatarByLogin?.get(player.name.toLocaleLowerCase());
  return (
    <span className="replay-player-avatar" aria-hidden="true">
      {url && (
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={(event) => {
            event.currentTarget.style.visibility = "hidden";
          }}
        />
      )}
    </span>
  );
}

export function ReplayDetailRoster({
  teams,
  showResults = false,
  avatarByLogin,
}: {
  teams: ReplayTeam[];
  /**
   * Whether the result is on screen. Java hides its result labels entirely for
   * a game that was not rated; showing outcomes anyway is what put "Defeat" on
   * both sides of a game nobody won, and left the other side blank when only
   * one team had a recorded result. The reason it is off sits beside the
   * button that would turn it on, not up here.
   */
  showResults?: boolean;
  avatarByLogin?: ReadonlyMap<string, string>;
}) {
  useLocale();
  if (teams.length === 0) return null;
  const nonObserverTeams = teams.filter((team) => !isObserverTeam(team.team));
  const soleTeam = nonObserverTeams.length === 1;
  const isSingleTeamGame = teams.length === 1;
  // Two teams get a versus divider between them, the way both reference clients
  // present a matchup. More than two is a grid, because a chain of "vs" reads
  // as a bracket rather than a lineup.
  const versus = teams.length === 2 && teams.every((team) => !isObserverTeam(team.team));
  return (
    <div
      className="replay-detail-teams"
      data-layout={versus ? "versus" : undefined}
      data-sole-team={soleTeam ? "true" : undefined}
    >
      {teams.map((team, index) => {
        const observer = isObserverTeam(team.team);
        const ratings = observer
          ? []
          : team.players.flatMap((player) => player.rating === null ? [] : [player.rating]);
        const teamRating = ratings.length === 0
          ? null
          : ratings.reduce((sum, rating) => sum + rating, 0);
        const resolved = observer ? "unknown" : teamOutcome(team.players);
        const outcomeKind = resolved === "unknown" ? "" : resolved;
        // An unknown result is stated, not left blank: a team with no outcome
        // beside one that has an outcome read as a rendering slip.
        const outcomeText = outcomeKind
          ? outcomeLabel(outcomeKind)
          : observer
            ? ""
            : t("replays.roster.unknownResult");
        const isSplit = (isSingleTeamGame || soleTeam) && team.players.length > 4;
        const rowCount = isSplit ? Math.ceil(team.players.length / 2) : undefined;
        const showHeader = !isSingleTeamGame || (showResults && Boolean(outcomeText));
        return (
          <Fragment key={team.team}>
            {versus && index === 1 && <span className="replay-detail-versus" aria-hidden>vs</span>}
            {/* Green and red say who won, so they may only appear once the
                result is on screen. Before that the panels are neutral: a
                colour keyed to which team happens to be listed first told the
                reader something the game never said. */}
            <section
              className="replay-detail-team surface-panel"
              data-outcome={showResults && outcomeKind ? outcomeKind : undefined}
            >
              {showHeader && (
                <header className="replay-detail-team-title">
                  <span>{!isSingleTeamGame ? teamName(team.team, soleTeam) : ""}</span>
                  <span className="replay-detail-team-summary">
                    {!isSingleTeamGame && teamRating !== null && (
                      <span title={t("replays.roster.combinedRating")}>{teamRating} rating</span>
                    )}
                    {showResults && outcomeText && (
                      <span className={`replay-team-outcome ${outcomeKind || "unknown"}`}>
                        {outcomeText}
                      </span>
                    )}
                  </span>
                </header>
              )}
              <div
                className={`replay-detail-roster ${isSplit ? "is-split" : ""}`}
                style={rowCount ? { gridTemplateRows: `repeat(${rowCount}, auto)` } : undefined}
              >
                {team.players.map((player) => (
                  <div key={player.name} className="replay-detail-player">
                    <button
                      type="button"
                      className="replay-player-identity replay-player-link"
                      title={t("lobby.browser.openProfile", { name: player.name })}
                      onClick={() => openPlayerCard(null, player.name)}
                    >
                      <ReplayPlayerAvatar player={player} avatarByLogin={avatarByLogin} />
                      {observer || player.faction ? (
                        <ReplayPlayerMarker player={player} observer={observer} size={18} />
                      ) : (
                        <span className="replay-player-faction replay-player-faction-empty" aria-hidden />
                      )}
                      <span className="replay-player-name-group">
                        <PlayerName name={player.name} className="replay-player-name-text" />
                        {player.rating !== null && (
                          <span className="replay-player-rating" title={t("replays.roster.rating")}>
                            ({player.rating})
                          </span>
                        )}
                      </span>
                    </button>
                    <span className="replay-player-stats">
                      {/* What the game did to this player's rating, not the
                          game score that used to sit here: the score is the
                          same number for everyone on a team and exists even
                          for games the server never rated, so it read as a
                          rating change that had not happened. */}
                      {showResults && player.ratingChange !== null && player.ratingChange !== undefined && (
                        <span
                          className={`replay-player-rating-change ${
                            player.ratingChange > 0 ? "positive" : player.ratingChange < 0 ? "negative" : "zero"
                          }`}
                          title={t("replays.roster.ratingChange")}
                        >
                          {formatSigned(player.ratingChange)}
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

/** `+12` / `-9` / `0`, the way both reference clients sign a rating change. */
function formatSigned(value: number): string {
  const formatted = new Intl.NumberFormat("en-US").format(Math.abs(value));
  if (value > 0) return `+${formatted}`;
  if (value < 0) return `-${formatted}`;
  return "0";
}

export function playerCount(teams: ReplayTeam[]): number {
  return teams.reduce((sum, team) => sum + (isObserverTeam(team.team) ? 0 : team.players.length), 0);
}

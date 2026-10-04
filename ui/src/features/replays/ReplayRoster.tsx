import { Fragment, type MouseEvent as ReactMouseEvent } from "react";
import { Icon } from "../../design-system/Icon";
import type { LocalReplayPlayer, LocalReplayTeam, ReplayPlayer, ReplayTeam } from "../../ipc/bindings";
import { FactionIcon } from "../../shared/components/FactionIcon";
import { openPlayerCard } from "../../shared/playerCardActions";
import type { PlayerMenuOpener } from "../../shared/hooks/usePlayerMenu";
import { t } from "../../i18n";
import { outcomeLabel, parseOutcome, type OutcomeKind } from "../../shared/gameOutcome";
import { ReplayPlayerFlag } from "./ReplayPlayerFlag";
import { useLocale } from "../../i18n/useTranslation";
import { PlayerName } from "../../shared/components/nameColors";

// Team 1 is the FAF server's "no team" bucket. Calling that "No team" reads as
// missing data; for a game where it holds everyone it is simply a free-for-all,
// which is what the Java client's lineup shows too.
function teamName(team: number, soleTeam: boolean): string {
  if (team < 0) return t("replays.roster.observers");
  if (soleTeam) {
    return team === 1 ? t("replays.roster.freeForAll") : t("replays.roster.players");
  }
  if (team > 1) return t("replays.live.team", { team: team - 1 });
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

// Moved to shared, because the matchmaker tab reads outcomes too.
export { outcomeLabel, parseOutcome, type OutcomeKind };

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

export type RosterPlayer = ReplayPlayer & {
  alias?: string;
};

export type RosterTeam = Omit<ReplayTeam, "players"> & {
  players: RosterPlayer[];
};



/**
 * Local replay headers can contain the exact rating and faction even when the vault
 * response has no rating journal or faction included. Keep the richer vault player data
 * and fill values that are missing from it.
 *
 * Players who renamed since the game was played are matched to their online account
 * counterpart so their old nicknames enrich the player rather than appearing as duplicate
 * phantom rows.
 */
export function mergeReplayTeamsWithLocal(
  teams: ReplayTeam[],
  localTeams?: LocalReplayTeam[],
): RosterTeam[] {
  if (!localTeams || localTeams.length === 0) return teams;
  const localByTeam = new Map(localTeams.map((team) => [team.team, team]));

  // Which listed team each local team turned into. The two number their teams
  // differently often enough that the key cannot be trusted, so it is derived
  // from where the players that are in both ended up; a local team whose
  // players are all missing from the listing keeps its own number.
  const teamOf = new Map<string, number>();
  for (const localTeam of localTeams) {
    const landed = teams.find((team) =>
      team.players.some((player) =>
        localTeam.players.some(
          (local) => local.name.toLocaleLowerCase() === player.name.toLocaleLowerCase(),
        ),
      ),
    );
    if (landed) teamOf.set(localTeam.team, landed.team);
  }

  // Track which local players have been matched: Set of `${localTeam.team}:${localPlayerIndex}`
  const matchedLocalIndices = new Set<string>();

  const enriched = teams.map((team, teamIndex) => {
    let localTeam = localTeams.find((lt) => teamOf.get(lt.team) === team.team);
    if (!localTeam) {
      localTeam = localByTeam.get(String(team.team));
    }
    if (!localTeam && localTeams.length === teams.length) {
      localTeam = localTeams[teamIndex];
    }

    if (!localTeam) {
      return { ...team, players: [...team.players] };
    }

    const localPlayers = localTeam.players;
    const teamKey = localTeam.team;

    type MatchResult = {
      localPlayer: LocalReplayPlayer;
      localIndex: number;
    };
    const playerMatches = new Map<number, MatchResult>();

    // Pass 1: Match by exact name (case-insensitive)
    team.players.forEach((player, pIdx) => {
      const pName = player.name.toLocaleLowerCase();
      const localIdx = localPlayers.findIndex(
        (lp, lIdx) =>
          !matchedLocalIndices.has(`${teamKey}:${lIdx}`) &&
          lp.name.toLocaleLowerCase() === pName,
      );
      if (localIdx >= 0) {
        matchedLocalIndices.add(`${teamKey}:${localIdx}`);
        playerMatches.set(pIdx, {
          localPlayer: localPlayers[localIdx],
          localIndex: localIdx,
        });
      }
    });

    // Pass 2: Match renamed players (unmatched online players to unmatched local human players in the same team)
    const unmatchedOnlineIndices = team.players
      .map((_, idx) => idx)
      .filter((idx) => !playerMatches.has(idx));

    const unmatchedLocalHumanIndices = localPlayers
      .map((_, idx) => idx)
      .filter(
        (idx) =>
          !matchedLocalIndices.has(`${teamKey}:${idx}`) &&
          localPlayers[idx].ai !== true,
      );

    if (unmatchedOnlineIndices.length > 0 && unmatchedLocalHumanIndices.length > 0) {
      // 2a. Match by exact displayed rating if available
      for (const pIdx of [...unmatchedOnlineIndices]) {
        const player = team.players[pIdx];
        if (player.rating !== null && player.rating !== undefined) {
          const foundHumanIdx = unmatchedLocalHumanIndices.find(
            (lIdx) => localPlayers[lIdx].rating === player.rating,
          );
          if (foundHumanIdx !== undefined) {
            matchedLocalIndices.add(`${teamKey}:${foundHumanIdx}`);
            playerMatches.set(pIdx, {
              localPlayer: localPlayers[foundHumanIdx],
              localIndex: foundHumanIdx,
            });
            unmatchedOnlineIndices.splice(unmatchedOnlineIndices.indexOf(pIdx), 1);
            unmatchedLocalHumanIndices.splice(unmatchedLocalHumanIndices.indexOf(foundHumanIdx), 1);
          }
        }
      }

      // 2b. Match remaining 1-to-1 in order of appearance
      const toMatchCount = Math.min(unmatchedOnlineIndices.length, unmatchedLocalHumanIndices.length);
      for (let i = 0; i < toMatchCount; i++) {
        const pIdx = unmatchedOnlineIndices[i];
        const lIdx = unmatchedLocalHumanIndices[i];
        matchedLocalIndices.add(`${teamKey}:${lIdx}`);
        playerMatches.set(pIdx, {
          localPlayer: localPlayers[lIdx],
          localIndex: lIdx,
        });
      }
    }

    return {
      ...team,
      players: team.players.map((player, pIdx): RosterPlayer => {
        const match = playerMatches.get(pIdx);
        if (!match) return player;
        const local = match.localPlayer;
        const isRenamed = local.name.toLocaleLowerCase() !== player.name.toLocaleLowerCase();
        return {
          ...player,
          faction: player.faction ?? local.faction,
          rating: player.rating ?? local.rating,
          country: player.country ?? local.country ?? null,
          ...(isRenamed ? { alias: local.name } : {}),
        };
      }),
    };
  });

  // Everyone the file has and the listing does not, which in practice means
  // the AI. The vault's roster is playerStats, one row per account, so a
  // game against three AI arrives from the server as a lineup of one; the
  // replay's own army table has all four. The grid card reads that table
  // directly and showed them, the panel took the server's list and did not.
  //
  // Only AI players are added from the local replay file: human participants
  // are already fully accounted for by the online server roster, and an unmatched
  // human name represents a player who changed nicknames, never an extra player.
  const merged: RosterTeam[] = enriched.map((team) => ({ ...team, players: [...team.players] }));
  for (const localTeam of localTeams) {
    const teamKey = localTeam.team;
    const missingAi = localTeam.players.filter(
      (player, idx) => !matchedLocalIndices.has(`${teamKey}:${idx}`) && player.ai === true,
    );
    if (missingAi.length === 0) continue;
    const added: RosterPlayer[] = missingAi.map((player) => ({
      name: player.name,
      faction: player.faction,
      rating: player.rating,
      country: player.country ?? null,
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

/**
 * What a click on a name in a lineup does.
 *
 * The menu where there is one, the profile card where there is not. Left-click
 * rather than right-click only, because that is what the channel roster and the
 * live table already do, and a name that answers the two buttons differently
 * from one list to the next is a name nobody trusts.
 */
function openPlayerActions(
  name: string,
  event: ReactMouseEvent,
  onPlayerMenu: PlayerMenuOpener | undefined,
): void {
  if (onPlayerMenu) {
    onPlayerMenu(name, event);
    return;
  }
  void openPlayerCard(null, name);
}

function playerActionTitle(
  name: string,
  alias: string | undefined,
  onPlayerMenu: PlayerMenuOpener | undefined,
): string {
  const base = onPlayerMenu
    ? t("replays.roster.playerActions", { name })
    : t("lobby.browser.openProfile", { name });
  if (alias && alias.toLocaleLowerCase() !== name.toLocaleLowerCase()) {
    return `${base} (${t("replays.roster.playedAs", { name: alias })})`;
  }
  return base;
}

export function ReplayCardRoster({
  teams,
  interactive = false,
  onPlayerMenu,
}: {
  teams: (ReplayTeam | RosterTeam)[];
  /**
   * Whether a name in here is a control at all.
   *
   * Off by default, and it has to be: the vault's card is itself one large
   * `<button>`, and a button inside a button is not markup a browser will
   * accept. The live grid's card is an `<article>`, so its names can be the
   * handle on a player that every other list in this client makes them.
   */
  interactive?: boolean;
  /** See [`ReplayDetailRoster`]'s prop of the same name. */
  onPlayerMenu?: PlayerMenuOpener;
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
              {team.players.map((player) => {
                const alias = (player as RosterPlayer).alias;
                const isRenamed = Boolean(
                  alias && alias.toLocaleLowerCase() !== player.name.toLocaleLowerCase(),
                );
                return (
                  <div key={player.name} className="replay-player">
                    {interactive ? (
                      <button
                        type="button"
                        className="replay-player-identity replay-player-link"
                        title={playerActionTitle(player.name, alias, onPlayerMenu)}
                        onClick={(event) => {
                          // The card around this one opens the game; this opens
                          // the player. Both are reasonable readings of a click
                          // on a name, and the nearer target wins.
                          event.stopPropagation();
                          openPlayerActions(player.name, event, onPlayerMenu);
                        }}
                        onContextMenu={(event) => {
                          if (!onPlayerMenu) return;
                          event.stopPropagation();
                          onPlayerMenu(player.name, event);
                        }}
                      >
                        <ReplayPlayerMarker player={player} observer={observer} size={17} />
                        <ReplayPlayerFlag player={player} />
                        {/* The class the hover underline hangs off, which is how
                            a name says it can be clicked before it is. Same one
                            the detail roster's names carry. */}
                        <PlayerName name={player.name} className="replay-player-name-text" />
                      </button>
                    ) : (
                      /* Not a control: a card that is itself one big target
                         cannot hold buttons. The context menu is still reachable,
                         which is the gesture the channel roster answers on a name
                         too, and the only one a span can offer. */
                      <span
                        className={onPlayerMenu ? "replay-player-identity replay-player-menuable" : "replay-player-identity"}
                        title={
                          isRenamed
                            ? onPlayerMenu
                              ? `${t("replays.roster.playerActions", { name: player.name })} (${t("replays.roster.playedAs", { name: alias! })})`
                              : t("replays.roster.playedAs", { name: alias! })
                            : onPlayerMenu
                              ? t("replays.roster.playerActions", { name: player.name })
                              : undefined
                        }
                        onContextMenu={onPlayerMenu && ((event) => {
                          event.stopPropagation();
                          onPlayerMenu(player.name, event);
                        })}
                      >
                        <ReplayPlayerMarker player={player} observer={observer} size={17} />
                        <ReplayPlayerFlag player={player} />
                        <PlayerName name={player.name} />
                      </span>
                    )}
                    {player.rating !== null && <span className="muted">{player.rating}</span>}
                  </div>
                );
              })}
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
  onPlayerMenu,
  titlesAbove = false,
}: {
  teams: (ReplayTeam | RosterTeam)[];
  /**
   * Whether the result is on screen. Java hides its result labels entirely for
   * a game that was not rated; showing outcomes anyway is what put "Defeat" on
   * both sides of a game nobody won, and left the other side blank when only
   * one team had a recorded result. The reason it is off sits beside the
   * button that would turn it on, not up here.
   */
  showResults?: boolean;
  avatarByLogin?: ReadonlyMap<string, string>;
  /**
   * Opens the chat player menu on a name, which is what a nickname does
   * everywhere else in this client: message, invite, friend, foe, mute, note,
   * report, and "view profile" among them. Supplied by a caller that can host
   * the menu (`usePlayerMenu`); without it a name still opens the profile card
   * on its own, which is all a surface with nowhere to put a menu can offer.
   */
  onPlayerMenu?: PlayerMenuOpener;
  /**
   * Each team's name, rating and outcome stand above its card instead of
   * inside it, with the first of two teams aligned to its card's right edge
   * so the two names meet in the middle. Every replay surface asks for this
   * now; the default stays for anything that has not.
   */
  titlesAbove?: boolean;
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
      data-titles-above={titlesAbove ? "true" : undefined}
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
        const outcomeBadge = showResults && outcomeText && (
          <span className={`replay-team-outcome ${outcomeKind || "unknown"}`}>
            {outcomeText}
          </span>
        );
        // Above the card: the name over the combined rating, and the outcome
        // beside them once the result is on screen.
        const headingAbove = titlesAbove && showHeader && (
          <header className="replay-detail-team-heading">
            <span className="replay-detail-team-heading-text">
              <span className="replay-detail-team-heading-name">
                {!isSingleTeamGame ? teamName(team.team, soleTeam) : ""}
              </span>
              {!isSingleTeamGame && teamRating !== null && (
                <span className="replay-detail-team-heading-rating" title={t("replays.roster.combinedRating")}>
                  {teamRating} rating
                </span>
              )}
            </span>
            {outcomeBadge}
          </header>
        );
        const card = (
            /* Green and red say who won, so they may only appear once the
               result is on screen. Before that the panels are neutral: a
               colour keyed to which team happens to be listed first told the
               reader something the game never said. */
            <section
              className="replay-detail-team surface-panel"
              data-outcome={showResults && outcomeKind ? outcomeKind : undefined}
            >
              {showHeader && !titlesAbove && (
                <header className="replay-detail-team-title">
                  <span>{!isSingleTeamGame ? teamName(team.team, soleTeam) : ""}</span>
                  <span className="replay-detail-team-summary">
                    {!isSingleTeamGame && teamRating !== null && (
                      <span title={t("replays.roster.combinedRating")}>{teamRating} rating</span>
                    )}
                    {outcomeBadge}
                  </span>
                </header>
              )}
              <div
                className={`replay-detail-roster ${isSplit ? "is-split" : ""}`}
                style={rowCount ? { gridTemplateRows: `repeat(${rowCount}, auto)` } : undefined}
              >
                {team.players.map((player) => {
                  const alias = (player as RosterPlayer).alias;
                  const isRenamed = Boolean(
                    alias && alias.toLocaleLowerCase() !== player.name.toLocaleLowerCase(),
                  );
                  return (
                    <div key={player.name} className="replay-detail-player">
                      <button
                        type="button"
                        className="replay-player-identity replay-player-link"
                        title={playerActionTitle(player.name, alias, onPlayerMenu)}
                        onClick={(event) => openPlayerActions(player.name, event, onPlayerMenu)}
                        onContextMenu={(event) => onPlayerMenu?.(player.name, event)}
                      >
                        <ReplayPlayerAvatar player={player} avatarByLogin={avatarByLogin} />
                        {observer || player.faction ? (
                          <ReplayPlayerMarker player={player} observer={observer} size={18} />
                        ) : (
                          <span className="replay-player-faction replay-player-faction-empty" aria-hidden />
                        )}
                        <ReplayPlayerFlag player={player} />
                        <span className="replay-player-name-group">
                          <PlayerName name={player.name} className="replay-player-name-text" />
                          {isRenamed && (
                            <span
                              className="replay-player-alias"
                              title={t("replays.roster.playedAs", { name: alias! })}
                            >
                              ({alias})
                            </span>
                          )}
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
                  );
                })}
              </div>
            </section>
        );
        return (
          <Fragment key={team.team}>
            {versus && index === 1 && <span className="replay-detail-versus" aria-hidden>vs</span>}
            {titlesAbove ? (
              <div className="replay-detail-team-column">
                {headingAbove}
                {card}
              </div>
            ) : card}
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

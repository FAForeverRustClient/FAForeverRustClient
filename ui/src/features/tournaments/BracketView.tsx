// The bracket, drawn as one column per round with the feed lines between them.
//
// The columns come from the matches' own `bracket` and `round` fields, and the
// connectors from `winnerTo`: a match names the match its winner goes to, so
// "these two cards feed that one" is read rather than inferred. Under Challonge
// it had to be guessed at from column geometry, which is why the lines never
// quite sat right on a bracket with byes in it.
//
// The lines themselves stay pure CSS. A round's cards are evenly spaced in
// their column, so once the *grouping* is right, "join the pair on the left to
// the one on the right" is a border on a pseudo-element and survives any amount
// of scrolling and resizing. An SVG overlay would need measured coordinates and
// a resize observer to say the same thing.

import type { CSSProperties } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import type { PlayerSummary, Tourney, TourneyMatch } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";
import { PlayerChip } from "./PlayerChip";
import { BRACKET_LABELS, isMyMatch, myTeamId } from "./tourneyPresentation";

interface Column {
  round: number;
  matches: TourneyMatch[];
}

export interface Side {
  bracket: TourneyMatch["bracket"];
  columns: Column[];
}

/**
 * Group the flat match list into one side per bracket half, one column per
 * round, in play order.
 *
 * Exported for its test: the grouping is the part that decides whether a
 * bracket reads as a tree or as a pile of cards.
 */
export function groupIntoSides(matches: TourneyMatch[]): Side[] {
  const sides: Side[] = [];
  const ordered = [...matches].sort(
    (left, right) => left.round - right.round || left.index - right.index,
  );
  // Winners first, then losers, then the grand final, which is the order they
  // are played and read in. Swiss and free-for-all events have one side.
  const rank: Record<TourneyMatch["bracket"], number> = {
    winners: 0,
    losers: 1,
    grandFinal: 2,
    swiss: 0,
    freeForAll: 0,
  };
  for (const entry of ordered) {
    let side = sides.find((held) => held.bracket === entry.bracket);
    if (side === undefined) {
      side = { bracket: entry.bracket, columns: [] };
      sides.push(side);
    }
    const last = side.columns[side.columns.length - 1];
    if (last !== undefined && last.round === entry.round) last.matches.push(entry);
    else side.columns.push({ round: entry.round, matches: [entry] });
  }
  return sides.sort((left, right) => rank[left.bracket] - rank[right.bracket]);
}

/**
 * Whether a column's winners all feed into the next column.
 *
 * An elimination round does: eight matches become four, then two, then the
 * final, and a connector between them says something true. A Swiss round has
 * the *same* number of matches each round because everybody keeps playing, and
 * joining those with lines would claim a progression that does not exist. Read
 * from the edges rather than from the card count, so a round with a bye still
 * draws correctly.
 */
export function feedsForward(columns: Column[]): boolean {
  return columns.every((column, index) => {
    if (index === columns.length - 1) return true;
    const next = new Set(columns[index + 1].matches.map((entry) => entry.id));
    const links = column.matches.filter((entry) => entry.winnerTo !== null);
    return links.length > 0 && links.every((entry) => next.has(entry.winnerTo?.matchId ?? ""));
  });
}

interface BracketViewProps {
  event: Tourney;
  profiles: PlayerSummary[];
  busyMatchId: string | null;
  onReport: (entry: TourneyMatch) => void;
  onAnswer: (entry: TourneyMatch, accept: boolean) => void;
  onHost: (entry: TourneyMatch) => void;
}

export function BracketView({
  event,
  profiles,
  busyMatchId,
  onReport,
  onAnswer,
  onHost,
}: BracketViewProps) {
  const { t } = useTranslation();
  const sides = groupIntoSides(event.matches);

  if (event.matches.length === 0) {
    return <p className="muted">{t("tournaments.bracket.notDrawn")}</p>;
  }

  return (
    <div className="tournament-bracket">
      {sides.map((side) => {
        const linked = feedsForward(side.columns);
        return (
          <div className="tournament-bracket-side" key={side.bracket}>
            {sides.length > 1 && <h4>{t(BRACKET_LABELS[side.bracket])}</h4>}
            <div className="tournament-bracket-columns">
              {side.columns.map((column, index) => (
                <div
                  className={
                    // The first column has nothing to its left to join to.
                    linked && index > 0 ? "tournament-round is-linked" : "tournament-round"
                  }
                  key={column.round}
                >
                  <h5>{t("tournaments.bracket.round", { round: column.round })}</h5>
                  {/* `--pitch` is how far apart this round's cards sit, as a
                      multiple of one card slot: round 1 is 1, round 2 is 2,
                      round 3 is 4. That doubling is what makes a card line up
                      with the midpoint of the pair feeding it, and it is all
                      the CSS needs to draw exact connectors. */}
                  <div
                    className="tournament-round-matches"
                    style={{ "--pitch": 2 ** (linked ? index : 0) } as CSSProperties}
                  >
                    {column.matches.map((entry) => (
                      <MatchCard
                        key={entry.id}
                        event={event}
                        entry={entry}
                        profiles={profiles}
                        busy={busyMatchId === entry.id}
                        onReport={() => onReport(entry)}
                        onAnswer={(accept) => onAnswer(entry, accept)}
                        onHost={() => onHost(entry)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

interface MatchCardProps {
  event: Tourney;
  entry: TourneyMatch;
  profiles: PlayerSummary[];
  busy: boolean;
  onReport: () => void;
  onAnswer: (accept: boolean) => void;
  onHost: () => void;
}

function MatchCard({
  event,
  entry,
  profiles,
  busy,
  onReport,
  onAnswer,
  onHost,
}: MatchCardProps) {
  const { t } = useTranslation();
  const mine = myTeamId(event);
  const pending = entry.pendingReport;
  // Twins of `Tourney::may_report` and `may_confirm`. Offering a control the
  // server refuses is worse than offering none: the player fills in a score and
  // loses it.
  const playable =
    (entry.status === "ready" || entry.status === "live") &&
    entry.team1 !== null &&
    entry.team2 !== null;
  const mayReport =
    event.playerReporting && playable && entry.bracket !== "freeForAll" && isMyMatch(event, entry);
  const mayAnswer = pending !== null && isMyMatch(event, entry) && pending.byTeam !== mine;

  const teamName = (teamId: string | null): string => {
    if (teamId === null) return t("tournaments.bracket.tbd");
    const team = event.teams.find((candidate) => candidate.id === teamId);
    if (team === undefined) return t("tournaments.bracket.tbd");
    const named = team.name.trim();
    if (named !== "") return named;
    const first = event.players.find((player) => player.id === team.playerIds[0]);
    return first?.name ?? t("tournaments.bracket.tbd");
  };

  /** The FAF account behind a slot, for a solo team where there is exactly one. */
  const profileOf = (teamId: string | null): PlayerSummary | null => {
    const team = event.teams.find((candidate) => candidate.id === teamId);
    if (team === undefined || team.playerIds.length !== 1) return null;
    const fafId = event.players.find((player) => player.id === team.playerIds[0])?.fafId ?? null;
    if (fafId === null) return null;
    return profiles.find((profile) => profile.id === fafId) ?? null;
  };

  const side = (teamId: string | null, score: number | null) => {
    const profile = profileOf(teamId);
    const classes = ["tournament-match-side"];
    if (entry.winner !== null && entry.winner === teamId) classes.push("is-winner");
    if (teamId !== null && teamId === mine) classes.push("is-mine");
    return (
      <span className={classes.join(" ")}>
        {profile ? (
          <PlayerChip player={profile} overrideName={teamName(teamId)} />
        ) : (
          teamName(teamId)
        )}
        {score !== null && <span className="tournament-match-score">{score}</span>}
      </span>
    );
  };

  return (
    <div className={`surface tournament-match is-${entry.status}`}>
      {side(entry.team1, entry.score1)}
      {side(entry.team2, entry.score2)}

      {pending !== null && (
        <span className="tournament-match-pending muted">
          {t("tournaments.match.awaiting", {
            who: pending.byName || teamName(pending.byTeam),
            score: `${pending.score1}–${pending.score2}`,
          })}
        </span>
      )}

      {/* Always rendered, empty when there is nothing to do: every card in a
          column has to be the same height, or the connector geometry, which is
          derived from the card pitch, stops lining up. */}
      <div className="tournament-match-actions">
        {mayAnswer && (
          <>
            <Button variant="primary" onClick={() => onAnswer(true)} disabled={busy}>
              {t("tournaments.match.confirm")}
            </Button>
            <Button onClick={() => onAnswer(false)} disabled={busy}>
              {t("tournaments.match.reject")}
            </Button>
          </>
        )}
        {!mayAnswer && playable && (
          <>
            {/* Hosting is offered to everyone watching, not just the two
                players: a caster or an organiser opening the lobby is normal. */}
            <Button onClick={onHost} title={t("tournaments.match.hostHint")}>
              <Icon name="play" size={14} /> {t("tournaments.match.host")}
            </Button>
            {mayReport && pending === null && (
              <Button variant="primary" onClick={onReport} disabled={busy}>
                {t(busy ? "tournaments.match.reporting" : "tournaments.match.report")}
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

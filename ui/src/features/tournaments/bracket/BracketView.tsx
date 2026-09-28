// The bracket, drawn as one column per round with the feed lines between them.
//
// The columns come from the matches' own `bracket` and `round` fields, and the
// connectors from `winnerTo`: a match names the match its winner goes to, so
// "these two cards feed that one" is read rather than inferred. Under Challonge
// it had to be guessed at from column geometry, which is why the lines never
// quite sat right on a bracket with byes in it.
//
// One thing is deliberately *not* in a card: the ban and pick run. It was, and
// it was the worst thing on the screen. Every card rendered three grids of map
// thumbnails, so a 40-team double elimination asked the webview for several
// hundred remote images at once, inside cards of a fixed height that could not
// hold them. It pinned a core and spilled over the geometry at the same time.
// A card now carries a button, and the run opens under the bracket, one at a
// time, next to the pool it is played from.
//
// The lines themselves stay pure CSS. A round's cards are evenly spaced in
// their column, so once the *grouping* is right, "join the pair on the left to
// the one on the right" is a border on a pseudo-element and survives any amount
// of scrolling and resizing. An SVG overlay would need measured coordinates and
// a resize observer to say the same thing.

import { useState, type CSSProperties } from "react";
import type {
  FfaReport,
  PlayerSummary,
  Tourney,
  TourneyMatch,
  VaultMap,
} from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";
import { FfaLobby } from "./FfaLobby";
import { VetoPanel, type VetoHandlers } from "./VetoPanel";
import { MatchActions, TeamName, teamNameOf } from "./matchParts";
import { PoolPanel, PoolToggle } from "./RoundPool";
import { SwissRounds } from "./SwissRounds";
import { hasVeto } from "./vetoPresentation";
import { BRACKET_LABELS, myTeamId } from "../tourneyPresentation";
import { roundKeyOf } from "../../../shared/rules/tourneyRules";

interface Column {
  round: number;
  matches: TourneyMatch[];
}

interface Side {
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

/** How one column is placed, and how it is joined to the one before it. */
export interface ColumnLayout {
  /**
   * How far apart this column's cards sit, in slots.
   *
   * Read off the match counts rather than assumed to double. That assumption is
   * true of a winners bracket and false of a losers bracket, which is where it
   * showed: a losers round 2 takes the winners of losers round 1 *and* the
   * losers of winners round 2, so it has the same number of matches as the
   * round before it, not half. Spacing it at twice the pitch left it sprawling
   * down the column with its cards nowhere near the ones they came from.
   */
  pitch: number;
  /**
   * The line into this column: a bracket where two cards became one, a straight
   * run where the count did not change, nothing for the first column and for a
   * format that does not progress at all.
   */
  link: "none" | "bracket" | "straight";
}

/**
 * Place the columns of one side.
 *
 * The pitch is the first column's card count divided by this one's, which is
 * the general form of "doubling": 8, 4, 2, 1 gives 1, 2, 4, 8, and the losers
 * bracket's 4, 4, 2, 2, 1 gives 1, 1, 2, 2, 4. The link follows from the same
 * two numbers, so a minor losers round is drawn as the straight run it is.
 */
export function columnLayouts(columns: Column[]): ColumnLayout[] {
  const linked = feedsForward(columns);
  const first = columns[0]?.matches.length ?? 1;
  return columns.map((column, index) => {
    const count = column.matches.length;
    if (!linked || count === 0) return { pitch: 1, link: "none" };
    const previous = columns[index - 1]?.matches.length ?? 0;
    const pitch = Math.max(1, first / count);
    if (index === 0) return { pitch, link: "none" };
    if (previous === count * 2) return { pitch, link: "bracket" };
    if (previous === count) return { pitch, link: "straight" };
    // Anything else is a shape this layout cannot claim to know: draw the cards
    // where the pitch puts them and leave the space between them empty rather
    // than drawing a line that says something untrue.
    return { pitch, link: "none" };
  });
}

interface BracketViewProps {
  event: Tourney;
  profiles: PlayerSummary[];
  busyMatchId: string | null;
  onReport: (entry: TourneyMatch) => void;
  onAnswer: (entry: TourneyMatch, accept: boolean) => void;
  onHost: (entry: TourneyMatch) => void;
  vault: VaultMap[];
  /** Where the service lives, for the organisers' uploaded map pictures. */
  assetBase: string;
  veto: VetoHandlers;
  onReportFfa: (report: FfaReport) => void;
}

export function BracketView({
  event,
  profiles,
  busyMatchId,
  onReport,
  onAnswer,
  onHost,
  vault,
  assetBase,
  veto,
  onReportFfa,
}: BracketViewProps) {
  const { t } = useTranslation();
  // A Swiss stage is a list of rounds, not a tree: see `SwissRounds`. What is
  // left for the columns is a playoff bracket, where the stage feeds one.
  const swissStage = event.bracketKind === "swiss" && event.competition !== "freeForAll";
  const playoffs = event.matches.filter(
    (entry) => entry.bracket === "winners" || entry.bracket === "losers",
  );
  const sides = groupIntoSides(
    swissStage
      ? playoffs.length > 0
        ? event.matches.filter((entry) => entry.bracket !== "swiss")
        : []
      : event.matches,
  );
  /**
   * The round whose map pool is open, by its service key, or null.
   *
   * One at a time and held here rather than in the header button, because the
   * panel it opens cannot live inside the bracket box: that box scrolls
   * sideways, and a scroll container clips its own absolutely positioned
   * children. So the button is in the round's header and the panel is under the
   * whole side, which also means it is readable at any bracket width.
   */
  const [openPool, setOpenPool] = useState<string | null>(null);
  /** The match whose ban and pick run is open, by id, or null. */
  const [openVeto, setOpenVeto] = useState<string | null>(null);

  if (event.matches.length === 0) {
    return <p className="muted">{t("tournaments.bracket.notDrawn")}</p>;
  }

  return (
    <div className="tournament-bracket">
      {swissStage && sides.length > 0 && <h4>{t("tournaments.swiss.playoffs")}</h4>}
      {sides.map((side) => {
        const layouts = columnLayouts(side.columns);
        return (
          <div className="tournament-bracket-side" key={side.bracket}>
            {sides.length > 1 && <h4>{t(BRACKET_LABELS[side.bracket])}</h4>}
            <div className="tournament-bracket-columns">
              {side.columns.map((column, index) => (
                <div
                  className={`tournament-round is-${layouts[index].link}`}
                  key={column.round}
                >
                  <div className="tournament-round-head">
                    <h5>{t("tournaments.bracket.round", { round: column.round })}</h5>
                    {/* Which maps this round is played on, next to the round it
                        belongs to. It was two sections away, in Manage, which
                        only an organiser can open: a player wanting to know
                        what they are about to play had nowhere to look. */}
                    <PoolToggle
                      event={event}
                      roundKey={roundKeyOf(side.bracket, column.round)}
                      open={openPool === roundKeyOf(side.bracket, column.round)}
                      onToggle={(key) => setOpenPool((held) => (held === key ? null : key))}
                    />
                  </div>
                  {/* `--pitch` is how far apart this round's cards sit, as a
                      multiple of one card slot, and the CSS draws the connectors
                      from it: a card sits exactly at the midpoint of the pair
                      feeding it, so an elbow is a fixed offset rather than a
                      measured one. */}
                  <div
                    className="tournament-round-matches"
                    style={{ "--pitch": layouts[index].pitch } as CSSProperties}
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
                        vetoOpen={openVeto === entry.id}
                        onToggleVeto={() =>
                          setOpenVeto((held) => (held === entry.id ? null : entry.id))
                        }
                        onReportFfa={onReportFfa}
                        profilesForFfa={profiles}
                        onHost={() => onHost(entry)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
            {/* Outside the scrolling box, under the round it belongs to. The
                run and the pool sit in the same place for the same reason: both
                are a grid of maps, and neither fits in a bracket column. */}
            {side.columns.some((column) =>
              column.matches.some((entry) => entry.id === openVeto),
            ) &&
              openVeto !== null &&
              (() => {
                const entry = event.matches.find((held) => held.id === openVeto);
                if (entry === undefined || !hasVeto(event, entry)) return null;
                return (
                  <div className="tournament-veto-drawer surface">
                    <VetoPanel
                      event={event}
                      entry={entry}
                      vault={vault}
                      assetBase={assetBase}
                      profiles={profiles}
                      busy={busyMatchId === entry.id}
                      handlers={veto}
                    />
                  </div>
                );
              })()}

            {/* Outside the scrolling box, under the round it belongs to. */}
            {side.columns.some(
              (column) => roundKeyOf(side.bracket, column.round) === openPool,
            ) &&
              openPool !== null && (
                <PoolPanel
                  event={event}
                  vault={vault}
                  assetBase={assetBase}
                  roundKey={openPool}
                  onClose={() => setOpenPool(null)}
                />
              )}
          </div>
        );
      })}
      {swissStage && (
        <>
          {sides.length > 0 && <h4>{t("tournaments.swiss.stage")}</h4>}
          <SwissRounds
            event={event}
            profiles={profiles}
            busyMatchId={busyMatchId}
            withFinal={playoffs.length === 0}
            onReport={onReport}
            onAnswer={onAnswer}
            onHost={onHost}
            vault={vault}
            assetBase={assetBase}
            veto={veto}
          />
        </>
      )}
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
  /** Whether this match's ban and pick run is the one on screen. */
  vetoOpen: boolean;
  onToggleVeto: () => void;
  onReportFfa: (report: FfaReport) => void;
  /** Only the free-for-all lobby needs these; a two-sided card resolves its own. */
  profilesForFfa: PlayerSummary[];
}

function MatchCard({
  event,
  entry,
  profiles,
  busy,
  onReport,
  onAnswer,
  onHost,
  vetoOpen,
  onToggleVeto,
  onReportFfa,
  profilesForFfa,
}: MatchCardProps) {
  const { t } = useTranslation();
  // A free-for-all lobby has entrants rather than two sides, so the card below
  // would draw it as "TBD vs TBD". Its own shape, same place in the column.
  if (entry.bracket === "freeForAll") {
    return (
      <FfaLobby
        event={event}
        entry={entry}
        profiles={profilesForFfa}
        busy={busy}
        onReport={onReportFfa}
      />
    );
  }
  const mine = myTeamId(event);
  const pending = entry.pendingReport;
  const teamName = (teamId: string | null): string =>
    teamNameOf(event, teamId) ?? t("tournaments.bracket.tbd");

  /** The seed the organiser gave a team, or null for a slot nobody has yet. */
  const seedOf = (teamId: string | null): number | null => {
    const team = event.teams.find((candidate) => candidate.id === teamId);
    return team === undefined || team.seed <= 0 ? null : team.seed;
  };

  /**
   * One side of a match: seed, who, score.
   *
   * Three columns rather than a line of text, which is what every bracket
   * anybody has read looks like: the seeds line up down the left edge and the
   * scores down the right, so a column of matches can be scanned without
   * reading any of it. Two of these, flush against each other, are a match.
   */
  const side = (teamId: string | null, score: number | null) => {
    const seed = seedOf(teamId);
    const classes = ["tournament-match-side"];
    if (entry.winner !== null && entry.winner === teamId) classes.push("is-winner");
    if (teamId !== null && teamId === mine) classes.push("is-mine");
    if (teamId === null) classes.push("is-tbd");
    return (
      <span className={classes.join(" ")}>
        <span className="tournament-match-seed mono">{seed ?? ""}</span>
        <span className="tournament-match-who">
          <TeamName event={event} profiles={profiles} teamId={teamId} />
        </span>
        {/* A walkover stores the absent side at -1. It is not a score. */}
        {teamId !== null && entry.forfeit === teamId && score !== null && score < 0 ? (
          <span className="tournament-match-score mono" title={t("tournaments.match.forfeited")}>
            {t("tournaments.match.forfeitShort")}
          </span>
        ) : (
          <span className="tournament-match-score mono">{score ?? ""}</span>
        )}
      </span>
    );
  };

  return (
    <div className={`surface tournament-match is-${entry.status}`}>
      {/* Pair on the left, controls on the right. They used to sit under the
          two rows, which a card one slot high has no room for: on a match that
          can be hosted *and* reported, the buttons ran over the card below it.
          Beside the rows they cost width, which a bracket column has, rather
          than height, which it does not. */}
      {/* The pair, in its own box. Two opponents are the one thing on this
          screen that belongs tightly together, and in a first round of eight
          cards stacked flush against each other they read as a list of sixteen
          names instead. Tight inside, spaced outside. */}
      <div className="tournament-match-pair">
        {side(entry.team1, entry.score1)}
        {side(entry.team2, entry.score2)}
      </div>

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
        <MatchActions
          event={event}
          entry={entry}
          busy={busy}
          onReport={onReport}
          onAnswer={onAnswer}
          onHost={onHost}
          vetoOpen={vetoOpen}
          onToggleVeto={onToggleVeto}
        />
      </div>

    </div>
  );
}

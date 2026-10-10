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
//
// The 3rd place match is the one card outside that grid. It hangs under the
// final, in the final's own column, the way the website and most printed
// brackets show it, and it is joined to nothing: its two players come from the
// semi-finals' losers, and a line from there would cross the final's.

import { memo, useState, type CSSProperties } from "react";
import { Button } from "../../../design-system/Button";
import type {
  BracketSide,
  FfaReport,
  PlayerSummary,
  Tourney,
  TourneyAdmin,
  TourneyMatch,
  VaultMap,
} from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";
import { FfaLobby } from "./FfaLobby";
import { VetoOverlay } from "./VetoOverlay";
import { ReplayMenu } from "./ReplayMenu";
import { Icon } from "../../../design-system/Icon";
import { MatchActions, TeamName, teamNameOf } from "./matchParts";
import { feedersOf, matchLabel } from "./matchLabels";
import { useTourneyDisplay } from "../display";
import { PreviewBracket, RoundMapBlock, StopNotice } from "./BracketParts";
import { bracketPreview, columnLabel, divisionLabel, isPhantom, neverPlayed } from "./bracketPresentation";
import { SwissRounds } from "./SwissRounds";
import { PickPhasePanel } from "./PickPhasePanel";
import { RoundOneEditor } from "./RoundOneEditor";
import type { MatchActions as MatchCommands } from "../tourneyActions";
import { playoffOrigin } from "./swissPresentation";
import { hasVeto } from "./vetoPresentation";
import { BRACKET_LABELS, myTeamId } from "../tourneyPresentation";
import {
  hasGames,
  mayAddThirdPlace,
  mayRemoveThirdPlace,
  maySetRoundBestOf,
  thirdPlaceMatch,
} from "../../../shared/rules/tourneyRules";

/** The series lengths the service accepts. */
const BEST_OF = [1, 3, 5, 7];

interface Column {
  round: number;
  matches: TourneyMatch[];
  /** The column's own bracket, where it is not its side's: the grand final. */
  bracket?: TourneyMatch["bracket"];
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
    // Never a side of its own in practice: the view hangs it under the final.
    thirdPlace: 3,
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
 * The grand final as the winners bracket's last column rather than a side of
 * its own.
 *
 * The winners final's winner walks straight into it, so it continues that
 * tree: drawn apart, under its own heading, it was a third bracket of one card
 * that read like a separate event. The losers bracket still feeds its second
 * slot, from below, without a line. The bracket preview has always drawn it
 * this way.
 */
export function withGrandFinalInWinners(sides: Side[]): Side[] {
  const winners = sides.find((side) => side.bracket === "winners");
  const final = sides.find((side) => side.bracket === "grandFinal");
  if (winners === undefined || final === undefined) return sides;
  const merged: Side = {
    ...winners,
    columns: [...winners.columns, ...final.columns.map((column) => ({ ...column, bracket: final.bracket }))],
  };
  return sides.filter((side) => side !== final).map((side) => (side === winners ? merged : side));
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
  vault: VaultMap[];
  /** Where the service lives, for the organisers' uploaded map pictures. */
  assetBase: string;
  /**
   * Reporting, hosting, the vetoes, a card's replay line, and reading the
   * event again silently while seeds are picking.
   */
  matches: MatchCommands;
  /** An organiser's single-call change: the 3rd place match, a round's length. */
  onAdmin: (change: TourneyAdmin) => void;
  /** Whether any write is in flight, for the pick phase and round 1 editor. */
  busy?: boolean;
  /** Bind a pool to a round, from the round's map block. Organisers only. */
  onAssignPool?: (key: string, poolId: string) => void;
}

/**
 * How a card joins the round before it, where a feeder is not drawn: a bye,
 * or a losers match only a bye fed, leaves one arm of the bracket with
 * nothing at its end, so that arm is not drawn either.
 */
function missingArms(entry: TourneyMatch, feeders: ReturnType<typeof feedersOf>): string[] {
  const classes: string[] = [];
  for (const slot of [1, 2] as const) {
    const feeder = feeders.get(`${entry.id}:${slot}`);
    if (feeder === undefined || feeder.kind !== "winner" || !isPhantom(feeder.from)) continue;
    if (feeder.from.bracket === entry.bracket && feeder.from.round === entry.round - 1) {
      classes.push(feeder.from.index % 2 === 0 ? "no-top" : "no-bottom");
      if (slot === 2) classes.push("no-stub");
    }
  }
  return classes;
}

/** How the lines into a card leave the cards before it. */
interface IncomingLines {
  classes: string[];
  style: CSSProperties;
}

/**
 * Where the lines into a card start: on the winner's row of each card that
 * feeds it, the top row or the bottom one, and between the two while the
 * match has no winner, or while streamer mode hides it. They end in the
 * middle of this card's pair, so a line reads as "this player went on to
 * that match" rather than joining two boxes.
 *
 * A bracket's two feeders are told apart by their place in the round before,
 * as `missingArms` does; each passes its row to the CSS as a variable. A
 * straight run has one feeder from its own side, and its row is a class,
 * since the run bends up or down to meet the middle.
 */
function incomingLines(
  entry: TourneyMatch,
  feeders: ReturnType<typeof feedersOf>,
  hidden: (from: TourneyMatch) => boolean,
): IncomingLines {
  const classes: string[] = [];
  const style: Record<string, string> = {};
  for (const slot of [1, 2] as const) {
    const feeder = feeders.get(`${entry.id}:${slot}`);
    if (feeder === undefined || feeder.kind !== "winner" || isPhantom(feeder.from)) continue;
    // The round before, in this bracket; or, into the grand final, the winners
    // final it continues (`withGrandFinalInWinners`).
    const previous =
      entry.bracket === "grandFinal"
        ? feeder.from.bracket === "winners"
        : feeder.from.bracket === entry.bracket && feeder.from.round === entry.round - 1;
    if (!previous) continue;
    const from = feeder.from;
    const row =
      hidden(from) || from.winner === null
        ? "mid"
        : from.winner === from.team1
          ? "top"
          : from.winner === from.team2
            ? "bottom"
            : "mid";
    style[from.index % 2 === 0 ? "--line-in-1" : "--line-in-2"] = `var(--row-${row})`;
    if (row !== "mid" && !classes.includes(`in-${row}`)) classes.push(`in-${row}`);
  }
  return { classes, style };
}

/**
 * Memoised: the pane above it redraws for a chat poll, a pinned room's posts
 * and the tab's minute tick, none of which changes a bracket. Its props are
 * the event, the store's own arrays and the open event's command groups, which
 * keep their identity across those redraws.
 */
export const BracketView = memo(function BracketView({
  event,
  profiles,
  busyMatchId,
  vault,
  assetBase,
  matches,
  onAdmin,
  busy = false,
  onAssignPool,
}: BracketViewProps) {
  const { t } = useTranslation();
  const display = useTourneyDisplay();
  const { report: onReport, answer: onAnswer, host: onHost, veto, reportFfa: onReportFfa, watchReplay: onWatchReplay } =
    matches;
  const onRefresh = matches.refresh;
  const rawThird = thirdPlaceMatch(event);
  // A 3rd place match nobody reaches is a bye like any other, and divisions
  // have none: each is its own bracket.
  const third = rawThird !== null && !isPhantom(rawThird) && event.divisions <= 1 ? rawThird : null;
  // A Swiss stage is a list of rounds, not a tree: see `SwissRounds`. What is
  // left for the columns is a playoff bracket, where the stage feeds one.
  const swissStage = event.bracketKind === "swiss" && event.competition !== "freeForAll";
  const playoffs = event.matches.filter(
    (entry) => entry.bracket === "winners" || entry.bracket === "losers",
  );
  const drawn = (
    swissStage
      ? playoffs.length > 0
        ? event.matches.filter((entry) => entry.bracket !== "swiss")
        : []
      : event.matches
  ).filter((entry) => entry.bracket !== "thirdPlace");
  // Divisions are separate brackets, each under its own name, as the website
  // draws them: grouped by round alone, two divisions' first rounds merged
  // into one column.
  const blocks =
    event.divisions > 1 && !swissStage
      ? Array.from({ length: event.divisions }, (_, index) => ({
          division: index + 1,
          sides: withGrandFinalInWinners(groupIntoSides(drawn.filter((entry) => entry.division === index + 1))),
        })).filter((block) => block.sides.length > 0)
      : [{ division: 0, sides: withGrandFinalInWinners(groupIntoSides(drawn)) }];
  const sides = blocks.flatMap((block) => block.sides);
  const feeders = feedersOf(event.matches);
  /**
   * An organiser's best-of for a whole round, in its header.
   *
   * Only while a match in it can still change: the service skips every match
   * that has begun, and a select that changed nothing would read as broken.
   */
  const roundBestOf = (bracket: BracketSide, column: Column, division = 0) => {
    if (!maySetRoundBestOf(event, bracket, column.round)) return null;
    const open = column.matches.find((entry) => entry.status !== "done" && !hasGames(entry));
    const current = (open ?? column.matches[0])?.bestOf ?? 3;
    return (
      <select
        className="tournament-round-bo"
        value={current}
        aria-label={t("tournaments.bracket.roundBestOf")}
        title={t("tournaments.bracket.roundBestOfHint")}
        onChange={(changed) =>
          onAdmin({
            type: "roundBestOf",
            payload: {
              bracket,
              round: column.round,
              bestOf: Number(changed.target.value),
              division: division > 0 ? division : null,
            },
          })
        }
      >
        {BEST_OF.map((bo) => (
          <option key={bo} value={bo}>
            {`Bo${bo}`}
          </option>
        ))}
      </select>
    );
  };
  /** Whether a semi-final has been played, which the add hint mentions. */
  const semiPlayed =
    third === null &&
    event.matches.some((entry) => {
      if (entry.bracket !== "winners" || entry.status !== "done" || entry.winnerTo === null) {
        return false;
      }
      const next = event.matches.find((held) => held.id === entry.winnerTo?.matchId);
      return next !== undefined && next.winnerTo === null;
    });
  /**
   * The round whose map pool is open, by its service key, or null.
   *
   * One at a time and held here rather than in the header button, because the
   * panel it opens cannot live inside the bracket box: that box scrolls
   * sideways, and a scroll container clips its own absolutely positioned
   * children. So the button is in the round's header and the panel is under the
   * whole side, which also means it is readable at any bracket width.
   */
  /** The match whose ban and pick run is open, by id, or null. */
  const [openVeto, setOpenVeto] = useState<string | null>(null);

  // The main bracket's pick phase comes before any draw: until the last pick
  // it is the whole section.
  if (event.picks !== null && event.picks.open && !event.picks.stageTwo) {
    return <PickPhasePanel event={event} picks={event.picks} busy={busy} onAdmin={onAdmin} onRefresh={onRefresh} />;
  }

  // Swiss round 1 by hand, for the organiser: before the start it pins a
  // plan, and once running it holds until anything in round 1 begins.
  const roundOneEditor =
    swissStage && event.viewer.organiser && (event.status === "drafted" || event.roundOneOpen) ? (
      <RoundOneEditor key={`${event.status}-${event.matches.length}`} event={event} busy={busy} onAdmin={onAdmin} />
    ) : null;

  if (event.matches.length === 0) {
    // An elimination bracket is drawn before it exists, as the website does:
    // the shape it will have, with seeds where no team is placed yet.
    if (!swissStage && event.competition === "team" && !event.imported) {
      return (
        <>
          <StopNotice event={event} />
          <PreviewBracket
            event={event}
            preview={bracketPreview(event, t)}
            vault={vault}
            assetBase={assetBase}
            onAdmin={onAdmin}
            onAssignPool={onAssignPool}
          />
        </>
      );
    }
    return (
      <>
        {roundOneEditor}
        <p className="muted">{t("tournaments.bracket.notDrawn")}</p>
      </>
    );
  }

  const stagePicks = event.picks !== null && event.picks.stageTwo && event.picks.open ? event.picks : null;

  const card = (entry: TourneyMatch, arms: string[], lines?: IncomingLines) =>
    isPhantom(entry) ? (
      <div key={entry.id} className="tournament-match is-phantom" aria-hidden />
    ) : (
      <MatchCard
        key={entry.id}
        arms={[...arms, ...(lines?.classes ?? [])]}
        lineStyle={lines?.style}
        onWatchReplay={onWatchReplay}
        event={event}
        entry={entry}
        profiles={profiles}
        busy={busyMatchId === entry.id}
        onReport={() => onReport(entry)}
        onAnswer={(accept) => onAnswer(entry, accept)}
        vetoOpen={openVeto === entry.id}
        onToggleVeto={() => setOpenVeto((held) => (held === entry.id ? null : entry.id))}
        onReportFfa={onReportFfa}
        profilesForFfa={profiles}
        onHost={() => onHost(entry)}
      />
    );

  /**
   * A round's header: its name with its length beside it, and its maps at
   * the far end, all on one line, so the strip of headers reads straight
   * across the bracket.
   */
  const roundHead = (bracket: BracketSide, column: Column, division: number, label: string) => (
    <div className="tournament-round-head">
      <h5>{label}</h5>
      {roundBestOf(bracket, column, division) ?? (
        <span className="tournament-round-bo-text">
          {t("tournaments.matches.bestOf", { count: column.matches[0]?.bestOf ?? 3 })}
        </span>
      )}
      {/* Which maps this round is played on, next to the round it belongs
          to. It was two sections away, in Manage, which only an organiser can
          open: a player wanting to know what they are about to play had
          nowhere to look. */}
      <RoundMapBlock
        event={event}
        bracket={bracket}
        round={column.round}
        vault={vault}
        assetBase={assetBase}
        bestOf={column.matches[0]?.bestOf ?? 3}
        onAdmin={onAdmin}
        onAssignPool={onAssignPool}
      />
    </div>
  );
  const builtPlayoffs = swissStage && event.playoffs !== null && event.playoffs.built ? event.playoffs : null;

  return (
    <div className="tournament-bracket">
      <StopNotice event={event} />
      {/* The organiser's switch for the 3rd place match, above the bracket, and
          only while it can still be switched: added any time the event runs,
          taken away until anything happens in it. */}
      {mayAddThirdPlace(event) && event.divisions <= 1 && (
        <div className="tournament-third-tools">
          <Button onClick={() => onAdmin({ type: "thirdPlace", payload: { on: true } })}>
            {t("tournaments.bracket.addThirdPlace")}
          </Button>
          <span className="muted">
            {t(
              semiPlayed
                ? "tournaments.bracket.addThirdPlaceHintPlayed"
                : "tournaments.bracket.addThirdPlaceHint",
            )}
          </span>
        </div>
      )}
      {mayRemoveThirdPlace(event) && (
        <div className="tournament-third-tools">
          <Button onClick={() => onAdmin({ type: "thirdPlace", payload: { on: false } })}>
            {t("tournaments.bracket.removeThirdPlace")}
          </Button>
          <span className="muted">{t("tournaments.bracket.removeThirdPlaceHint")}</span>
        </div>
      )}
      {stagePicks !== null && (
        <PickPhasePanel event={event} picks={stagePicks} busy={busy} onAdmin={onAdmin} onRefresh={onRefresh} />
      )}
      {swissStage && sides.length > 0 && (
        <header className="tournament-playoffs-head">
          <h4>
            {builtPlayoffs !== null
              ? t(builtPlayoffs.double ? "tournaments.playoffs.headDouble" : "tournaments.playoffs.headSingle", {
                  count: builtPlayoffs.cutTo,
                })
              : t("tournaments.swiss.playoffs")}
          </h4>
          {builtPlayoffs !== null && <p className="muted">{playoffOrigin(event, t)}</p>}
        </header>
      )}
      {blocks.map((block) => (
        <div className="tournament-division" key={block.division}>
          {block.division > 0 && <h3>{divisionLabel(block.division, t)}</h3>}
          {block.sides.map((rawSide) => {
            // A column that is nothing but byes is not drawn at all; one that
            // has a real game keeps its byes as empty slots, so the lines
            // still meet.
            const side = {
              ...rawSide,
              columns: rawSide.columns.filter((column) => column.matches.some((entry) => !isPhantom(entry))),
            };
            if (side.columns.length === 0) return null;
            const layouts = columnLayouts(side.columns);
            const deepest = Math.max(...rawSide.columns.map((column) => column.round));
            const withThird = third !== null && side.bracket === "winners";
            // The 3rd place match hangs under the winners final, which is not
            // the last column once a grand final follows it.
            const finalIndex = side.columns.reduce(
              (found, column, index) => (column.bracket === undefined ? index : found),
              side.columns.length - 1,
            );
            const real = side.columns.reduce(
              (sum, column) => sum + column.matches.filter((entry) => !isPhantom(entry)).length,
              0,
            );
            return (
              <section className="tournament-bracket-side" key={side.bracket}>
                {/* Each half under its own name, with how much of it there is:
                    a double elimination is three brackets read one after
                    another, and without a frame each they ran together. */}
                <header className="tournament-bracket-side-head">
                  {block.sides.length > 1 && <h4>{t(BRACKET_LABELS[side.bracket])}</h4>}
                  <span>
                    {t("tournaments.bracket.roundCount", { count: side.columns.length })}
                    {" · "}
                    {t("tournaments.bracket.matchCount", { count: real + (withThird ? 1 : 0) })}
                  </span>
                </header>
                <div className="tournament-bracket-columns">
                  {side.columns.map((column, index) => (
                    <div
                      className={`tournament-round is-${layouts[index].link}`}
                      key={`${column.bracket ?? side.bracket}-${column.round}`}
                    >
                      {roundHead(
                        column.bracket ?? side.bracket,
                        column,
                        block.division,
                        columnLabel(event, column.bracket ?? side.bracket, column.round, deepest, t),
                      )}
                      {/* `--pitch` is how far apart this round's cards sit, as
                          a multiple of one card slot, and the CSS draws the
                          connectors from it: a card sits exactly at the
                          midpoint of the pair feeding it, so an elbow is a
                          fixed offset rather than a measured one. */}
                      <div
                        className="tournament-round-matches"
                        style={{ "--pitch": layouts[index].pitch } as CSSProperties}
                      >
                        {column.matches.map((entry) =>
                          card(entry, missingArms(entry, feeders), incomingLines(entry, feeders, display.masked)),
                        )}
                      </div>
                      {/* The 3rd place match, under the final in the final's
                          own column, behind a dashed rule and under a header
                          of its own: its own name, its own length and its own
                          pool, which need not be the final's. It sits after
                          the column's card stack rather than inside it, so the
                          final keeps its place between the semi-finals, and it
                          is joined to nothing: its players are the
                          semi-finals' losers, and a line from there would
                          cross the final's. */}
                      {withThird && third !== null && index === finalIndex && (
                        <div
                          className="tournament-third-place"
                          style={{ "--pitch": layouts[index].pitch } as CSSProperties}
                        >
                          {roundHead(
                            "thirdPlace",
                            { round: third.round, matches: [third] },
                            0,
                            t("tournaments.bracket.colThirdPlace"),
                          )}
                          <div className="tournament-round-matches">{card(third, [])}</div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      ))}
      {swissStage && (
        <>
          {sides.length > 0 && <h4>{t("tournaments.swiss.stage")}</h4>}
          {roundOneEditor}
          <SwissRounds
            event={event}
            profiles={profiles}
            busyMatchId={busyMatchId}
            withFinal={playoffs.length === 0}
            hideUpcoming={builtPlayoffs !== null}
            onReport={onReport}
            onAnswer={onAnswer}
            onHost={onHost}
            vault={vault}
            assetBase={assetBase}
            veto={veto}
          />
        </>
      )}
      {openVeto !== null &&
        (() => {
          const entry = event.matches.find((candidate) => candidate.id === openVeto);
          if (entry === undefined || !hasVeto(event, entry)) return null;
          return (
            <VetoOverlay
              event={event}
              entry={entry}
              vault={vault}
              assetBase={assetBase}
              profiles={profiles}
              busy={busyMatchId === entry.id}
              handlers={veto}
              onClose={() => setOpenVeto(null)}
            />
          );
        })()}
    </div>
  );
});

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
  /** Connector arms with nothing at their end: see `missingArms`. */
  arms: string[];
  /** Where the lines into this card start: see `incomingLines`. */
  lineStyle?: CSSProperties;
  onWatchReplay?: (uid: number) => void;
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
  arms,
  lineStyle,
  onWatchReplay,
}: MatchCardProps) {
  const { t } = useTranslation();
  const display = useTourneyDisplay();
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
  // Streamer mode: a finished match draws as not yet played until revealed,
  // and a slot filled by a hidden result says where it comes from instead of
  // who, or the next round would give the result away.
  const masked = display.masked(entry);
  const hiddenFeed = (slot: 1 | 2) => {
    const feeder = feedersOf(event.matches).get(`${entry.id}:${slot}`);
    return feeder !== undefined && display.masked(feeder.from) ? feeder : null;
  };
  const side = (teamId: string | null, score: number | null, slot: 1 | 2) => {
    const seed = seedOf(teamId);
    const classes = ["tournament-match-side"];
    const feed = teamId !== null ? hiddenFeed(slot) : null;
    if (!masked && entry.winner !== null && entry.winner === teamId) classes.push("is-winner");
    if (teamId !== null && teamId === mine && feed === null) classes.push("is-mine");
    if (teamId === null || feed !== null) classes.push("is-tbd");
    if (feed !== null) {
      return (
        <span className={classes.join(" ")}>
          <span className="tournament-match-seed mono" />
          <span className="tournament-match-who muted">
            {t(feed.kind === "winner" ? "tournaments.matches.winnerOf" : "tournaments.matches.loserOf", {
              match: matchLabel(event, feed.from, t),
            })}
          </span>
          <span className="tournament-match-score mono" />
        </span>
      );
    }
    return (
      <span className={classes.join(" ")}>
        <span className="tournament-match-seed mono">{seed ?? ""}</span>
        <span className="tournament-match-who">
          <TeamName event={event} profiles={profiles} teamId={teamId} asPlayers={display.showPlayers} />
        </span>
        {masked ? (
          <span className="tournament-match-score mono" />
        ) : /* A walkover stores the absent side at -1. It is not a score. */
        teamId !== null && entry.forfeit === teamId && score !== null && score < 0 ? (
          <span className="tournament-match-score mono" title={t("tournaments.match.forfeited")}>
            {t("tournaments.match.forfeitShort")}
          </span>
        ) : (
          <span className="tournament-match-score mono">{score ?? ""}</span>
        )}
      </span>
    );
  };

  const replays = [...entry.replayIds, ...entry.drawReplayIds];
  const state = masked ? "ready" : entry.status;

  return (
    <div
      className={[
        "tournament-match",
        `is-${state}`,
        ...(neverPlayed(event, entry) ? ["is-not-played"] : []),
        ...arms.map((arm) => `is-${arm}`),
      ].join(" ")}
      style={lineStyle}
    >
      <div className="tournament-match-pair">
        {side(entry.team1, entry.score1, 1)}
        {side(entry.team2, entry.score2, 2)}
      </div>

      {/* The strip under the pair: which match and where it is up to on the
          left, and on the right everything there is to press, the replays
          and whatever this viewer may do, as one row of small icons. It is
          on every card, so every card is the same height, which the
          connectors are computed from. The controls used to be a column of
          their own beside the scores, and the replays a row of numbered
          links under them. */}
      <div className="tournament-match-foot">
        {pending !== null && !masked ? (
          // A submitted score waiting for the other side: the line both need
          // to see, so it takes the strip's text.
          (() => {
            const text = t("tournaments.match.awaiting", {
              who: pending.byName || teamName(pending.byTeam),
              score: `${pending.score1}–${pending.score2}`,
            });
            return (
              <span className="tournament-match-pending" title={text}>
                {text}
              </span>
            );
          })()
        ) : (
          <span className="tournament-match-status">
            <span className="tournament-match-label mono">{matchLabel(event, entry, t)}</span>
            {neverPlayed(event, entry) ? (
              <span className="tournament-match-state">{t("tournaments.bracket.notPlayed")}</span>
            ) : state === "live" ? (
              <span className="tournament-match-state is-live">{t("tournaments.matches.stateLive")}</span>
            ) : state === "ready" && entry.team1 !== null && entry.team2 !== null ? (
              <span className="tournament-match-state is-ready">{t("tournaments.matches.stateReady")}</span>
            ) : null}
          </span>
        )}

        <span className="tournament-match-tools">
          {/* The FAF replays, played here in the client rather than linked to
              the vault page. */}
          {!masked && onWatchReplay !== undefined && replays.length > 0 && (
            <ReplayMenu ids={replays} onWatch={onWatchReplay} />
          )}
          {display.streamer && entry.status === "done" && (
            <button
              type="button"
              className="tournament-match-replay"
              title={t(masked ? "tournaments.display.reveal" : "tournaments.display.hide")}
              aria-label={t(masked ? "tournaments.display.reveal" : "tournaments.display.hide")}
              onClick={() => display.toggleReveal(entry.id)}
            >
              <Icon name="eye" size={12} />
            </button>
          )}
          {!masked && (
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
          )}
        </span>
      </div>
    </div>
  );
}

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
import { Button } from "../../design-system/Button";
import { Modal } from "../../design-system/Modal";
import { Icon } from "../../design-system/Icon";
import type {
  FfaReport,
  PlayerSummary,
  Tourney,
  TourneyMatch,
  VaultMap,
} from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";
import { FfaLobby } from "./FfaLobby";
import { PlayerChip } from "./PlayerChip";
import { VetoPanel } from "./VetoPanel";
import { BRACKET_LABELS, isMyMatch, myTeamId } from "./tourneyPresentation";
import {
  matchVaultMap,
  mayReport,
  poolForRound,
  roundKeyOf,
} from "../../shared/tourneyRules";

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
  onVetoAct: (matchId: string, mapId: string) => void;
  onVetoSetSides: (matchId: string, teamA: string) => void;
  onVetoUndo: (matchId: string) => void;
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
  onVetoAct,
  onVetoSetSides,
  onVetoUndo,
  onReportFfa,
}: BracketViewProps) {
  const { t } = useTranslation();
  const sides = groupIntoSides(event.matches);
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
                if (entry === undefined || entry.veto === null) return null;
                return (
                  <div className="tournament-veto-drawer surface">
                    <VetoPanel
                      event={event}
                      entry={entry}
                      vault={vault}
                      profiles={profiles}
                      busy={busyMatchId === entry.id}
                      onAct={onVetoAct}
                      onSetSides={onVetoSetSides}
                      onUndo={onVetoUndo}
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
                  roundKey={openPool}
                  onClose={() => setOpenPool(null)}
                />
              )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The button that opens a round's map pool.
 *
 * Nothing at all where no pool is bound, which is most rounds of most events: a
 * button that opens on "none" is worse than no button.
 */
function PoolToggle({
  event,
  roundKey,
  open,
  onToggle,
}: {
  event: Tourney;
  roundKey: string;
  open: boolean;
  onToggle: (roundKey: string) => void;
}) {
  const { t } = useTranslation();
  const pool = poolForRound(event, roundKey);
  if (pool === null) return null;
  return (
    <button
      type="button"
      className={
        open
          ? "tournament-round-pool-toggle is-open"
          : "tournament-round-pool-toggle"
      }
      aria-expanded={open}
      onClick={() => onToggle(roundKey)}
      title={t("tournaments.bracket.poolHint", { name: pool.name })}
    >
      <Icon name="maps" size={12} /> {t("tournaments.bracket.pool")}
    </button>
  );
}

/**
 * The maps one round is played on.
 *
 * The maps come from the event's own database, with a preview from FAF's vault
 * where the name matches something in it, which is the one thing this client can
 * show here that the website cannot.
 */
function PoolPanel({
  event,
  vault,
  roundKey,
  onClose,
}: {
  event: Tourney;
  vault: VaultMap[];
  roundKey: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const pool = poolForRound(event, roundKey);
  if (pool === null) return null;

  const named = (mapId: string) => {
    const held = event.mapDb.find((candidate) => candidate.id === mapId);
    if (held === undefined) return { name: mapId, image: "" };
    const vaultMap = matchVaultMap(held, vault);
    return {
      name: vaultMap?.displayName ?? held.name,
      image: vaultMap?.thumbnailUrl || held.imageUrl,
    };
  };

  // An overlay rather than a panel under the bracket. It is a grid of pictures
  // that answers one question and is then finished with, which is what an
  // overlay is for: it opens over whatever the reader was looking at, keeps its
  // place, and Escape or a click outside gives it back. The map generator's
  // preview works the same way, so this is one pattern in the client rather
  // than two for the same thing.
  return (
    <Modal onClose={onClose} ariaLabel={pool.name} className="tournament-pool-modal">
      <header className="tournament-pool-modal-head">
        <h4>{pool.name}</h4>
        <span className="muted">
          {t("tournaments.bracket.poolCount", { count: pool.mapIds.length })}
        </span>
      </header>
      {pool.mapIds.length === 0 ? (
        <p className="muted">{t("tournaments.pools.empty")}</p>
      ) : (
        <ul className="tournament-veto-grid">
          {pool.mapIds.map((mapId) => {
            const map = named(mapId);
            return (
              <li className="tournament-veto-map" key={mapId}>
                {map.image === "" ? (
                  <span className="tournament-pool-map-blank" aria-hidden />
                ) : (
                  <img src={map.image} alt="" loading="lazy" aria-hidden />
                )}
                <span>{map.name}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
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
  // Twins of `Tourney::may_report` and `may_confirm`. Offering a control the
  // server refuses is worse than offering none: the player fills in a score and
  // loses it.
  const playable =
    (entry.status === "ready" || entry.status === "live") &&
    entry.team1 !== null &&
    entry.team2 !== null;
  const reportable = mayReport(event, entry);
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
    const profile = profileOf(teamId);
    const seed = seedOf(teamId);
    const classes = ["tournament-match-side"];
    if (entry.winner !== null && entry.winner === teamId) classes.push("is-winner");
    if (teamId !== null && teamId === mine) classes.push("is-mine");
    if (teamId === null) classes.push("is-tbd");
    return (
      <span className={classes.join(" ")}>
        <span className="tournament-match-seed mono">{seed ?? ""}</span>
        <span className="tournament-match-who">
          {profile ? (
            <PlayerChip player={profile} overrideName={teamName(teamId)} />
          ) : (
            teamName(teamId)
          )}
        </span>
        <span className="tournament-match-score mono">{score ?? ""}</span>
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
        {!mayAnswer && (
          <>
            {/* Hosting is offered to everyone watching, not just the two
                players: a caster or an organiser opening the lobby is normal. */}
            {playable && (
              <Button onClick={onHost} title={t("tournaments.match.hostHint")}>
                <Icon name="play" size={14} /> {t("tournaments.match.host")}
              </Button>
            )}
            {/* The run itself opens under the bracket. A card is 210 pixels
                wide and one slot high; a grid of maps is neither, and every
                card drawing its own was what made this tab unusable. */}
            {entry.veto !== null && event.veto.enabled && (
              <button
                type="button"
                className={
                  vetoOpen
                    ? "tournament-round-pool-toggle is-open"
                    : "tournament-round-pool-toggle"
                }
                aria-expanded={vetoOpen}
                onClick={onToggleVeto}
                title={t("tournaments.veto.openHint")}
              >
                <Icon name="maps" size={12} /> {t("tournaments.veto.open")}
              </button>
            )}
            {reportable && (
              <Button variant="primary" onClick={onReport} disabled={busy}>
                {t(
                  busy
                    ? "tournaments.match.reporting"
                    : entry.status === "done"
                      ? "tournaments.match.correct"
                      : "tournaments.match.report",
                )}
              </Button>
            )}
          </>
        )}
      </div>

    </div>
  );
}

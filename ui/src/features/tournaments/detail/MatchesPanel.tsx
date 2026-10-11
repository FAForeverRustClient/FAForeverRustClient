// The Matches tab: every head-to-head match of the event as a table, in the
// website's four sections (`drawMatchesTab`): the viewer's own, the ones being
// played or about to be, the ones still waiting on an earlier result, and the
// finished ones, newest first.
//
// The bracket answers "how does the event hang together"; this answers "what
// is on, and how did it go", which a bracket forty matches wide cannot. A row
// opens the match's details: both rosters, the score, the replays, and the
// vetoes, with whatever the viewer may do about it.

import { memo, useState } from "react";
import { Button } from "../../../design-system/Button";
import { Modal } from "../../../design-system/Modal";
import type {
  PlayerSummary,
  Tourney,
  TourneyAdmin,
  TourneyMatch,
  VaultMap,
} from "../../../ipc/bindings";
import type { MessageKey } from "../../../i18n";
import { useTranslation } from "../../../i18n/useTranslation";
import { byPlayOrder, feedersOf, matchLabel, matchRank, type Feeder } from "../bracket/matchLabels";
import { MatchActions, TeamName, teamNameOf } from "../bracket/matchParts";
import { isBye } from "../bracket/swissRecords";
import { VetoPanel } from "../bracket/VetoPanel";
import type { MatchActions as MatchCommands } from "../tourneyActions";
import { hasVeto, myVetoSteps, vetoSettled } from "../bracket/vetoPresentation";
import { hasGames, maySetMatchBestOf } from "../../../shared/rules/tourneyRules";
import { matchPoolKey, poolForMatch } from "../bracket/poolPresentation";
import { BYE, neverPlayed } from "../bracket/bracketPresentation";
import { playersLabel, useTourneyDisplay } from "../display";

/** The series lengths the service accepts. */
const BEST_OF = [1, 3, 5, 7];

interface MatchesPanelProps {
  event: Tourney;
  profiles: PlayerSummary[];
  vault: VaultMap[];
  assetBase: string;
  busyMatchId: string | null;
  /** Reporting, hosting, the replays and the vetoes. */
  matches: MatchCommands;
  /** An organiser's single-call change: here, one match's length. */
  onAdmin: (change: TourneyAdmin) => void;
  /** Bind a pool to a key (`match:<id>`), or clear it with an empty id. */
  onAssignPool?: (key: string, poolId: string) => void;
}

type MatchState = "notPlayed" | "waiting" | "done" | "vetoes" | "live" | "ready";

const STATE_LABELS: Record<MatchState, MessageKey> = {
  notPlayed: "tournaments.matches.stateNotPlayed",
  waiting: "tournaments.matches.stateWaiting",
  done: "tournaments.matches.stateDone",
  vetoes: "tournaments.matches.stateVetoes",
  live: "tournaments.matches.stateLive",
  ready: "tournaments.matches.stateReady",
};

/** Where a match stands, in the website's order of checks. */
export function matchState(event: Tourney, entry: TourneyMatch): MatchState {
  // First, as on the website: an early finish decides these whatever else
  // the match says.
  if (neverPlayed(event, entry)) return "notPlayed";
  if (entry.team1 === null || entry.team2 === null) {
    return event.status === "finished" ? "notPlayed" : "waiting";
  }
  if (entry.status === "done") return "done";
  if (hasVeto(event, entry) && !vetoSettled(event, entry)) return "vetoes";
  if (entry.status === "live") return "live";
  return "ready";
}

/** The head-to-head matches worth listing: no free-for-all lobby, no bye. */
export function listedMatches(event: Tourney): TourneyMatch[] {
  return event.matches.filter((entry) => entry.bracket !== "freeForAll" && !isBye(entry));
}

/** Memoised for the same reason as `BracketView`, and with the same props. */
export const MatchesPanel = memo(function MatchesPanel(props: MatchesPanelProps) {
  const { event } = props;
  const { t } = useTranslation();
  const display = useTourneyDisplay();
  const [details, setDetails] = useState<string | null>(null);

  const all = listedMatches(event);
  if (all.length === 0) {
    return <p className="muted">{t("tournaments.matches.none")}</p>;
  }

  const feeders = feedersOf(event.matches);
  const mine = event.viewer.memberTeamId;
  const known = (entry: TourneyMatch) => entry.team1 !== null && entry.team2 !== null;
  const own = all
    .filter((entry) => mine !== null && (entry.team1 === mine || entry.team2 === mine))
    .sort(byPlayOrder);
  const upcoming = all.filter((entry) => entry.status !== "done" && known(entry)).sort(byPlayOrder);
  const undecided = all.filter((entry) => entry.status !== "done" && !known(entry)).sort(byPlayOrder);
  const finished = all
    .filter((entry) => entry.status === "done")
    .sort((left, right) => matchRank(right) - matchRank(left) || left.index - right.index);

  const slot = (entry: TourneyMatch, teamId: string | null, number: 1 | 2) => {
    const feeder: Feeder | undefined = feeders.get(`${entry.id}:${number}`);
    // Streamer mode: a slot filled by a hidden result names its feeder, not
    // who came through it.
    const hiddenFeed = feeder !== undefined && display.masked(feeder.from);
    if (teamId !== null && !hiddenFeed) {
      const winner = !display.masked(entry) && entry.winner === teamId;
      return (
        <span className={winner ? "tournament-mt-team is-winner" : "tournament-mt-team"}>
          <TeamName event={event} profiles={props.profiles} teamId={teamId} asPlayers={display.showPlayers} />
        </span>
      );
    }
    return (
      <span className="muted">
        {feeder === undefined
          ? t("tournaments.bracket.tbd")
          : t(feeder.kind === "winner" ? "tournaments.matches.winnerOf" : "tournaments.matches.loserOf", {
              match: matchLabel(event, feeder.from, t),
            })}
      </span>
    );
  };

  const table = (entries: TourneyMatch[]) => (
    <table className="tournament-mt-table">
      {/* Fixed widths, the same in every section, so the four tables read as
          one list whose columns line up down the page. */}
      <colgroup>
        <col className="tournament-mt-col-round" />
        <col />
        <col />
        <col className="tournament-mt-col-state" />
        <col className="tournament-mt-col-result" />
        <col className="tournament-mt-col-actions" />
      </colgroup>
      <thead>
        <tr>
          <th scope="col">{t("tournaments.matches.round")}</th>
          <th scope="col">{t("tournaments.matches.team1")}</th>
          <th scope="col">{t("tournaments.matches.team2")}</th>
          <th scope="col">{t("tournaments.matches.status")}</th>
          <th scope="col">{t("tournaments.matches.result")}</th>
          <th scope="col" aria-label={t("tournaments.matches.actions")} />
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => {
          const masked = display.masked(entry);
          const state = matchState(event, entry);
          const owed = myVetoSteps(event, entry);
          const isMine = mine !== null && (entry.team1 === mine || entry.team2 === mine);
          return (
            <tr key={entry.id} className={isMine ? "is-mine" : undefined}>
              <td className="mono muted tournament-mt-fixed">{matchLabel(event, entry, t)}</td>
              <td className="tournament-mt-teamcell">{slot(entry, entry.team1, 1)}</td>
              <td className="tournament-mt-teamcell">{slot(entry, entry.team2, 2)}</td>
              <td className="tournament-mt-fixed">
                {masked ? (
                  <span className="tournament-mt-state is-live">{t("tournaments.display.played")}</span>
                ) : (
                  <span className={`tournament-mt-state is-${state}`}>{t(STATE_LABELS[state])}</span>
                )}
              </td>
              <td className="mono tournament-mt-fixed">
                {masked ? <span className="muted">{t("tournaments.display.hidden")}</span> : <MatchScore entry={entry} />}
              </td>
              <td className="tournament-mt-actions tournament-mt-fixed">
                {display.streamer && entry.status === "done" && (
                  <Button onClick={() => display.toggleReveal(entry.id)}>
                    {t(masked ? "tournaments.display.revealShort" : "tournaments.display.hideShort")}
                  </Button>
                )}
                {owed > 0 && (
                  <Button variant="primary" onClick={() => setDetails(entry.id)}>
                    {t("tournaments.matches.yourVeto", { count: owed })}
                  </Button>
                )}
                <Button onClick={() => setDetails(entry.id)}>{t("tournaments.matches.details")}</Button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  const section = (title: MessageKey, entries: TourneyMatch[], empty: MessageKey | null) =>
    entries.length === 0 && empty === null ? null : (
      <section className="tournament-mt-section">
        <h5>
          {t(title)} <span className="muted">({entries.length})</span>
        </h5>
        {entries.length === 0 && empty !== null ? <p className="muted">{t(empty)}</p> : table(entries)}
      </section>
    );

  const open = details === null ? undefined : event.matches.find((entry) => entry.id === details);

  return (
    <div className="tournament-matches">
      {section("tournaments.matches.mine", own, null)}
      {section("tournaments.matches.upcoming", upcoming, "tournaments.matches.upcomingEmpty")}
      {section("tournaments.matches.undecided", undecided, null)}
      {section("tournaments.matches.finished", finished, "tournaments.matches.finishedEmpty")}
      {open !== undefined && (
        <MatchDetails {...props} entry={open} onClose={() => setDetails(null)} />
      )}
    </div>
  );
});

/** "2:1", with "FF" for a side that forfeited, or a dash before any score. */
function MatchScore({ entry }: { entry: TourneyMatch }) {
  const { t } = useTranslation();
  if (entry.score1 === null && entry.score2 === null) return <span className="muted">–</span>;
  const side = (teamId: string | null, score: number | null) =>
    teamId !== null && entry.forfeit === teamId && score !== null && score < 0
      ? t("tournaments.match.forfeitShort")
      : String(Math.max(0, score ?? 0));
  return (
    <span>
      {side(entry.team1, entry.score1)}:{side(entry.team2, entry.score2)}
    </span>
  );
}

function MatchDetails({
  entry,
  onClose,
  ...props
}: MatchesPanelProps & { entry: TourneyMatch; onClose: () => void }) {
  const { event } = props;
  const { t } = useTranslation();
  const display = useTourneyDisplay();
  const masked = display.masked(entry);
  const state = matchState(event, entry);
  const winner = (teamId: string | null) => !masked && entry.winner !== null && entry.winner === teamId;

  const roster = (teamId: string | null) => {
    const team = event.teams.find((held) => held.id === teamId);
    const players = (team?.playerIds ?? [])
      .map((id) => event.players.find((player) => player.id === id))
      .filter((player) => player !== undefined)
      .sort((left, right) => (right.rating ?? 0) - (left.rating ?? 0));
    return (
      <div className={winner(teamId) ? "tournament-md-team is-winner" : "tournament-md-team"}>
        <strong className="tournament-md-name">
          {(display.showPlayers ? playersLabel(event, teamId) : null) ??
            teamNameOf(event, teamId) ??
            t("tournaments.bracket.tbd")}
          {winner(teamId) && (
            <span className="tournament-badge">{t("tournaments.matches.winner")}</span>
          )}
        </strong>
        {players.length === 0 ? (
          <span className="muted">{t("tournaments.matches.noPlayers")}</span>
        ) : (
          <ul className="tournament-md-players">
            {players.map((player) => (
              <li key={player.id}>
                <span>{player.name}</span>
                {team?.captainId === player.id && (
                  <span className="tournament-badge" title={t("tournaments.matches.captain")}>
                    C
                  </span>
                )}
                <span className="mono muted">{player.rating ?? "–"}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  };

  const replays = (ids: string[], label: MessageKey) =>
    ids.length > 0 && (
      <p className="tournament-md-replays">
        <span className="muted">{t(label)}:</span>{" "}
        {ids.map((id) => {
          const uid = Number(id.replace(/\D/g, ""));
          return Number.isSafeInteger(uid) && uid > 0 ? (
            <button
              type="button"
              key={id}
              className="tournament-link-button mono"
              title={t("tournaments.matches.watchReplay")}
              onClick={() => props.matches.watchReplay(uid)}
            >
              {uid}
            </button>
          ) : null;
        })}
      </p>
    );

  return (
    <Modal onClose={onClose} className="tournament-md" ariaLabel={matchLabel(event, entry, t)}>
      <header className="tournament-md-head">
        <h3>{matchLabel(event, entry, t)}</h3>
        {/* The escape hatch for one series on the day: an organiser may
            lengthen or shorten it until its first game is played. The round's
            own select in the bracket is the bulk tool. */}
        {maySetMatchBestOf(event, entry) ? (
          <select
            className="tournament-round-bo"
            value={entry.bestOf}
            aria-label={t("tournaments.matches.setBestOf")}
            title={t("tournaments.matches.setBestOfHint")}
            onChange={(changed) =>
              props.onAdmin({
                type: "matchBestOf",
                payload: { matchId: entry.id, bestOf: Number(changed.target.value) },
              })
            }
          >
            {BEST_OF.map((bo) => (
              <option key={bo} value={bo}>
                {t("tournaments.matches.bestOf", { count: bo })}
              </option>
            ))}
          </select>
        ) : (
          <span className="muted mono">{t("tournaments.matches.bestOf", { count: entry.bestOf })}</span>
        )}
        <span className={`tournament-mt-state is-${state}`}>{t(STATE_LABELS[state])}</span>
      </header>
      <div className="tournament-md-grid">
        {roster(entry.team1)}
        <div className="tournament-md-score mono">
          {masked ? <span className="muted">{t("tournaments.display.hidden")}</span> : <MatchScore entry={entry} />}
          {display.streamer && entry.status === "done" && (
            <Button onClick={() => display.toggleReveal(entry.id)}>
              {t(masked ? "tournaments.display.reveal" : "tournaments.display.hide")}
            </Button>
          )}
        </div>
        {roster(entry.team2)}
      </div>
      {props.onAssignPool !== undefined && (
        <MatchPoolPicker event={event} entry={entry} onAssign={props.onAssignPool} />
      )}
      <MatchSlotEditor event={event} entry={entry} onAdmin={props.onAdmin} />
      {!masked && replays(entry.replayIds, "tournaments.matches.replays")}
      {!masked && replays(entry.drawReplayIds, "tournaments.matches.drawReplays")}
      {masked && hasVeto(event, entry) && <p className="muted">{t("tournaments.display.vetoHidden")}</p>}
      {!masked && hasVeto(event, entry) && (
        <VetoPanel
          event={event}
          entry={entry}
          vault={props.vault}
          assetBase={props.assetBase}
          profiles={props.profiles}
          busy={props.busyMatchId === entry.id}
          handlers={props.matches.veto}
        />
      )}
      <div className="tournament-form-actions">
        <MatchActions
          event={event}
          entry={entry}
          busy={props.busyMatchId === entry.id}
          onReport={() => {
            onClose();
            props.matches.report(entry);
          }}
          onAnswer={(accept) => props.matches.answer(entry, accept)}
          onHost={() => props.matches.host(entry)}
          vetoOpen
          onToggleVeto={() => undefined}
          withVeto={false}
        />
        <Button onClick={onClose}>{t("common.close")}</Button>
      </div>
    </Modal>
  );
}

/**
 * One match's own map pool, for an organiser: the website's service keeps a
 * pool per match (`pool_assign` with `match:<id>`) and its pages never offer
 * it. Useful for the one series on the day that is played on other maps, a
 * rematch or a showmatch. "The round's pool" clears it.
 *
 * The service rebuilds the veto only while no step has been taken, so once
 * one has, a new pool is stored and changes nothing; that is said rather than
 * hidden. A pool of another length is allowed, as on the service, and warned.
 */
function MatchPoolPicker({
  event,
  entry,
  onAssign,
}: {
  event: Tourney;
  entry: TourneyMatch;
  onAssign: (key: string, poolId: string) => void;
}) {
  const { t } = useTranslation();
  if (!event.viewer.organiser || event.mapPools.length === 0 || entry.status === "done") return null;
  const key = matchPoolKey(entry.id);
  const own = event.poolAssign.find((assignment) => assignment.round === key)?.poolId ?? "";
  const resolved = poolForMatch(event, entry);
  const started = entry.veto !== null && entry.veto.stepIndex > 0;
  const chosen = event.mapPools.find((pool) => pool.id === own);
  return (
    <div className="tournament-md-pool">
      <label className="tournament-field">
        <span>{t("tournaments.matches.poolLabel")}</span>
        <select value={own} onChange={(changed) => onAssign(key, changed.target.value)}>
          <option value="">
            {t("tournaments.matches.poolOfRound", {
              pool: resolved !== null && resolved.source !== "match" ? resolved.pool.name : "-",
            })}
          </option>
          {event.mapPools.map((pool) => (
            <option key={pool.id} value={pool.id}>
              {t("tournaments.matches.poolOption", {
                name: pool.name,
                bo: pool.bestOf ?? 1,
                count: pool.mapIds.length,
              })}
            </option>
          ))}
        </select>
      </label>
      {chosen !== undefined && (chosen.bestOf ?? 1) !== entry.bestOf && (
        <small className="tournament-warning">
          {t("tournaments.matches.poolLengthDiffers", { bo: entry.bestOf })}
        </small>
      )}
      {started && <small className="muted">{t("tournaments.matches.poolVetoStarted")}</small>}
    </div>
  );
}

/**
 * An organiser putting a team, a bye or nobody in a side of a match that has
 * not begun (`set_match_team`).
 *
 * The service has it and the website offers no control for it; it is how a
 * slot is repaired by hand. Held back to what cannot go wrong quietly: only
 * before the first game, only teams of the match's own division, and a bye
 * named for what it does, since it sends the other side straight through.
 */
function MatchSlotEditor({
  event,
  entry,
  onAdmin,
}: {
  event: Tourney;
  entry: TourneyMatch;
  onAdmin: (change: TourneyAdmin) => void;
}) {
  const { t } = useTranslation();
  if (!event.viewer.organiser || entry.bracket === "freeForAll") return null;
  if (!(entry.status === "waiting" || entry.status === "ready") || hasGames(entry)) return null;
  const teams = event.teams.filter((team) => entry.division === 0 || team.division === entry.division);
  const slot = (number: 1 | 2, current: string | null) => (
    <label className="tournament-field">
      <span>{t("tournaments.matches.slotLabel", { number })}</span>
      <select
        value={current ?? ""}
        onChange={(changed) => {
          const value = changed.target.value;
          if (value === BYE && !window.confirm(t("tournaments.matches.slotByeConfirm"))) return;
          onAdmin({
            type: "setMatchTeam",
            payload: { matchId: entry.id, slot: number, teamId: value === "" ? null : value },
          });
        }}
      >
        <option value="">{t("tournaments.matches.slotEmpty")}</option>
        <option value={BYE}>{t("tournaments.matches.slotBye")}</option>
        {teams.map((team) => (
          <option key={team.id} value={team.id}>
            {teamNameOf(event, team.id) ?? team.id}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <details className="tournament-md-slots">
      <summary>{t("tournaments.matches.slotsSummary")}</summary>
      <p className="muted">{t("tournaments.matches.slotsHint")}</p>
      <div className="tournament-form-row">
        {slot(1, entry.team1)}
        {slot(2, entry.team2)}
      </div>
    </details>
  );
}

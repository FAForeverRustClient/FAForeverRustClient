// The Matches tab: every head-to-head match of the event as a table, in the
// website's four sections (`drawMatchesTab`): the viewer's own, the ones being
// played or about to be, the ones still waiting on an earlier result, and the
// finished ones, newest first.
//
// The bracket answers "how does the event hang together"; this answers "what
// is on, and how did it go", which a bracket forty matches wide cannot. A row
// opens the match's details: both rosters, the score, the replays, and the
// vetoes, with whatever the viewer may do about it.

import { useState } from "react";
import { Button } from "../../../design-system/Button";
import { Modal } from "../../../design-system/Modal";
import type { PlayerSummary, Tourney, TourneyMatch, VaultMap } from "../../../ipc/bindings";
import type { MessageKey } from "../../../i18n";
import { useTranslation } from "../../../i18n/useTranslation";
import { byPlayOrder, feedersOf, matchLabel, matchRank, type Feeder } from "../bracket/matchLabels";
import { MatchActions, TeamName, teamNameOf } from "../bracket/matchParts";
import { isBye } from "../bracket/swissRecords";
import { VetoPanel, type VetoHandlers } from "../bracket/VetoPanel";
import { hasVeto, myVetoSteps, vetoSettled } from "../bracket/vetoPresentation";

interface MatchesPanelProps {
  event: Tourney;
  profiles: PlayerSummary[];
  vault: VaultMap[];
  assetBase: string;
  busyMatchId: string | null;
  onReport: (entry: TourneyMatch) => void;
  onAnswer: (entry: TourneyMatch, accept: boolean) => void;
  onHost: (entry: TourneyMatch) => void;
  onWatchReplay: (uid: number) => void;
  veto: VetoHandlers;
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

export function MatchesPanel(props: MatchesPanelProps) {
  const { event } = props;
  const { t } = useTranslation();
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
    if (teamId !== null) {
      return (
        <span className={entry.winner === teamId ? "tournament-mt-team is-winner" : "tournament-mt-team"}>
          <TeamName event={event} profiles={props.profiles} teamId={teamId} />
        </span>
      );
    }
    const feeder: Feeder | undefined = feeders.get(`${entry.id}:${number}`);
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
          const state = matchState(event, entry);
          const owed = myVetoSteps(event, entry);
          const isMine = mine !== null && (entry.team1 === mine || entry.team2 === mine);
          return (
            <tr key={entry.id} className={isMine ? "is-mine" : undefined}>
              <td className="mono muted tournament-mt-fixed">{matchLabel(event, entry, t)}</td>
              <td className="tournament-mt-teamcell">{slot(entry, entry.team1, 1)}</td>
              <td className="tournament-mt-teamcell">{slot(entry, entry.team2, 2)}</td>
              <td className="tournament-mt-fixed">
                <span className={`tournament-mt-state is-${state}`}>{t(STATE_LABELS[state])}</span>
              </td>
              <td className="mono tournament-mt-fixed">
                <MatchScore entry={entry} />
              </td>
              <td className="tournament-mt-actions tournament-mt-fixed">
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
}

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
  const state = matchState(event, entry);

  const roster = (teamId: string | null) => {
    const team = event.teams.find((held) => held.id === teamId);
    const players = (team?.playerIds ?? [])
      .map((id) => event.players.find((player) => player.id === id))
      .filter((player) => player !== undefined)
      .sort((left, right) => (right.rating ?? 0) - (left.rating ?? 0));
    return (
      <div className={entry.winner !== null && entry.winner === teamId ? "tournament-md-team is-winner" : "tournament-md-team"}>
        <strong className="tournament-md-name">
          {teamNameOf(event, teamId) ?? t("tournaments.bracket.tbd")}
          {entry.winner !== null && entry.winner === teamId && (
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
              onClick={() => props.onWatchReplay(uid)}
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
        <span className="muted mono">{t("tournaments.matches.bestOf", { count: entry.bestOf })}</span>
        <span className={`tournament-mt-state is-${state}`}>{t(STATE_LABELS[state])}</span>
      </header>
      <div className="tournament-md-grid">
        {roster(entry.team1)}
        <div className="tournament-md-score mono">
          <MatchScore entry={entry} />
        </div>
        {roster(entry.team2)}
      </div>
      {replays(entry.replayIds, "tournaments.matches.replays")}
      {replays(entry.drawReplayIds, "tournaments.matches.drawReplays")}
      {hasVeto(event, entry) && (
        <VetoPanel
          event={event}
          entry={entry}
          vault={props.vault}
          assetBase={props.assetBase}
          profiles={props.profiles}
          busy={props.busyMatchId === entry.id}
          handlers={props.veto}
        />
      )}
      <div className="tournament-form-actions">
        <MatchActions
          event={event}
          entry={entry}
          busy={props.busyMatchId === entry.id}
          onReport={() => {
            onClose();
            props.onReport(entry);
          }}
          onAnswer={(accept) => props.onAnswer(entry, accept)}
          onHost={() => props.onHost(entry)}
          vetoOpen
          onToggleVeto={() => undefined}
          withVeto={false}
        />
        <Button onClick={onClose}>{t("common.close")}</Button>
      </div>
    </Modal>
  );
}

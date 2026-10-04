// The pieces of a two-sided match that every view of it shares: who a slot is,
// and what the viewer may do with the match.
//
// The bracket card, the Swiss round list and the Matches tab all draw the same
// match, and each of them used to be one place where "may this account host,
// report or answer" could drift from the others. The rules live in
// `tourneyRules`; this is the one place that turns them into buttons.

import { useContext, useState } from "react";
import { Modal } from "../../../design-system/Modal";
import { Button } from "../../../design-system/Button";
import { Icon } from "../../../design-system/Icon";
import type { PlayerSummary, Tourney, TourneyMatch } from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";
import { mayReport, maySubmit } from "../../../shared/rules/tourneyRules";
import { PlayerChip } from "../PlayerChip";
import { isMyMatch, myTeamId } from "../tourneyPresentation";
import { hasVeto, myVetoSteps } from "./vetoPresentation";
import { isBye } from "./swissRecords";
import { MatchChatContext, mayOpenMatchChat } from "./matchChat";
import { playersLabel } from "../display";

/**
 * A slot's name as the bracket prints it, or null for a slot nobody holds yet.
 *
 * A team that never named itself reads as its first member.
 */
export function teamNameOf(event: Tourney, teamId: string | null): string | null {
  if (teamId === null) return null;
  const team = event.teams.find((candidate) => candidate.id === teamId);
  if (team === undefined) return null;
  const named = team.name.trim();
  if (named !== "") return named;
  return event.players.find((player) => player.id === team.playerIds[0])?.name ?? null;
}

/** The FAF account behind a slot, for a solo team where there is exactly one. */
export function soloProfileOf(
  event: Tourney,
  profiles: PlayerSummary[],
  teamId: string | null,
): PlayerSummary | null {
  const team = event.teams.find((candidate) => candidate.id === teamId);
  if (team === undefined || team.playerIds.length !== 1) return null;
  const fafId = event.players.find((player) => player.id === team.playerIds[0])?.fafId ?? null;
  if (fafId === null) return null;
  return profiles.find((profile) => profile.id === fafId) ?? null;
}

/**
 * A slot's name, as a player chip that opens the card where there is one
 * account. With `asPlayers`, a team is its players' names, the website's "Show
 * players": only where the website does it, so the caller decides.
 */
export function TeamName({
  event,
  profiles,
  teamId,
  asPlayers = false,
}: {
  event: Tourney;
  profiles: PlayerSummary[];
  teamId: string | null;
  asPlayers?: boolean;
}) {
  const { t } = useTranslation();
  const [popup, setPopup] = useState(false);
  const name =
    (asPlayers ? playersLabel(event, teamId) : null) ?? teamNameOf(event, teamId) ?? t("tournaments.bracket.tbd");
  const profile = soloProfileOf(event, profiles, teamId);
  if (profile) return <PlayerChip player={profile} overrideName={name} />;
  // A team of several opens its roster, the website's team popup. A solo
  // team keeps the player card above, which says more than one row would.
  const team = event.teams.find((candidate) => candidate.id === teamId);
  if (team === undefined || team.playerIds.length < 2) return <>{name}</>;
  return (
    <>
      <button type="button" className="tournament-link-button tournament-team-link" onClick={() => setPopup(true)}>
        {name}
      </button>
      {popup && <TeamPopup event={event} teamId={team.id} onClose={() => setPopup(false)} />}
    </>
  );
}

/**
 * One team's roster: the website's `showTeamPopup`. Seed and name, each
 * member by rating with the captain marked and a FAF account ticked, and the
 * combined rating against the event's cap where it has one.
 */
export function TeamPopup({ event, teamId, onClose }: { event: Tourney; teamId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const team = event.teams.find((candidate) => candidate.id === teamId);
  if (team === undefined) return null;
  const members = team.playerIds
    .map((id) => event.players.find((player) => player.id === id))
    .filter((player) => player !== undefined)
    .sort((left, right) => (right.rating ?? -1) - (left.rating ?? -1));
  const combined = members.reduce((total, player) => total + (player.rating ?? 0), 0);
  const cap = event.rating.maxTeam;
  const title = teamNameOf(event, team.id) ?? t("tournaments.bracket.tbd");
  return (
    <Modal onClose={onClose} ariaLabel={title} className="tournament-team-popup">
      <h4>
        {team.seed > 0 && <span className="tournament-match-seed mono">#{team.seed}</span>} {title}
      </h4>
      {members.length === 0 ? (
        <p className="muted">{t("tournaments.teamPopup.noMembers")}</p>
      ) : (
        <ul className="tournament-md-players">
          {members.map((player) => (
            <li key={player.id}>
              {team.captainId === player.id && (
                <span className="tournament-badge" title={t("tournaments.matches.captain")}>
                  C
                </span>
              )}
              <span>{player.name}</span>
              {player.fafId !== null && (
                <span className="muted" title={t("tournaments.teamPopup.verified")}>
                  {"✓"}
                </span>
              )}
              <span className="mono muted">{player.rating ?? "–"}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="muted">
        {t("tournaments.teams.combinedTitle")}: <span className="mono">{combined}</span>
        {cap !== null && <span className="mono"> / {cap}</span>}
      </p>
      <div className="tournament-form-actions">
        <Button onClick={onClose}>{t("common.close")}</Button>
      </div>
    </Modal>
  );
}

interface MatchActionsProps {
  event: Tourney;
  entry: TourneyMatch;
  busy: boolean;
  onReport: () => void;
  onAnswer: (accept: boolean) => void;
  onHost: () => void;
  /** Whether this match's ban and pick run is the one on screen. */
  vetoOpen: boolean;
  onToggleVeto: () => void;
  /** Offer the button that opens the vetoes. Off where they are already on screen. */
  withVeto?: boolean;
}

/**
 * The controls a viewer has on one match, and nothing they do not.
 *
 * Twins of `Tourney::may_report`, `may_submit` and `may_confirm`. Offering a
 * control the server refuses is worse than offering none: the player fills in
 * a score and loses it.
 */
export function MatchActions({
  event,
  entry,
  busy,
  onReport,
  onAnswer,
  onHost,
  vetoOpen,
  onToggleVeto,
  withVeto = true,
}: MatchActionsProps) {
  const { t } = useTranslation();
  const mine = myTeamId(event);
  const pending = entry.pendingReport;
  // A bye has two slots filled, one of them by nobody: there is no game to host.
  const playable =
    (entry.status === "ready" || entry.status === "live") &&
    entry.team1 !== null &&
    entry.team2 !== null &&
    !isBye(entry);
  // Hosting belongs to the two sides and to whoever runs the event, which is
  // what `viewer.organiser` already means (organisers, a director on an
  // official event, a site admin). It used to be offered to everyone watching,
  // so a spectator saw a Host game button on somebody else's match (issue 367).
  const mayHost = playable && (isMyMatch(event, entry) || event.viewer.organiser);
  const reportable = mayReport(event, entry);
  // A player's own path, for the other side to confirm. An organiser who also
  // plays keeps the organiser's, which needs nobody's confirmation.
  const submittable = !reportable && maySubmit(event, entry);
  const mayAnswer = pending !== null && isMyMatch(event, entry) && pending.byTeam !== mine;
  // A map step or faction choices this account owes, so the button that opens
  // the run says so rather than looking like every other match's.
  const owed = myVetoSteps(event, entry);
  const chat = useContext(MatchChatContext);
  const chatUnread = chat === null ? 0 : chat.unread(entry);
  const chatButton = chat !== null && mayOpenMatchChat(event, entry) && (
    <button
      type="button"
      className="tournament-round-pool-toggle"
      title={t("tournaments.chat.matchChatHint")}
      onClick={() => chat.open(entry)}
    >
      <Icon name="chat" size={12} /> {t("tournaments.chat.matchChat")}
      {chatUnread > 0 && <span className="tournament-badge">{chatUnread > 9 ? "9+" : chatUnread}</span>}
    </button>
  );

  if (mayAnswer) {
    return (
      <>
        <Button variant="primary" onClick={() => onAnswer(true)} disabled={busy}>
          {t("tournaments.match.confirm")}
        </Button>
        <Button onClick={() => onAnswer(false)} disabled={busy}>
          {t("tournaments.match.reject")}
        </Button>
        {chatButton}
      </>
    );
  }
  return (
    <>
      {chatButton}
      {mayHost && (
        <Button onClick={onHost} title={t("tournaments.match.hostHint")}>
          <Icon name="play" size={14} /> {t("tournaments.match.host")}
        </Button>
      )}
      {/* The run itself opens outside the card. A grid of maps does not fit
          in one, and every card drawing its own was what once made this tab
          unusable. */}
      {withVeto && hasVeto(event, entry) && (
        <button
          type="button"
          className={[
            "tournament-round-pool-toggle",
            vetoOpen ? "is-open" : "",
            owed > 0 ? "is-due" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          aria-expanded={vetoOpen}
          onClick={onToggleVeto}
          title={t(owed > 0 ? "tournaments.veto.dueHint" : "tournaments.veto.openHint")}
        >
          <Icon name="maps" size={12} /> {t("tournaments.veto.open")}
          {owed > 0 && <span className="tournament-badge">{owed}</span>}
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
      {submittable && (
        <Button variant="primary" onClick={onReport} disabled={busy}>
          {t(busy ? "tournaments.match.reporting" : "tournaments.match.submitScore")}
        </Button>
      )}
    </>
  );
}

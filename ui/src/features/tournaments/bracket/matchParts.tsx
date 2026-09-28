// The pieces of a two-sided match that every view of it shares: who a slot is,
// and what the viewer may do with the match.
//
// The bracket card, the Swiss round list and the Matches tab all draw the same
// match, and each of them used to be one place where "may this account host,
// report or answer" could drift from the others. The rules live in
// `tourneyRules`; this is the one place that turns them into buttons.

import { Button } from "../../../design-system/Button";
import { Icon } from "../../../design-system/Icon";
import type { PlayerSummary, Tourney, TourneyMatch } from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";
import { mayReport, maySubmit } from "../../../shared/rules/tourneyRules";
import { PlayerChip } from "../PlayerChip";
import { isMyMatch, myTeamId } from "../tourneyPresentation";

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

/** A slot's name, as a player chip that opens the card where there is one account. */
export function TeamName({
  event,
  profiles,
  teamId,
}: {
  event: Tourney;
  profiles: PlayerSummary[];
  teamId: string | null;
}) {
  const { t } = useTranslation();
  const name = teamNameOf(event, teamId) ?? t("tournaments.bracket.tbd");
  const profile = soloProfileOf(event, profiles, teamId);
  return profile ? <PlayerChip player={profile} overrideName={name} /> : <>{name}</>;
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
}: MatchActionsProps) {
  const { t } = useTranslation();
  const mine = myTeamId(event);
  const pending = entry.pendingReport;
  const playable =
    (entry.status === "ready" || entry.status === "live") &&
    entry.team1 !== null &&
    entry.team2 !== null;
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

  if (mayAnswer) {
    return (
      <>
        <Button variant="primary" onClick={() => onAnswer(true)} disabled={busy}>
          {t("tournaments.match.confirm")}
        </Button>
        <Button onClick={() => onAnswer(false)} disabled={busy}>
          {t("tournaments.match.reject")}
        </Button>
      </>
    );
  }
  return (
    <>
      {mayHost && (
        <Button onClick={onHost} title={t("tournaments.match.hostHint")}>
          <Icon name="play" size={14} /> {t("tournaments.match.host")}
        </Button>
      )}
      {/* The run itself opens outside the card. A grid of maps does not fit
          in one, and every card drawing its own was what once made this tab
          unusable. */}
      {entry.veto !== null && event.veto.enabled && (
        <button
          type="button"
          className={
            vetoOpen ? "tournament-round-pool-toggle is-open" : "tournament-round-pool-toggle"
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
      {submittable && (
        <Button variant="primary" onClick={onReport} disabled={busy}>
          {t(busy ? "tournaments.match.reporting" : "tournaments.match.submitScore")}
        </Button>
      )}
    </>
  );
}

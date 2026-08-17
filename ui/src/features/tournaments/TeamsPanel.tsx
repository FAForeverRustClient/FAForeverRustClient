// Forming a team, and getting onto one.
//
// The gap this fills: entering a 2v2 puts you in the entrant list with no team,
// no check-in and no match. The server never hands out a team at signup, so
// this is the only route forward, and there is exactly one of it. Instant
// joining was retired: `join_team` answers "send a join request, the captain
// approves it". So every place on a team is the end of a conversation, in one
// direction or the other.
//
// Invitations addressed to this account sit at the top, because they are the
// one thing in the pane that is waiting on the reader rather than on somebody
// else.

import { useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import type { PlayerSummary, Tourney, TourneyTeam } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";
import { PlayerChip } from "./PlayerChip";
import {
  mayRename,
  myInvites,
  profileOf,
  selfOrganised,
  teamMembers,
  teamRating,
  wouldExceedCap,
} from "./tourneyPresentation";

interface TeamsPanelProps {
  event: Tourney;
  profiles: PlayerSummary[];
  busy: boolean;
  onCreate: (name: string) => void;
  onRequestJoin: (teamId: string) => void;
  onCancelJoin: (teamId: string) => void;
  onRespondJoin: (teamId: string, playerId: string, accept: boolean) => void;
  onInvite: (teamId: string, playerId: string) => void;
  onRespondInvite: (teamId: string, accept: boolean) => void;
  onLeave: () => void;
  onDisband: (teamId: string) => void;
  onRename: (teamId: string, name: string) => void;
}

export function TeamsPanel(props: TeamsPanelProps) {
  const { t } = useTranslation();
  const { event, busy } = props;
  const [newName, setNewName] = useState("");

  const mine = event.teams.find((team) => team.id === event.viewer.memberTeamId) ?? null;
  const myPlayerId = event.viewer.signedUpPlayerId;
  const captainOf = (team: TourneyTeam) =>
    myPlayerId !== null && team.captainId === myPlayerId;
  const isFull = (team: TourneyTeam) => team.playerIds.length >= event.teamSize;
  const askedFor = (team: TourneyTeam) =>
    myPlayerId !== null && team.joinRequests.some((ask) => ask.playerId === myPlayerId);
  const unteamed = event.players.filter((player) => player.teamId === null && !player.pending);
  const invites = myInvites(event);
  const canForm = selfOrganised(event) && event.viewer.signedUpPlayerId !== null && mine === null;

  // Like `TourneyTeam::display_name`, but deliberately not its twin: where the
  // Rust falls back to an empty string, this falls back to the team id. A team
  // that never named itself and whose first entrant cannot be resolved would
  // otherwise render as a blank row with buttons beside it, which reads as a
  // broken list. Not worth pinning to the Rust, and worth saying so: the id is
  // the better answer here, not an oversight to be corrected into a blank.
  const nameOf = (team: TourneyTeam) => {
    const named = team.name.trim();
    if (named !== "") return named;
    return event.players.find((player) => player.id === team.playerIds[0])?.name ?? team.id;
  };

  if (!selfOrganised(event) && event.teams.length === 0) {
    // A solo event's teams are made by the organiser at the phase change, and a
    // draft event's by the captains. Offering to form one would be a trap.
    return <p className="muted">{t("tournaments.teams.notYours")}</p>;
  }

  return (
    <div className="tournament-teams">
      {invites.length > 0 && (
        <section className="surface tournament-team-invites">
          <h5>{t("tournaments.teams.invitedYou")}</h5>
          <ul className="tournament-entrant-list">
            {invites.map((team) => (
              <li className="tournament-entrant" key={team.id}>
                <span className="tournament-entrant-name">{nameOf(team)}</span>
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => props.onRespondInvite(team.id, true)}
                >
                  {t("tournaments.teams.accept")}
                </Button>
                <Button disabled={busy} onClick={() => props.onRespondInvite(team.id, false)}>
                  {t("tournaments.teams.decline")}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {canForm && (
        <form
          className="tournament-team-create"
          onSubmit={(submitted) => {
            submitted.preventDefault();
            if (newName.trim() === "") return;
            props.onCreate(newName);
            setNewName("");
          }}
        >
          <label className="tournament-field">
            <span>{t("tournaments.teams.createLabel")}</span>
            <input
              value={newName}
              onChange={(changed) => setNewName(changed.target.value)}
              placeholder={t("tournaments.teams.createPlaceholder")}
              maxLength={30}
            />
          </label>
          <Button type="submit" variant="primary" disabled={busy || newName.trim() === ""}>
            <Icon name="plus" size={16} /> {t("tournaments.teams.create")}
          </Button>
        </form>
      )}

      {event.viewer.signedUpPlayerId === null && selfOrganised(event) && (
        <p className="muted">{t("tournaments.teams.enterFirst")}</p>
      )}

      <ul className="tournament-team-list">
        {event.teams.map((team) => {
          const isMine = team.id === mine?.id;
          const captain = captainOf(team);
          const overCap = wouldExceedCap(event, team);
          const mayAsk = canForm && !isFull(team) && !askedFor(team) && !overCap;
          return (
            <li
              className={isMine ? "surface tournament-team is-mine" : "surface tournament-team"}
              key={team.id}
            >
              <div className="tournament-team-header">
                <span className="tournament-team-name">{nameOf(team)}</span>
                <span className="muted">
                  {t("tournaments.teams.size", {
                    have: team.playerIds.length,
                    want: event.teamSize,
                  })}
                </span>
                {event.rating.maxTeam !== null && (
                  <span className="muted">
                    {t("tournaments.teams.combined", { rating: teamRating(event, team) })}
                  </span>
                )}
                {team.checkedIn && (
                  <span className="tournament-badge is-signup">
                    {t("tournaments.entrants.checkedIn")}
                  </span>
                )}
              </div>

              <ul className="tournament-entrant-list">
                {teamMembers(event, team).map((member) => {
                  // The entry's own name wins over the account's: the tournament
                  // service owns the entry, FAF owns the player, and an
                  // organiser's substitute label must survive the lookup.
                  const profile = profileOf(props.profiles, member);
                  return (
                    <li className="tournament-entrant" key={member.id}>
                      <span className="tournament-entrant-name">
                        {profile ? (
                          <PlayerChip player={profile} overrideName={member.name} />
                        ) : (
                          member.name
                        )}
                      </span>
                      {team.captainId === member.id && (
                        <span className="muted">{t("tournaments.teams.captain")}</span>
                      )}
                    </li>
                  );
                })}
              </ul>

              {/* Requests are the captain's to answer, and nobody else's. */}
              {captain && team.joinRequests.length > 0 && (
                <div className="tournament-team-requests">
                  <h6>{t("tournaments.teams.requests")}</h6>
                  <ul className="tournament-entrant-list">
                    {team.joinRequests.map((ask) => (
                      <li className="tournament-entrant" key={ask.playerId}>
                        <span className="tournament-entrant-name">{ask.name}</span>
                        <Button
                          variant="primary"
                          disabled={busy || isFull(team)}
                          onClick={() => props.onRespondJoin(team.id, ask.playerId, true)}
                        >
                          {t("tournaments.teams.accept")}
                        </Button>
                        <Button
                          disabled={busy}
                          onClick={() => props.onRespondJoin(team.id, ask.playerId, false)}
                        >
                          {t("tournaments.teams.decline")}
                        </Button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {captain && !isFull(team) && unteamed.length > 0 && (
                <div className="tournament-team-requests">
                  <h6>{t("tournaments.teams.invite")}</h6>
                  <ul className="tournament-entrant-list">
                    {unteamed.map((player) => (
                      <li className="tournament-entrant" key={player.id}>
                        <span className="tournament-entrant-name">{player.name}</span>
                        {player.rating !== null && <span className="muted">{player.rating}</span>}
                        <Button
                          disabled={
                            busy || team.invites.some((held) => held.playerId === player.id)
                          }
                          onClick={() => props.onInvite(team.id, player.id)}
                        >
                          {t(
                            team.invites.some((held) => held.playerId === player.id)
                              ? "tournaments.teams.invited"
                              : "tournaments.teams.inviteAction",
                          )}
                        </Button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="tournament-match-actions">
                {mayAsk && (
                  <Button
                    variant="primary"
                    disabled={busy}
                    onClick={() => props.onRequestJoin(team.id)}
                  >
                    {t("tournaments.teams.ask")}
                  </Button>
                )}
                {askedFor(team) && (
                  <Button disabled={busy} onClick={() => props.onCancelJoin(team.id)}>
                    {t("tournaments.teams.cancelAsk")}
                  </Button>
                )}
                {/* Said out loud rather than left as a missing button: the
                    server's refusal names the number the team would reach, and
                    finding that out after clicking is worse. */}
                {canForm && overCap && (
                  <span className="muted">{t("tournaments.teams.overCap")}</span>
                )}
                {canForm && isFull(team) && !askedFor(team) && (
                  <span className="muted">{t("tournaments.teams.full")}</span>
                )}
                {isMine && (
                  <Button disabled={busy} onClick={props.onLeave}>
                    {t("tournaments.teams.leave")}
                  </Button>
                )}
                {/* An organiser may rename and disband any team; a captain only
                    their own, and renaming only once. Gating both on captaincy
                    alone left an organiser able to touch nothing but the team
                    they happened to play in. */}
                {mayRename(event, team) && (
                  <Button
                    disabled={busy}
                    onClick={() => {
                      const renamed = window.prompt(t("tournaments.teams.renamePrompt"), team.name);
                      if (renamed !== null && renamed.trim() !== "") {
                        props.onRename(team.id, renamed);
                      }
                    }}
                  >
                    {t("tournaments.teams.rename")}
                  </Button>
                )}
                {(captain || event.viewer.organiser) && (
                  <Button
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm(t("tournaments.teams.disbandConfirm"))) {
                        props.onDisband(team.id);
                      }
                    }}
                  >
                    {t("tournaments.teams.disband")}
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {event.teams.length === 0 && <p className="muted">{t("tournaments.teams.none")}</p>}

      {unteamed.length > 0 && (
        <section>
          <h5>{t("tournaments.entrants.unteamed")}</h5>
          <ul className="tournament-entrant-list">
            {unteamed.map((player) => (
              <li className="tournament-entrant" key={player.id}>
                <span className="tournament-entrant-name">{player.name}</span>
                {player.rating !== null && <span className="muted">{player.rating}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// Forming a team, and getting onto one.
//
// The gap this fills: entering a 2v2 puts you in the entrant list with no team,
// no check-in and no match. The server never hands out a team at signup, so
// this is the only route forward, and there is exactly one of it. Instant
// joining was retired: `join_team` answers "send a join request, the captain
// approves it". So every place on a team is the end of a conversation, in one
// direction or the other.
//
// While signups are open the field is drawn the way the website draws it, and
// the way the service will resolve it: the full teams that are in, the full
// teams waiting beyond the cap, the free agents, and the teams still forming.
// Places go by when a team filled up; rating only decides the seed. Once the
// field is locked there is one grid, in seed order, and nothing left to form:
// the service refuses every team action from then on.
//
// Invitations addressed to this account sit at the top, because they are the
// one thing in the pane that is waiting on the reader rather than on somebody
// else.

import { useState, type ReactNode } from "react";
import { Button } from "../../../design-system/Button";
import { Icon } from "../../../design-system/Icon";
import type { PlayerSummary, Tourney, TourneyAdmin, TourneyPlayer, TourneyTeam } from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";
import { EntrantName } from "../EntrantName";
import { PlayerTable } from "../PlayerTable";
import { formatMoment } from "../tourneyPresentation";
import {
  mayCheckIn,
  mayRename,
  mayUndoCheckIn,
  myInvites,
  profileOf,
  selfOrganised,
  teamIsFull,
  teamLineup,
  teamMembers,
  teamRating,
  teamsAreOpen,
  wouldExceedCap,
} from "../../../shared/rules/tourneyRules";
import { ChangeCaptainDialog, SwapInDialog, TeamFromFreeAgentDialog } from "./TeamDialogs";

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
  /** Check this account's own team in, or take it back. */
  onCheckIn: (checkedIn: boolean) => void;
  onSetCaptain: (teamId: string, playerId: string) => void;
  onAdmin: (change: TourneyAdmin) => void;
}

type FreeAgentSort = "rating" | "name" | "new";

type Dialog =
  | { kind: "captain"; team: TourneyTeam }
  | { kind: "swap"; team: TourneyTeam }
  | { kind: "fromFreeAgent" }
  | null;

export function TeamsPanel(props: TeamsPanelProps) {
  const { t } = useTranslation();
  const { event, busy } = props;
  const [newName, setNewName] = useState("");
  const [sort, setSort] = useState<FreeAgentSort>("rating");
  const [dialog, setDialog] = useState<Dialog>(null);

  const organiser = event.viewer.organiser;
  const open = teamsAreOpen(event);
  const now = Math.floor(Date.now() / 1000);
  const mine = event.teams.find((team) => team.id === event.viewer.memberTeamId) ?? null;
  const myPlayerId = event.viewer.signedUpPlayerId;
  const captainOf = (team: TourneyTeam) => myPlayerId !== null && team.captainId === myPlayerId;
  const askedFor = (team: TourneyTeam) =>
    myPlayerId !== null && team.joinRequests.some((ask) => ask.playerId === myPlayerId);
  const unteamed = event.players.filter((player) => player.teamId === null && !player.pending);
  // Once the field is locked the service names the reserves itself, and its
  // list is the authority: `finalizeOpenTeams` dissolves every team that never
  // filled and every one the entrant cap pushed out, and puts their players
  // here. Before that nobody has been named yet, so it is whoever has no team.
  const freeAgents =
    event.subs.length > 0 ? event.players.filter((player) => event.subs.includes(player.id)) : unteamed;
  const invites = myInvites(event);
  const canForm = open && myPlayerId !== null && mine === null;
  // A captain whose team still has room recruits from the free agents.
  const recruiting = open && mine !== null && captainOf(mine) && !teamIsFull(event, mine) ? mine : null;

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

  const lineup = teamLineup(event);
  const seedOf = new Map(lineup.seeds.map((entry) => [entry.teamId, entry.seed]));
  const seeded = event.teams.some((team) => teamIsFull(event, team) && team.seed > 0);
  const byId = (ids: string[]) =>
    ids
      .map((id) => event.teams.find((team) => team.id === id))
      .filter((team): team is TourneyTeam => team !== undefined);
  const participants = byId(lineup.participants);
  const waiting = byId(lineup.waiting);
  const forming = byId(lineup.forming);
  const seedShown = (team: TourneyTeam): number | null => {
    if (!open) return team.seed > 0 ? team.seed : null;
    // An unseeded team in a seeded field carries seed 0: no badge, as on the
    // website, rather than a "#0".
    const seed = teamIsFull(event, team) ? (seedOf.get(team.id) ?? 0) : 0;
    return seed > 0 ? seed : null;
  };

  const card = (team: TourneyTeam, extra?: ReactNode) => (
    <TeamCard
      key={team.id}
      event={event}
      team={team}
      name={nameOf(team)}
      seed={seedShown(team)}
      projected={open && !seeded}
      profiles={props.profiles}
      busy={busy}
      isMine={team.id === mine?.id}
      captain={captainOf(team)}
      mayAsk={canForm && !teamIsFull(event, team) && !askedFor(team) && !wouldExceedCap(event, team)}
      asked={askedFor(team)}
      overCap={canForm && !teamIsFull(event, team) && wouldExceedCap(event, team)}
      extra={extra}
      onRequestJoin={props.onRequestJoin}
      onCancelJoin={props.onCancelJoin}
      onRespondJoin={props.onRespondJoin}
      onDisband={props.onDisband}
      onRename={props.onRename}
      onChangeCaptain={() => setDialog({ kind: "captain", team })}
      onAdmin={props.onAdmin}
    />
  );

  return (
    <div className="tournament-teams">
      {invites.length > 0 && (
        <section className="surface tournament-team-invites">
          <h5>{t("tournaments.teams.invitedYou")}</h5>
          <ul className="tournament-entrant-list">
            {invites.map((team) => (
              <li className="tournament-entrant" key={team.id}>
                <span className="tournament-entrant-name">{nameOf(team)}</span>
                <span className="muted">
                  {t("tournaments.teams.size", { have: team.playerIds.length, want: event.teamSize })}
                  {event.rating.maxTeam !== null &&
                    ` · ${t("tournaments.teams.ratingOfMax", { rating: teamRating(event, team), max: event.rating.maxTeam })}`}
                </span>
                <Button variant="primary" disabled={busy} onClick={() => props.onRespondInvite(team.id, true)}>
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

      {mine !== null && open && (
        <YourTeam
          event={event}
          team={mine}
          name={nameOf(mine)}
          profiles={props.profiles}
          busy={busy}
          captain={captainOf(mine)}
          now={now}
          onCheckIn={props.onCheckIn}
          onLeave={props.onLeave}
          onDisband={props.onDisband}
          onRename={props.onRename}
          onCancelInvite={(playerId) =>
            props.onAdmin({ type: "cancelTeamInvite", payload: { teamId: mine.id, playerId } })
          }
        />
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
          <p className="muted">{t("tournaments.teams.createHint", { size: event.teamSize })}</p>
        </form>
      )}

      {myPlayerId === null && open && <p className="muted">{t("tournaments.teams.enterFirst")}</p>}

      {open && event.checkInDeadline !== null && (
        <section className="surface tournament-team-section">
          <h5>{t("tournaments.teams.checkInTitle")}</h5>
          <p className={event.checkInDeadline < now ? "tournament-warning" : "muted"}>
            {t(event.checkInDeadline < now ? "tournaments.teams.deadlinePassed" : "tournaments.teams.deadline", {
              when: formatMoment(event.checkInDeadline, ""),
            })}
          </p>
        </section>
      )}

      {event.teams.length === 0 && <p className="muted">{t("tournaments.teams.none")}</p>}

      {open && event.teams.length > 0 && (
        <>
          <section className="tournament-team-section">
            <h5>
              {event.maxTeams > 0
                ? t("tournaments.teams.participantsOf", { count: participants.length, cap: event.maxTeams })
                : t("tournaments.teams.participants", { count: participants.length })}
            </h5>
            {event.minTeams > 0 && (
              <p className="muted">
                {event.maxTeams > 0
                  ? t("tournaments.teams.minMax", { min: event.minTeams, max: event.maxTeams })
                  : t("tournaments.teams.minOnly", { min: event.minTeams })}
              </p>
            )}
            {participants.length > 0 ? (
              <>
                <p className="muted">
                  {t("tournaments.teams.firstCome")}
                  {event.maxTeams > 0 && ` ${t("tournaments.teams.signUpAnyway")}`}{" "}
                  {t(seeded ? "tournaments.teams.seedIs" : "tournaments.teams.seedProjected")}
                </p>
                <ul className="tournament-team-grid">{participants.map((team) => card(team))}</ul>
              </>
            ) : (
              <p className="muted">{t("tournaments.teams.noFullTeams")}</p>
            )}
          </section>

          {waiting.length > 0 && (
            <section className="tournament-team-section">
              <h5>{t("tournaments.teams.waiting", { count: waiting.length })}</h5>
              <p className="muted">
                {t("tournaments.teams.waitingHint", { cap: event.maxTeams })}
                {organiser && ` ${t("tournaments.teams.waitingSwapHint")}`}
              </p>
              <ul className="tournament-team-grid">
                {waiting.map((team) =>
                  card(
                    team,
                    organiser && participants.length > 0 ? (
                      <Button disabled={busy} onClick={() => setDialog({ kind: "swap", team })}>
                        {t("tournaments.teams.swapIn")}
                      </Button>
                    ) : null,
                  ),
                )}
              </ul>
            </section>
          )}
        </>
      )}

      {!open && event.teams.length > 0 && (
        <ul className="tournament-team-grid">
          {[...event.teams].sort((left, right) => left.seed - right.seed).map((team) => card(team))}
        </ul>
      )}

      {/* The free agents: everyone who has entered and has no team.
          Before the field is locked they are players still looking, and a
          captain with room invites them from here. Afterwards they are the
          service's `subs`, which is the same people under a different name:
          a team that never filled up is dissolved and its members land here,
          as do the members of any team the entrant cap pushed out. */}
      {freeAgents.length > 0 &&
        (open ? (
          <FreeAgents
            event={event}
            players={freeAgents}
            profiles={props.profiles}
            busy={busy}
            sort={sort}
            recruiting={recruiting}
            onSort={setSort}
            onInvite={props.onInvite}
            onCancelInvite={(teamId, playerId) =>
              props.onAdmin({ type: "cancelTeamInvite", payload: { teamId, playerId } })
            }
            onFromFreeAgent={organiser ? () => setDialog({ kind: "fromFreeAgent" }) : null}
          />
        ) : (
          <section className="tournament-free-agents">
            <h5>{t("tournaments.teams.freeAgents", { count: freeAgents.length })}</h5>
            <p className="muted">{t("tournaments.teams.freeAgentsReserve")}</p>
            <PlayerTable event={event} profiles={props.profiles} players={freeAgents} />
          </section>
        ))}

      {open && forming.length > 0 && (
        <section className="tournament-team-section">
          <h5>{t("tournaments.teams.forming", { count: forming.length })}</h5>
          <p className="muted">{t("tournaments.teams.formingHint", { size: event.teamSize })}</p>
          <ul className="tournament-team-grid">{forming.map((team) => card(team))}</ul>
        </section>
      )}

      {dialog?.kind === "captain" && (
        <ChangeCaptainDialog
          team={dialog.team}
          teamName={nameOf(dialog.team)}
          members={teamMembers(event, dialog.team)}
          busy={busy}
          onPick={(playerId) => {
            props.onSetCaptain(dialog.team.id, playerId);
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "swap" && (
        <SwapInDialog
          teamName={nameOf(dialog.team)}
          participants={participants.map((team) => ({ id: team.id, label: nameOf(team) }))}
          busy={busy}
          onPick={(outId) => {
            props.onAdmin({ type: "swapTeam", payload: { inId: dialog.team.id, outId } });
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "fromFreeAgent" && (
        <TeamFromFreeAgentDialog
          freeAgents={unteamed}
          busy={busy}
          onCreate={(playerId, name) => {
            props.onAdmin({ type: "createTeamFor", payload: { playerId, name: name.trim() } });
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

/** A member's line: name, rating, captaincy and where to reach them. */
function MemberLine({
  event,
  member,
  team,
  profiles,
}: {
  event: Tourney;
  member: TourneyPlayer;
  team: TourneyTeam;
  profiles: PlayerSummary[];
}) {
  const { t } = useTranslation();
  // The entry's own name wins over the account's: the tournament service owns
  // the entry, FAF owns the player, and an organiser's substitute label must
  // survive the lookup.
  return (
    <li className="tournament-entrant">
      <span className="tournament-entrant-name">
        <EntrantName name={member.name} fafId={member.fafId} profile={profileOf(profiles, member)} />
      </span>
      {member.rating !== null && <span className="muted mono">{member.rating}</span>}
      {team.captainId === member.id && event.teamSize > 1 && (
        <span className="tournament-badge">{t("tournaments.teams.captain")}</span>
      )}
      {member.discord !== "" && (
        <span className="tournament-discord muted" title={t("tournaments.entrants.discord")}>
          {"\u{1F4AC}"} {member.discord}
        </span>
      )}
    </li>
  );
}

interface YourTeamProps {
  event: Tourney;
  team: TourneyTeam;
  name: string;
  profiles: PlayerSummary[];
  busy: boolean;
  captain: boolean;
  now: number;
  onCheckIn: (checkedIn: boolean) => void;
  onLeave: () => void;
  onDisband: (teamId: string) => void;
  onRename: (teamId: string, name: string) => void;
  onCancelInvite: (playerId: string) => void;
}

/** This account's own team: who is on it, its check-in, and the captain's tools. */
function YourTeam({ event, team, name, profiles, busy, captain, now, ...on }: YourTeamProps) {
  const { t } = useTranslation();
  const full = teamIsFull(event, team);
  const opensLater = event.checkInOpensAt !== null && event.checkInOpensAt > now;
  return (
    <section className="surface tournament-team-section is-mine">
      <h5>
        {t("tournaments.teams.yourTeam", { name })}{" "}
        <span className={full ? "tournament-badge is-ok" : "tournament-badge"}>
          {full
            ? t("tournaments.teams.full")
            : t("tournaments.teams.size", { have: team.playerIds.length, want: event.teamSize })}
        </span>
      </h5>
      <ul className="tournament-entrant-list">
        {teamMembers(event, team).map((member) => (
          <MemberLine key={member.id} event={event} member={member} team={team} profiles={profiles} />
        ))}
      </ul>

      {full && (
        <div className="tournament-detail-actions">
          {team.checkedIn ? (
            <>
              <span className="tournament-badge is-ok">{t("tournaments.entrants.checkedIn")}</span>
              {mayUndoCheckIn(event) && (
                <Button disabled={busy} onClick={() => on.onCheckIn(false)}>
                  {t("tournaments.teams.undoCheckIn")}
                </Button>
              )}
            </>
          ) : mayCheckIn(event, now) ? (
            <>
              <Button variant="primary" disabled={busy} onClick={() => on.onCheckIn(true)}>
                {t("tournaments.action.checkIn")}
              </Button>
              <span className="muted">{t("tournaments.teams.anyMember")}</span>
            </>
          ) : (
            opensLater && (
              <span className="muted">
                {t("tournaments.teams.checkInOpens", { when: formatMoment(event.checkInOpensAt, "") })}
              </span>
            )
          )}
        </div>
      )}

      <div className="tournament-detail-actions">
        <Button
          disabled={busy}
          onClick={() => {
            if (window.confirm(t("tournaments.teams.leaveConfirm"))) on.onLeave();
          }}
        >
          {t("tournaments.teams.leave")}
        </Button>
        {mayRename(event, team) && (
          <Button
            disabled={busy}
            onClick={() => {
              const renamed = window.prompt(t("tournaments.teams.renamePrompt"), team.name);
              if (renamed !== null && renamed.trim() !== "") on.onRename(team.id, renamed);
            }}
          >
            {t("tournaments.teams.rename")}
          </Button>
        )}
        {captain && (
          <Button
            disabled={busy}
            onClick={() => {
              if (window.confirm(t("tournaments.teams.disbandConfirm"))) on.onDisband(team.id);
            }}
          >
            {t("tournaments.teams.disband")}
          </Button>
        )}
      </div>

      {captain && !full && team.invites.length > 0 && (
        <div className="tournament-team-requests">
          <h6>{t("tournaments.teams.invitesSent", { count: team.invites.length })}</h6>
          <ul className="tournament-entrant-list">
            {team.invites.map((invite) => (
              <li className="tournament-entrant" key={invite.playerId}>
                <span className="tournament-entrant-name">{invite.name}</span>
                <span className="muted">{t("tournaments.teams.waitingForReply")}</span>
                <Button disabled={busy} onClick={() => on.onCancelInvite(invite.playerId)}>
                  {t("common.cancel")}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

interface TeamCardProps {
  event: Tourney;
  team: TourneyTeam;
  name: string;
  /** The seed shown on the card, where there is one to show. */
  seed: number | null;
  /** Whether that seed is only where the team's rating would put it. */
  projected: boolean;
  profiles: PlayerSummary[];
  busy: boolean;
  isMine: boolean;
  captain: boolean;
  mayAsk: boolean;
  asked: boolean;
  overCap: boolean;
  extra?: ReactNode;
  onRequestJoin: (teamId: string) => void;
  onCancelJoin: (teamId: string) => void;
  onRespondJoin: (teamId: string, playerId: string, accept: boolean) => void;
  onDisband: (teamId: string) => void;
  onRename: (teamId: string, name: string) => void;
  onChangeCaptain: () => void;
  onAdmin: (change: TourneyAdmin) => void;
}

function TeamCard(props: TeamCardProps) {
  const { t } = useTranslation();
  const { event, team, busy } = props;
  const open = teamsAreOpen(event);
  const organiser = event.viewer.organiser;
  const full = teamIsFull(event, team);
  const combined = teamRating(event, team);
  const max = event.rating.maxTeam;
  const openSlots = Math.max(0, event.teamSize - team.playerIds.length);
  // The captain hands over the armband, or an organiser does; only while the
  // service still takes team actions at all.
  const mayChangeCaptain = open && (organiser || props.captain) && team.playerIds.length > 1;
  // This account's own team has its buttons in the Your team section above;
  // repeating them on its card only made two places to look. An organiser
  // keeps theirs, because on every other card they are there too.
  const ownToolsAbove = open && props.isMine && !organiser;

  return (
    <li
      className={[
        "surface tournament-team",
        props.isMine ? "is-mine" : "",
        team.eliminated ? "is-eliminated" : "",
      ]
        .filter((part) => part !== "")
        .join(" ")}
    >
      {/* Two fixed rows rather than one wrapping one. With everything on a
          single line the check-in badge sat beside the name on a short team
          name and under it on a long one, so no two cards in the grid lined
          up. The name owns the first row; the facts about the team own the
          second. */}
      <div className="tournament-team-header">
        <div className="tournament-team-title">
          {props.seed !== null && (
            <span
              className="tournament-team-seed mono"
              title={t(props.projected ? "tournaments.teams.projectedSeed" : "tournaments.teams.seed")}
            >
              #{props.seed}
            </span>
          )}
          <span className="tournament-team-name">{props.name}</span>
        </div>
        <div className="tournament-team-meta muted">
          <span className={full ? "tournament-team-count is-ok" : "tournament-team-count"}>
            {t("tournaments.teams.size", { have: team.playerIds.length, want: event.teamSize })}
          </span>
          <span
            className={max !== null && combined > max ? "tournament-team-count is-over" : "tournament-team-count"}
            title={t(max !== null ? "tournaments.teams.combinedOfMax" : "tournaments.teams.combinedTitle")}
          >
            {max !== null
              ? t("tournaments.teams.ratingOfMax", { rating: combined, max })
              : t("tournaments.teams.combined", { rating: combined })}
          </span>
          {open && full && (
            <span className={team.checkedIn ? "tournament-badge is-ok" : "tournament-badge"}>
              {t(team.checkedIn ? "tournaments.entrants.checkedIn" : "tournaments.teams.notCheckedIn")}
            </span>
          )}
        </div>
      </div>

      <ul className="tournament-entrant-list">
        {teamMembers(event, team).map((member) => (
          <MemberLine key={member.id} event={event} member={member} team={team} profiles={props.profiles} />
        ))}
      </ul>

      {/* Requests are the captain's to answer, or an organiser's. */}
      {(props.captain || organiser) && open && team.joinRequests.length > 0 && (
        <div className="tournament-team-requests">
          <h6>{t("tournaments.teams.requests")}</h6>
          <ul className="tournament-entrant-list">
            {team.joinRequests.map((ask) => {
              const asker = event.players.find((player) => player.id === ask.playerId);
              return (
                <li className="tournament-entrant" key={ask.playerId}>
                  <span className="tournament-entrant-name">
                    <EntrantName
                      name={ask.name}
                      fafId={asker?.fafId ?? null}
                      profile={asker ? profileOf(props.profiles, asker) : null}
                    />
                  </span>
                  {asker !== undefined && asker.rating !== null && (
                    <span className="muted mono">{asker.rating}</span>
                  )}
                  <Button
                    variant="primary"
                    disabled={busy || full}
                    onClick={() => props.onRespondJoin(team.id, ask.playerId, true)}
                  >
                    {t("tournaments.teams.accept")}
                  </Button>
                  <Button disabled={busy} onClick={() => props.onRespondJoin(team.id, ask.playerId, false)}>
                    {t("tournaments.teams.decline")}
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="tournament-match-actions">
        {props.mayAsk && (
          <Button variant="primary" disabled={busy} onClick={() => props.onRequestJoin(team.id)}>
            {t("tournaments.teams.askOpen", { count: openSlots })}
          </Button>
        )}
        {props.asked && (
          <>
            <span className="muted">{t("tournaments.teams.requestPending")}</span>
            <Button disabled={busy} onClick={() => props.onCancelJoin(team.id)}>
              {t("tournaments.teams.cancelAsk")}
            </Button>
          </>
        )}
        {/* Said out loud rather than left as a missing button: the server's
            refusal names the number the team would reach, and finding that
            out after clicking is worse. */}
        {props.overCap && <span className="muted">{t("tournaments.teams.overCap")}</span>}
        {mayChangeCaptain && !ownToolsAbove && (
          <Button disabled={busy} onClick={props.onChangeCaptain}>
            {t("tournaments.teams.changeCaptain")}
          </Button>
        )}
        {organiser && open && full && (
          <Button
            disabled={busy}
            onClick={() =>
              props.onAdmin({ type: "teamCheckIn", payload: { teamId: team.id, checkedIn: !team.checkedIn } })
            }
          >
            {t(team.checkedIn ? "tournaments.teams.uncheck" : "tournaments.action.checkIn")}
          </Button>
        )}
        {/* An organiser may rename and disband any team; a captain only their
            own, and renaming only once. */}
        {mayRename(event, team) && !ownToolsAbove && (
          <Button
            disabled={busy}
            onClick={() => {
              const renamed = window.prompt(t("tournaments.teams.renamePrompt"), team.name);
              if (renamed !== null && renamed.trim() !== "") props.onRename(team.id, renamed);
            }}
          >
            {t("tournaments.teams.rename")}
          </Button>
        )}
        {open && (organiser || (props.captain && !ownToolsAbove)) && (
          <Button
            disabled={busy}
            onClick={() => {
              if (window.confirm(t("tournaments.teams.disbandConfirm"))) props.onDisband(team.id);
            }}
          >
            {t("tournaments.teams.disband")}
          </Button>
        )}
        {props.extra}
      </div>
    </li>
  );
}

interface FreeAgentsProps {
  event: Tourney;
  players: TourneyPlayer[];
  profiles: PlayerSummary[];
  busy: boolean;
  sort: FreeAgentSort;
  /** The team this account captains and can still invite to, if any. */
  recruiting: TourneyTeam | null;
  onSort: (sort: FreeAgentSort) => void;
  onInvite: (teamId: string, playerId: string) => void;
  onCancelInvite: (teamId: string, playerId: string) => void;
  onFromFreeAgent: (() => void) | null;
}

/** Ordered by the chosen key; unrated players last when ordered by rating. */
function sortFreeAgents(players: TourneyPlayer[], sort: FreeAgentSort): TourneyPlayer[] {
  return [...players].sort((left, right) => {
    if (sort === "name") return left.name.localeCompare(right.name);
    if (sort === "new") return (right.signedAt ?? 0) - (left.signedAt ?? 0);
    if (left.rating === null && right.rating === null) return 0;
    if (left.rating === null) return 1;
    if (right.rating === null) return -1;
    return right.rating - left.rating;
  });
}

/**
 * The players looking for a team, as the people captains are recruiting: a card
 * each, a sort, and the average of those rated.
 */
function FreeAgents(props: FreeAgentsProps) {
  const { t } = useTranslation();
  const { event, players, recruiting, busy } = props;
  const rated = players.filter((player) => player.rating !== null);
  const average =
    rated.length > 0
      ? Math.round(rated.reduce((total, player) => total + (player.rating ?? 0), 0) / rated.length)
      : null;
  const sortLabel: Record<FreeAgentSort, string> = {
    rating: t("tournaments.teams.sortRating"),
    name: t("tournaments.teams.sortName"),
    new: t("tournaments.teams.sortNewest"),
  };
  return (
    <section className="tournament-free-agents">
      <div className="tournament-free-agents-head">
        <h5>{t("tournaments.teams.freeAgents", { count: players.length })}</h5>
        <div className="tournament-sort-toggle" role="group" aria-label={t("tournaments.teams.sortBy")}>
          {(["rating", "name", "new"] as const).map((key) => (
            <Button
              key={key}
              variant={props.sort === key ? "primary" : "ghost"}
              aria-pressed={props.sort === key}
              onClick={() => props.onSort(key)}
            >
              {sortLabel[key]}
            </Button>
          ))}
        </div>
      </div>
      <p className="muted">
        {t("tournaments.teams.freeAgentsLooking")}
        {average !== null && ` · ${t("tournaments.teams.averageRating", { rating: average })}`}
        {recruiting !== null && ` ${t("tournaments.teams.youCanInvite")}`}
      </p>
      <ul className="tournament-free-agent-grid">
        {sortFreeAgents(players, props.sort).map((player) => {
          const invited = recruiting !== null && recruiting.invites.some((held) => held.playerId === player.id);
          return (
            <li className="surface tournament-free-agent" key={player.id}>
              <div className="tournament-free-agent-top">
                <span className="tournament-entrant-name">
                  <EntrantName name={player.name} fafId={player.fafId} profile={profileOf(props.profiles, player)} />
                </span>
                <span className="mono">{player.rating ?? "–"}</span>
              </div>
              {player.discord !== "" && (
                <span className="tournament-discord muted" title={t("tournaments.entrants.discord")}>
                  {"\u{1F4AC}"} {player.discord}
                </span>
              )}
              {recruiting !== null && (
                <div className="tournament-match-actions">
                  {invited ? (
                    <Button disabled={busy} onClick={() => props.onCancelInvite(recruiting.id, player.id)}>
                      {t("tournaments.teams.cancelInvite")}
                    </Button>
                  ) : (
                    <Button variant="primary" disabled={busy} onClick={() => props.onInvite(recruiting.id, player.id)}>
                      {t("tournaments.teams.inviteAction")}
                    </Button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {props.onFromFreeAgent !== null && (
        <div className="tournament-detail-actions">
          <Button
            disabled={busy || event.players.every((player) => player.teamId !== null)}
            onClick={props.onFromFreeAgent}
          >
            <Icon name="plus" size={16} /> {t("tournaments.teams.fromFreeAgent")}
          </Button>
        </div>
      )}
    </section>
  );
}

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
// Laid out as the Overview and the Players section are: the teams on the left,
// each group in its own card, and in a narrower column on the right how full
// the field is, the check-in, starting a team and how places are given out.
// The rules used to sit as paragraphs above every grid, which pushed the teams
// themselves below the fold; they are reference, so they moved aside.
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
import { fieldSummary } from "../entrantsPresentation";
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
import { PremadeTeams } from "./PremadeTeams";
import { useTourneyDisplay } from "../display";
import type { EntryActions, TeamActions } from "../tourneyActions";
import { askConfirm, askText } from "../tourneyDialogs";

interface TeamsPanelProps {
  event: Tourney;
  profiles: PlayerSummary[];
  busy: boolean;
  teams: TeamActions;
  /** Checking this account's own team in, or taking it back. */
  entry: Pick<EntryActions, "checkIn">;
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
  const display = useTourneyDisplay();

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
    return (
      <section className="tournament-panel tournament-teams-empty">
        <Icon name="users" size={22} />
        <p className="muted">{t("tournaments.teams.notYours")}</p>
      </section>
    );
  }

  // The grids keep the lineup's order (entry order, or seeds once set); the
  // cards leave the seed number off.
  const lineup = teamLineup(event);
  const byId = (ids: string[]) =>
    ids
      .map((id) => event.teams.find((team) => team.id === id))
      .filter((team): team is TourneyTeam => team !== undefined);
  const participants = byId(lineup.participants);
  const waiting = byId(lineup.waiting);
  const forming = byId(lineup.forming);
  const card = (team: TourneyTeam, extra?: ReactNode) => (
    <TeamCard
      key={team.id}
      event={event}
      team={team}
      name={nameOf(team)}
      profiles={props.profiles}
      busy={busy}
      isMine={team.id === mine?.id}
      captain={captainOf(team)}
      mayAsk={canForm && !teamIsFull(event, team) && !askedFor(team) && !wouldExceedCap(event, team)}
      asked={askedFor(team)}
      overCap={canForm && !teamIsFull(event, team) && wouldExceedCap(event, team)}
      extra={extra}
      teams={props.teams}
      onChangeCaptain={() => setDialog({ kind: "captain", team })}
      onAdmin={props.onAdmin}
    />
  );

  return (
    <div className="tournament-columns tournament-teams">
      <div className="tournament-columns-main">
        {event.premadeTeams && event.teamSize > 1 && event.status === "signup" && (
          <PremadeTeams event={event} busy={busy} onAdmin={props.onAdmin} />
        )}

        {invites.length > 0 && (
          <TeamSection
            className="is-callout"
            title={t("tournaments.teams.invitedYou")}
            count={String(invites.length)}
          >
            <ul className="tournament-team-rows">
              {invites.map((team) => (
                <li className="tournament-team-row" key={team.id}>
                  <span className="tournament-team-row-name">{nameOf(team)}</span>
                  <span className="tournament-team-chip mono">
                    {t("tournaments.teams.size", { have: team.playerIds.length, want: event.teamSize })}
                  </span>
                  {event.rating.maxTeam !== null && (
                    <span className="tournament-team-chip mono" title={t("tournaments.teams.combinedOfMax")}>
                      {t("tournaments.teams.ratingOfMax", { rating: teamRating(event, team), max: event.rating.maxTeam })}
                    </span>
                  )}
                  <span className="tournament-team-row-actions">
                    <Button variant="primary" disabled={busy} onClick={() => props.teams.respondInvite(team.id, true)}>
                      {t("tournaments.teams.accept")}
                    </Button>
                    <Button disabled={busy} onClick={() => props.teams.respondInvite(team.id, false)}>
                      {t("tournaments.teams.decline")}
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          </TeamSection>
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
            onCheckIn={props.entry.checkIn}
            teams={props.teams}
            onCancelInvite={(playerId) =>
              props.onAdmin({ type: "cancelTeamInvite", payload: { teamId: mine.id, playerId } })
            }
          />
        )}

        {event.teams.length === 0 && (
          <section className="tournament-panel tournament-teams-empty">
            <Icon name="users" size={22} />
            <p className="muted">{t("tournaments.teams.none")}</p>
          </section>
        )}

        {open && event.teams.length > 0 && (
          <>
            <TeamSection
              title={t("tournaments.teams.participants")}
              count={event.maxTeams > 0 ? `${participants.length} / ${event.maxTeams}` : String(participants.length)}
            >
              {participants.length > 0 ? (
                <ul className="tournament-team-grid">{participants.map((team) => card(team))}</ul>
              ) : (
                <p className="muted">{t("tournaments.teams.noFullTeams")}</p>
              )}
            </TeamSection>

            {waiting.length > 0 && (
              <TeamSection
                title={t("tournaments.teams.waiting")}
                count={String(waiting.length)}
                hint={
                  <>
                    {t("tournaments.teams.waitingHint", { cap: event.maxTeams })}
                    {organiser && ` ${t("tournaments.teams.waitingSwapHint")}`}
                  </>
                }
              >
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
              </TeamSection>
            )}
          </>
        )}

        {!open && event.teams.length > 0 && (
          <TeamSection title={t("tournaments.section.teams")} count={String(event.teams.length)}>
            <ul className="tournament-team-grid">
              {[...event.teams].sort(byStanding(event, display.streamer)).map((team) => card(team))}
            </ul>
          </TeamSection>
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
              onInvite={props.teams.invite}
              onCancelInvite={(teamId, playerId) =>
                props.onAdmin({ type: "cancelTeamInvite", payload: { teamId, playerId } })
              }
              onFromFreeAgent={organiser ? () => setDialog({ kind: "fromFreeAgent" }) : null}
            />
          ) : (
            <TeamSection
              title={t("tournaments.teams.freeAgents")}
              count={String(freeAgents.length)}
              hint={t("tournaments.teams.freeAgentsReserve")}
            >
              <PlayerTable event={event} profiles={props.profiles} players={freeAgents} />
            </TeamSection>
          ))}

        {open && forming.length > 0 && (
          <TeamSection
            title={t("tournaments.teams.forming")}
            count={String(forming.length)}
            hint={t("tournaments.teams.formingHint", { size: event.teamSize })}
          >
            <ul className="tournament-team-grid">{forming.map((team) => card(team))}</ul>
          </TeamSection>
        )}
      </div>

      <aside className="tournament-columns-aside">
        {canForm && (
          <section className="tournament-panel">
            <h4>{t("tournaments.teams.createLabel")}</h4>
            <form
              className="tournament-team-create"
              onSubmit={(submitted) => {
                submitted.preventDefault();
                if (newName.trim() === "") return;
                props.teams.create(newName);
                setNewName("");
              }}
            >
              <input
                value={newName}
                onChange={(changed) => setNewName(changed.target.value)}
                placeholder={t("tournaments.teams.createPlaceholder")}
                aria-label={t("tournaments.teams.createPlaceholder")}
                maxLength={30}
              />
              <Button type="submit" variant="primary" disabled={busy || newName.trim() === ""}>
                <Icon name="plus" size={16} /> {t("tournaments.teams.create")}
              </Button>
            </form>
            <p className="muted tournament-team-aside-note">
              {t("tournaments.teams.createHint", { size: event.teamSize })}
            </p>
          </section>
        )}

        {myPlayerId === null && open && (
          <section className="tournament-panel">
            <p className="muted tournament-team-aside-note">{t("tournaments.teams.enterFirst")}</p>
          </section>
        )}

        <FieldPanel event={event} open={open} forming={forming.length} freeAgents={freeAgents.length} />

        {open && event.checkInDeadline !== null && (
          <section className="tournament-panel">
            <h4>{t("tournaments.teams.checkInTitle")}</h4>
            <p
              className={
                event.checkInDeadline < now
                  ? "tournament-team-checkin is-passed"
                  : "tournament-team-checkin"
              }
            >
              <span>
                {t(event.checkInDeadline < now ? "tournaments.teams.deadlinePassed" : "tournaments.teams.deadline", {
                  when: formatMoment(event.checkInDeadline, ""),
                })}
              </span>
            </p>
          </section>
        )}

        {open && event.teams.length > 0 && (
          <section className="tournament-panel">
            <h4>{t("tournaments.teams.howPlaces")}</h4>
            <ul className="tournament-team-rules">
              <li>{t("tournaments.teams.firstCome")}</li>
              {event.maxTeams > 0 && <li>{t("tournaments.teams.signUpAnyway")}</li>}
              {event.minTeams > 0 && (
                <li>
                  {event.maxTeams > 0
                    ? t("tournaments.teams.minMax", { min: event.minTeams, max: event.maxTeams })
                    : t("tournaments.teams.minOnly", { min: event.minTeams })}
                </li>
              )}
            </ul>
          </section>
        )}
      </aside>

      {dialog?.kind === "captain" && (
        <ChangeCaptainDialog
          team={dialog.team}
          teamName={nameOf(dialog.team)}
          members={teamMembers(event, dialog.team)}
          busy={busy}
          onPick={(playerId) => {
            props.teams.setCaptain(dialog.team.id, playerId);
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

/**
 * The locked field's order: by final placing once the event has them (and the
 * reader is not keeping results off screen), by seed before that.
 */
function byStanding(event: Tourney, streamer: boolean) {
  const ranked = !streamer && event.teams.some((team) => team.finalRank !== null);
  return (left: TourneyTeam, right: TourneyTeam) => {
    if (ranked) {
      const leftRank = left.finalRank ?? Number.MAX_SAFE_INTEGER;
      const rightRank = right.finalRank ?? Number.MAX_SAFE_INTEGER;
      if (leftRank !== rightRank) return leftRank - rightRank;
    }
    return left.seed - right.seed;
  };
}

/**
 * One group of the field in its own card: the heading with its count beside
 * it, the right-hand tools if there are any, one line of what the group means,
 * and the teams.
 */
function TeamSection({
  title,
  count,
  hint,
  tools,
  className,
  children,
}: {
  title: string;
  count?: string;
  hint?: ReactNode;
  tools?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={["tournament-panel", "tournament-team-section", className ?? ""].join(" ").trim()}>
      <div className="tournament-team-section-head">
        <h4>
          {title}
          {count !== undefined && <span className="tournaments-group-count">{count}</span>}
        </h4>
        {tools}
      </div>
      {hint !== undefined && <p className="muted tournament-team-section-hint">{hint}</p>}
      {children}
    </section>
  );
}

/**
 * How full the field is, the Players section's way: full teams against the
 * cap on a bar with the floor marked, and under it where everyone else is.
 */
function FieldPanel({
  event,
  open,
  forming,
  freeAgents,
}: {
  event: Tourney;
  open: boolean;
  forming: number;
  freeAgents: number;
}) {
  const { t } = useTranslation();
  const field = fieldSummary(event);
  const filled = field.max > 0 ? Math.min(1, field.count / field.max) : 0;
  const enough = field.min === 0 || field.count >= field.min;
  const checkedIn = event.teams.filter((team) => team.checkedIn).length;
  return (
    <section className="tournament-panel">
      <h4>{t("tournaments.entrants.field")}</h4>
      <div className="tournament-field-count">
        <span className="tournament-field-number">{field.count}</span>
        {field.max > 0 && <span className="tournament-field-of">/ {field.max}</span>}
        <span className="tournament-field-unit">
          {t(field.unit === "players" ? "tournaments.section.players" : "tournaments.section.teams")}
        </span>
      </div>
      {field.max > 0 && (
        <div className={enough ? "tournament-field-bar is-enough" : "tournament-field-bar"} aria-hidden>
          <span style={{ width: `${Math.round(filled * 100)}%` }} />
          {field.min > 0 && field.min < field.max && (
            <i style={{ left: `${Math.round((field.min / field.max) * 100)}%` }} />
          )}
        </div>
      )}
      <dl className="tournament-field-ratings">
        {open ? (
          <div>
            <dt>{t("tournaments.teams.forming")}</dt>
            <dd>{forming}</dd>
          </div>
        ) : (
          <div>
            <dt>{t("tournaments.entrants.checkedIn")}</dt>
            <dd>{checkedIn}</dd>
          </div>
        )}
        <div>
          <dt>{t("tournaments.teams.freeAgents")}</dt>
          <dd>{freeAgents}</dd>
        </div>
      </dl>
    </section>
  );
}

/**
 * The combined rating against the event's team limit, as a thin bar. Nothing
 * at all for a team where nobody has a rating: "0 combined" reads as a fact.
 */
function RatingMeter({ event, team }: { event: Tourney; team: TourneyTeam }) {
  const { t } = useTranslation();
  const combined = teamRating(event, team);
  const max = event.rating.maxTeam;
  if (teamMembers(event, team).every((member) => member.rating === null)) return null;
  if (max === null || max <= 0) {
    return (
      <span className="tournament-team-rating mono" title={t("tournaments.teams.combinedTitle")}>
        {t("tournaments.teams.combined", { rating: combined })}
      </span>
    );
  }
  const over = combined > max;
  const share = Math.min(1, combined / max);
  return (
    <span
      className={over ? "tournament-team-rating has-bar is-over" : "tournament-team-rating has-bar"}
      title={t("tournaments.teams.combinedOfMax")}
    >
      <span className="mono">{t("tournaments.teams.ratingOfMax", { rating: combined, max })}</span>
      <span className="tournament-team-rating-bar" aria-hidden>
        <span style={{ width: `${Math.round(share * 100)}%` }} />
      </span>
    </span>
  );
}

/**
 * Who is on the team, captain first as the service lists them, and a dashed
 * row for every place still open while the team can still be joined.
 */
function Roster({
  event,
  team,
  profiles,
  showOpen,
}: {
  event: Tourney;
  team: TourneyTeam;
  profiles: PlayerSummary[];
  showOpen: boolean;
}) {
  const { t } = useTranslation();
  const members = teamMembers(event, team);
  const openSlots = showOpen ? Math.max(0, event.teamSize - members.length) : 0;
  return (
    <ul className="tournament-roster">
      {members.map((member) => (
        <MemberLine key={member.id} event={event} member={member} team={team} profiles={profiles} />
      ))}
      {Array.from({ length: openSlots }, (_, index) => (
        <li className="tournament-roster-row is-open" key={`open-${index}`}>
          <Icon name="plus" size={12} />
          <span>{t("tournaments.teams.openSlot")}</span>
        </li>
      ))}
    </ul>
  );
}

/** A member's line: name, captaincy, where to reach them, and rating. */
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
  const captain = team.captainId === member.id && event.teamSize > 1;
  // The entry's own name wins over the account's: the tournament service owns
  // the entry, FAF owns the player, and an organiser's substitute label must
  // survive the lookup.
  return (
    <li className={captain ? "tournament-roster-row is-captain" : "tournament-roster-row"}>
      <span className="tournament-roster-who">
        <span className="tournament-entrant-name">
          <EntrantName name={member.name} fafId={member.fafId} profile={profileOf(profiles, member)} />
        </span>
        {member.discord !== "" && (
          <span className="tournament-discord muted" title={t("tournaments.entrants.discord")}>
            <Icon name="discord" size={12} /> {member.discord}
          </span>
        )}
      </span>
      {captain && (
        <span className="tournament-badge tournament-roster-captain" title={t("tournaments.teams.captain")}>
          <Icon name="crown" size={12} /> {t("tournaments.teams.captain")}
        </span>
      )}
      <span className="tournament-roster-rating mono">{member.rating ?? "–"}</span>
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
  teams: Pick<TeamActions, "leave" | "disband" | "rename" | "respondJoin">;
  onCancelInvite: (playerId: string) => void;
}

/** This account's own team: who is on it, its check-in, and the captain's tools. */
function YourTeam({ event, team, name, profiles, busy, captain, now, ...on }: YourTeamProps) {
  const { t } = useTranslation();
  const full = teamIsFull(event, team);
  const opensLater = event.checkInOpensAt !== null && event.checkInOpensAt > now;
  return (
    <section className="tournament-panel tournament-my-team">
      <div className="tournament-my-team-head">
        <div className="tournament-my-team-title">
          <h4>{t("tournaments.teams.yourTeam")}</h4>
          <span className="tournament-my-team-name">{name}</span>
        </div>
        {full && (
          <span className={team.checkedIn ? "tournament-badge is-ok" : "tournament-badge is-warn"}>
            {t(team.checkedIn ? "tournaments.entrants.checkedIn" : "tournaments.teams.notCheckedIn")}
          </span>
        )}
      </div>

      <div className="tournament-my-team-meters">
        <RatingMeter event={event} team={team} />
      </div>

      <Roster event={event} team={team} profiles={profiles} showOpen />

      {full && (team.checkedIn || mayCheckIn(event, now) || opensLater) && (
        <div className={team.checkedIn ? "tournament-my-team-checkin is-done" : "tournament-my-team-checkin"}>
          {team.checkedIn && <Icon name="check" size={16} />}
          {team.checkedIn ? (
            <>
              <span>{t("tournaments.entrants.checkedIn")}</span>
              {mayUndoCheckIn(event) && (
                <Button disabled={busy} onClick={() => on.onCheckIn(false)}>
                  {t("tournaments.teams.undoCheckIn")}
                </Button>
              )}
            </>
          ) : mayCheckIn(event, now) ? (
            <>
              <span>{t("tournaments.teams.anyMember")}</span>
              <Button variant="primary" disabled={busy} onClick={() => on.onCheckIn(true)}>
                {t("tournaments.action.checkIn")}
              </Button>
            </>
          ) : (
            <span>{t("tournaments.teams.checkInOpens", { when: formatMoment(event.checkInOpensAt, "") })}</span>
          )}
        </div>
      )}

      {/* An organiser answers on the team's card, as for every other team. */}
      {captain && !event.viewer.organiser && (
        <JoinRequests event={event} team={team} profiles={profiles} busy={busy} teams={on.teams} />
      )}

      {captain && !full && team.invites.length > 0 && (
        <div className="tournament-team-requests">
          <h6>{t("tournaments.teams.invitesSent", { count: team.invites.length })}</h6>
          <ul className="tournament-team-rows">
            {team.invites.map((invite) => (
              <li className="tournament-team-row" key={invite.playerId}>
                <span className="tournament-team-row-name">{invite.name}</span>
                <span className="muted">{t("tournaments.teams.waitingForReply")}</span>
                <span className="tournament-team-row-actions">
                  <Button disabled={busy} onClick={() => on.onCancelInvite(invite.playerId)}>
                    {t("common.cancel")}
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="tournament-team-card-actions">
        {mayRename(event, team) && (
          <Button
            disabled={busy}
            onClick={() => {
              askText(t("tournaments.teams.renamePrompt"), team.name, (renamed) => on.teams.rename(team.id, renamed), {
                maxLength: 30,
              });
            }}
          >
            <Icon name="edit" size={14} /> {t("tournaments.teams.rename")}
          </Button>
        )}
        <Button
          disabled={busy}
          onClick={() => {
            askConfirm(t("tournaments.teams.leaveConfirm"), () => on.teams.leave(), { danger: true });
          }}
        >
          <Icon name="logout" size={14} /> {t("tournaments.teams.leave")}
        </Button>
        {captain && (
          <Button
            disabled={busy}
            onClick={() => {
              askConfirm(t("tournaments.teams.disbandConfirm"), () => on.teams.disband(team.id), { danger: true });
            }}
          >
            <Icon name="trash" size={14} /> {t("tournaments.teams.disband")}
          </Button>
        )}
      </div>
    </section>
  );
}

interface TeamCardProps {
  event: Tourney;
  team: TourneyTeam;
  name: string;
  profiles: PlayerSummary[];
  busy: boolean;
  isMine: boolean;
  captain: boolean;
  mayAsk: boolean;
  asked: boolean;
  overCap: boolean;
  extra?: ReactNode;
  teams: Pick<TeamActions, "requestJoin" | "cancelJoin" | "respondJoin" | "disband" | "rename">;
  onChangeCaptain: () => void;
  onAdmin: (change: TourneyAdmin) => void;
}

function TeamCard(props: TeamCardProps) {
  const { t } = useTranslation();
  const display = useTourneyDisplay();
  const { event, team, busy } = props;
  const open = teamsAreOpen(event);
  const organiser = event.viewer.organiser;
  const full = teamIsFull(event, team);
  const openSlots = Math.max(0, event.teamSize - team.playerIds.length);
  // The captain hands over the armband, or an organiser does; only while the
  // service still takes team actions at all.
  const mayChangeCaptain = open && (organiser || props.captain) && team.playerIds.length > 1;
  // This account's own team has its buttons in the Your team section above;
  // repeating them on its card only made two places to look. An organiser
  // keeps theirs, because on every other card they are there too.
  const ownToolsAbove = open && props.isMine && !organiser;
  // Out of a running event is news; out of a finished one is everybody but
  // the winner, and fading the whole grid says nothing.
  const eliminated = team.eliminated && !display.streamer && event.status !== "finished";
  const rank = display.streamer ? null : team.finalRank;

  const actions: ReactNode[] = [];
  if (props.mayAsk)
    actions.push(
      <Button key="ask" variant="primary" disabled={busy} onClick={() => props.teams.requestJoin(team.id)}>
        {t("tournaments.teams.askOpen", { count: openSlots })}
      </Button>,
    );
  if (props.asked)
    actions.push(
      <span key="asked" className="tournament-badge is-warn">
        {t("tournaments.teams.requestPending")}
      </span>,
      <Button key="cancel-ask" disabled={busy} onClick={() => props.teams.cancelJoin(team.id)}>
        {t("tournaments.teams.cancelAsk")}
      </Button>,
    );
  // Said out loud rather than left as a missing button: the server's refusal
  // names the number the team would reach, and finding that out after
  // clicking is worse.
  if (props.overCap)
    actions.push(
      <span key="over" className="tournament-team-note">
        {t("tournaments.teams.overCap")}
      </span>,
    );
  if (mayChangeCaptain && !ownToolsAbove)
    actions.push(
      <Button key="captain" disabled={busy} onClick={props.onChangeCaptain}>
        {t("tournaments.teams.changeCaptain")}
      </Button>,
    );
  if (organiser && open && full)
    actions.push(
      <Button
        key="checkin"
        disabled={busy}
        onClick={() => props.onAdmin({ type: "teamCheckIn", payload: { teamId: team.id, checkedIn: !team.checkedIn } })}
      >
        {t(team.checkedIn ? "tournaments.teams.uncheck" : "tournaments.action.checkIn")}
      </Button>,
    );
  // An organiser may rename and disband any team; a captain only their own,
  // and renaming only once.
  if (mayRename(event, team) && !ownToolsAbove)
    actions.push(
      <Button
        key="rename"
        disabled={busy}
        onClick={() => {
          askText(t("tournaments.teams.renamePrompt"), team.name, (renamed) => props.teams.rename(team.id, renamed), {
            maxLength: 30,
          });
        }}
      >
        {t("tournaments.teams.rename")}
      </Button>,
    );
  if (open && (organiser || (props.captain && !ownToolsAbove)))
    actions.push(
      <Button
        key="disband"
        disabled={busy}
        onClick={() => {
          askConfirm(t("tournaments.teams.disbandConfirm"), () => props.teams.disband(team.id), { danger: true });
        }}
      >
        {t("tournaments.teams.disband")}
      </Button>,
    );
  if (props.extra) actions.push(<span key="extra">{props.extra}</span>);

  return (
    <li
      className={[
        "tournament-team-card",
        props.isMine ? "is-mine" : "",
        full ? "is-full" : "",
        // Streamer mode keeps who is out off screen too.
        eliminated ? "is-eliminated" : "",
      ]
        .filter((part) => part !== "")
        .join(" ")}
    >
      {/* Two fixed rows whatever the team has to show, so the rosters below
          start at the same height in every card of a row: the name with its
          placing or check-in, then the rating. */}
      <div className="tournament-team-card-head">
        <div className="tournament-team-card-title">
          <span className="tournament-team-name" title={props.name}>
            {props.name}
          </span>
          {rank !== null && (
            <span className={rank <= 3 ? "tournament-team-rank is-podium mono" : "tournament-team-rank mono"}>
              <Icon name="trophy" size={12} /> {rank}.
            </span>
          )}
          {open && full && team.checkedIn && (
            <span className="tournament-badge is-ok">{t("tournaments.entrants.checkedIn")}</span>
          )}
        </div>
        <div className="tournament-team-card-sub">
          <RatingMeter event={event} team={team} />
        </div>
      </div>

      <Roster event={event} team={team} profiles={props.profiles} showOpen={open} />

      {/* Requests are the captain's to answer, or an organiser's. A captain
          answers their own team's in the Your team card, with its other tools. */}
      {(props.captain || organiser) && open && !ownToolsAbove && (
        <JoinRequests event={event} team={team} profiles={props.profiles} busy={busy} teams={props.teams} />
      )}

      {actions.length > 0 && <div className="tournament-team-card-actions">{actions}</div>}
    </li>
  );
}

/** Players asking to join, each with the answer beside them. */
function JoinRequests({
  event,
  team,
  profiles,
  busy,
  teams,
}: {
  event: Tourney;
  team: TourneyTeam;
  profiles: PlayerSummary[];
  busy: boolean;
  teams: Pick<TeamActions, "respondJoin">;
}) {
  const { t } = useTranslation();
  if (team.joinRequests.length === 0) return null;
  const full = teamIsFull(event, team);
  return (
    <div className="tournament-team-requests">
      <h6>
        {t("tournaments.teams.requests")}
        <span className="tournaments-group-count">{team.joinRequests.length}</span>
      </h6>
      <ul className="tournament-team-rows">
        {team.joinRequests.map((ask) => {
          const asker = event.players.find((player) => player.id === ask.playerId);
          return (
            <li className="tournament-team-row" key={ask.playerId}>
              <span className="tournament-team-row-name">
                <EntrantName
                  name={ask.name}
                  fafId={asker?.fafId ?? null}
                  profile={asker ? profileOf(profiles, asker) : null}
                />
              </span>
              {asker !== undefined && asker.rating !== null && (
                <span className="tournament-roster-rating mono">{asker.rating}</span>
              )}
              <span className="tournament-team-row-actions">
                <Button
                  variant="primary"
                  disabled={busy || full}
                  onClick={() => teams.respondJoin(team.id, ask.playerId, true)}
                >
                  {t("tournaments.teams.accept")}
                </Button>
                <Button disabled={busy} onClick={() => teams.respondJoin(team.id, ask.playerId, false)}>
                  {t("tournaments.teams.decline")}
                </Button>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
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
 * The players looking for a team, as the people captains are recruiting: a tile
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
    <TeamSection
      className="tournament-free-agents"
      title={t("tournaments.teams.freeAgents")}
      count={String(players.length)}
      hint={
        <>
          {t("tournaments.teams.freeAgentsLooking")}
          {average !== null && ` · ${t("tournaments.teams.averageRating", { rating: average })}`}
          {recruiting !== null && ` · ${t("tournaments.teams.youCanInvite")}`}
        </>
      }
      tools={
        <div className="tournament-team-section-tools">
          <div className="tournament-round-nav" role="group" aria-label={t("tournaments.teams.sortBy")}>
            {(["rating", "name", "new"] as const).map((key) => (
              <button
                type="button"
                key={key}
                className={props.sort === key ? "is-active" : undefined}
                aria-pressed={props.sort === key}
                onClick={() => props.onSort(key)}
              >
                {sortLabel[key]}
              </button>
            ))}
          </div>
          {props.onFromFreeAgent !== null && (
            <Button
              disabled={busy || event.players.every((player) => player.teamId !== null)}
              onClick={props.onFromFreeAgent}
            >
              <Icon name="plus" size={16} /> {t("tournaments.teams.fromFreeAgent")}
            </Button>
          )}
        </div>
      }
    >
      <ul className="tournament-free-agent-grid">
        {sortFreeAgents(players, props.sort).map((player) => {
          const invited = recruiting !== null && recruiting.invites.some((held) => held.playerId === player.id);
          return (
            <li className={invited ? "tournament-free-agent is-invited" : "tournament-free-agent"} key={player.id}>
              <span className="tournament-free-agent-avatar" aria-hidden>
                <Icon name="user" size={14} />
              </span>
              <span className="tournament-free-agent-who">
                <span className="tournament-entrant-name">
                  <EntrantName name={player.name} fafId={player.fafId} profile={profileOf(props.profiles, player)} />
                </span>
                {player.discord !== "" && (
                  <span className="tournament-discord muted" title={t("tournaments.entrants.discord")}>
                    <Icon name="discord" size={12} /> {player.discord}
                  </span>
                )}
              </span>
              <span className="tournament-roster-rating mono">{player.rating ?? "–"}</span>
              {recruiting !== null &&
                (invited ? (
                  <Button disabled={busy} onClick={() => props.onCancelInvite(recruiting.id, player.id)}>
                    {t("tournaments.teams.cancelInvite")}
                  </Button>
                ) : (
                  <Button variant="primary" disabled={busy} onClick={() => props.onInvite(recruiting.id, player.id)}>
                    {t("tournaments.teams.inviteAction")}
                  </Button>
                ))}
            </li>
          );
        })}
      </ul>
    </TeamSection>
  );
}

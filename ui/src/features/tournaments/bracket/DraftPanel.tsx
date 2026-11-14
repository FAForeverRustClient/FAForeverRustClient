// The captains draft, as the Teams section of a draft event.
//
// It used to be a section of its own beside Teams, and the two drew the same
// thing twice: the captains' teams, and the players nobody had taken (the
// draft's pool is the Teams section's free agents). So in a draft event the
// draft is the Teams section, built from that section's parts: the team cards,
// the grouped cards on the left, and the narrow column on the right for what
// the teams are not, here the draft's state and its rules.
//
// The order is the service's and is walked, not rebuilt: captains pick
// concurrently, so a locally computed turn would disagree with whoever picked
// last. Everything here reads `event.draft`.
//
// Two states, and they are different screens rather than the same one greyed
// out: before the draft, an organiser chooses the captains, by hand or as the
// top so many by rating; during it, whoever is on the clock picks from the
// pool. Once the bracket is under way the ordinary Teams section takes over,
// with its placings and its reserves.

import { useState } from "react";
import { Button } from "../../../design-system/Button";
import type { CaptainMode, PlayerSummary, Tourney, TourneyPlayer, TourneyTeam } from "../../../ipc/bindings";
import type { OrganiserActions, TeamActions } from "../tourneyActions";
import { useTranslation } from "../../../i18n/useTranslation";
import { PlayerChip } from "../PlayerChip";
import { PlayerTable } from "../PlayerTable";
import { TeamCard, TeamSection } from "../detail/TeamsPanel";
import {
  draftTurn,
  isLegalFrom,
  mayPick,
  mayUndoPick,
  profileOf,
  undrafted,
} from "../../../shared/rules/tourneyRules";

/**
 * Whether the Teams section of this event is the draft: an organiser choosing
 * captains before it starts, the draft running, or its teams complete and the
 * bracket not yet drawn, while the last pick can still be taken back.
 */
export function showsDraft(event: Tourney): boolean {
  if (event.formation !== "draft") return false;
  if (event.draft === null) return event.viewer.organiser && isLegalFrom("startDraft", event.status);
  return event.status === "draft" || event.status === "drafted";
}

interface DraftPanelProps {
  event: Tourney;
  profiles: PlayerSummary[];
  busy: boolean;
  /** Picking, undoing a pick, naming the captains, and the team cards' own tools. */
  teams: TeamActions;
  /** Starting the draft, and the organiser's single-call changes. */
  organiser: Pick<OrganiserActions, "advance" | "admin">;
}

export function DraftPanel(props: DraftPanelProps) {
  if (props.event.draft === null) return <CaptainSetup {...props} />;
  return <LiveDraft {...props} />;
}

/** Before the draft: an organiser marks the captains and closes signups. */
function CaptainSetup(props: DraftPanelProps) {
  const { event, busy } = props;
  const { t } = useTranslation();
  const [captains, setCaptains] = useState<string[]>(event.pendingCaptains);
  const [mode, setMode] = useState<CaptainMode>(event.captainMode);
  const [count, setCount] = useState(event.captainCount >= 2 ? String(event.captainCount) : "");

  if (!event.viewer.organiser || !isLegalFrom("startDraft", event.status)) return null;
  const eligible = event.players.filter((player) => !player.pending);
  // Worked out by the service at the moment the draft starts, so this is a
  // preview: late signups and rating corrections still move it.
  const ranked = [...eligible].sort((left, right) => (right.rating ?? 0) - (left.rating ?? 0));
  const wanted = Number.parseInt(count, 10);
  const validCount = Number.isInteger(wanted) && wanted >= 2 && wanted <= 64;
  const teams = mode === "rating" ? (validCount ? wanted : 0) : captains.length;
  const ready = mode === "rating" ? validCount && ranked.length >= wanted : captains.length >= 2;
  const saveMode = (next: CaptainMode, typed: string) => {
    const parsed = Number.parseInt(typed, 10);
    props.organiser.admin({
      type: "setCaptainMode",
      payload: { mode: next, count: Number.isInteger(parsed) ? parsed : 0 },
    });
  };
  // Inside a checkbox label a button would take the click the box should, so
  // the captains list keeps the plain chip.
  const chipOf = (player: TourneyPlayer) => {
    const profile = profileOf(props.profiles, player);
    return profile ? <PlayerChip player={profile} overrideName={player.name} /> : player.name;
  };

  return (
    <div className="tournament-columns tournament-teams">
      <div className="tournament-columns-main">
        {mode === "manual" ? (
          <TeamSection
            title={t("tournaments.draft.captainsHeading")}
            count={String(captains.length)}
            hint={t("tournaments.draft.captainsHint")}
          >
            <ul className="tournament-free-agent-grid">
              {eligible.map((player) => {
                const chosen = captains.includes(player.id);
                return (
                  <li className={chosen ? "tournament-free-agent is-invited" : "tournament-free-agent"} key={player.id}>
                    <label className="tournament-checkbox tournament-free-agent-who">
                      <input
                        type="checkbox"
                        checked={chosen}
                        onChange={() =>
                          setCaptains((held) =>
                            held.includes(player.id) ? held.filter((id) => id !== player.id) : [...held, player.id],
                          )
                        }
                      />
                      <span className="tournament-entrant-name">{chipOf(player)}</span>
                    </label>
                    <span className="tournament-roster-rating mono">{player.rating ?? "–"}</span>
                  </li>
                );
              })}
            </ul>
          </TeamSection>
        ) : (
          // The captains as the service would choose them right now: the top
          // so many of the field by rating.
          <TeamSection
            title={t("tournaments.draft.captainsHeading")}
            count={validCount ? String(Math.min(wanted, ranked.length)) : undefined}
            hint={
              !validCount
                ? t("tournaments.draft.previewEnter")
                : ranked.length < wanted
                  ? t("tournaments.draft.previewShort", { have: ranked.length, more: wanted - ranked.length })
                  : undefined
            }
          >
            {validCount && ranked.length > 0 && (
              <PlayerTable event={event} profiles={props.profiles} players={ranked.slice(0, wanted)} />
            )}
          </TeamSection>
        )}
      </div>

      <aside className="tournament-columns-aside">
        <section className="tournament-panel tournament-draft-setup">
          <h4>{t("tournaments.draft.heading")}</h4>
          <label className="tournament-field">
            <span>{t("tournaments.draft.howChosen")}</span>
            <select
              value={mode}
              disabled={busy}
              onChange={(changed) => {
                const next = changed.target.value as CaptainMode;
                setMode(next);
                saveMode(next, count);
              }}
            >
              <option value="manual">{t("tournaments.draft.modeManual")}</option>
              <option value="rating">{t("tournaments.draft.modeRating")}</option>
            </select>
          </label>
          {mode === "rating" && (
            <label className="tournament-field">
              <span>{t("tournaments.draft.howMany")}</span>
              <input
                type="number"
                min={2}
                max={64}
                value={count}
                placeholder="8"
                onChange={(changed) => setCount(changed.target.value)}
                onBlur={() => {
                  if (validCount && wanted !== event.captainCount) saveMode(mode, count);
                }}
              />
              <small className="muted">{t("tournaments.draft.howManyHint")}</small>
            </label>
          )}
          {teams >= 2 && (
            <p className="muted tournament-team-aside-note">
              {t("tournaments.draft.bracketPreview", { teams, size: event.teamSize, needed: teams * event.teamSize })}
              {eligible.length < teams * event.teamSize &&
                ` ${t("tournaments.draft.moreNeeded", { have: eligible.length, more: teams * event.teamSize - eligible.length })}`}
            </p>
          )}
          <div className="tournament-draft-actions">
            {mode === "manual" && (
              <Button disabled={busy} onClick={() => props.teams.setCaptains(captains)}>
                {t("tournaments.draft.saveCaptains")}
              </Button>
            )}
            {/* The service wants at least two, and says so. Checking here keeps
                the refusal off a button that looks ready. */}
            <Button
              variant="primary"
              disabled={busy || !ready}
              onClick={() => props.organiser.advance("startDraft")}
            >
              {t("tournaments.draft.start")}
            </Button>
          </div>
        </section>

        <DraftRules event={event} />
      </aside>
    </div>
  );
}

/** The draft under way, or complete and not yet drawn. */
function LiveDraft(props: DraftPanelProps) {
  const { event, busy } = props;
  const { t } = useTranslation();
  const draft = event.draft;
  if (draft === null) return null;

  const teamName = (teamId: string) => {
    const team = event.teams.find((held) => held.id === teamId);
    const named = team?.name.trim() ?? "";
    if (named !== "") return named;
    const captain = event.players.find((player) => player.id === team?.captainId);
    return captain?.name ?? teamId;
  };

  const turn = draftTurn(event);
  const pool = undrafted(event);
  const mine = mayPick(event);
  const myPlayerId = event.viewer.signedUpPlayerId;
  // Who picks after the team on the clock, so a captain can see their turn
  // coming. The service's order, walked as it is.
  const upNext = draft.order.slice(draft.current + 1, draft.current + 1 + UP_NEXT).map(teamName);

  return (
    <div className="tournament-columns tournament-teams">
      <div className="tournament-columns-main">
        {/* What every captain has so far: the thing a pick is weighed against. */}
        <TeamSection title={t("tournaments.section.teams")} count={String(event.teams.length)}>
          <ul className="tournament-team-grid">
            {draftTeams(event).map((team) => (
              <TeamCard
                key={team.id}
                event={event}
                team={team}
                name={teamName(team.id)}
                profiles={props.profiles}
                busy={busy}
                isMine={team.id === event.viewer.memberTeamId}
                captain={myPlayerId !== null && team.captainId === myPlayerId}
                mayAsk={false}
                asked={false}
                overCap={false}
                draft={{ onClock: team.id === turn }}
                teams={props.teams}
                onChangeCaptain={() => undefined}
                onAdmin={props.organiser.admin}
              />
            ))}
          </ul>
        </TeamSection>

        {turn !== null ? (
          <TeamSection title={t("tournaments.draft.pool")} count={String(pool.length)}>
            {pool.length === 0 ? (
              <p className="muted">{t("tournaments.draft.poolEmpty")}</p>
            ) : (
              // Ranked by the event's own rating, highest first, with every
              // name a way to the player's card. The Pick is live only for
              // whoever is on the clock; everyone else reads the same pool,
              // which is how a draft is followed.
              <PlayerTable
                event={event}
                profiles={props.profiles}
                players={pool}
                action={
                  mine
                    ? {
                        heading: t("tournaments.draft.pick"),
                        render: (player) => (
                          <Button disabled={busy} onClick={() => props.teams.draftPick(player.id)}>
                            {t("tournaments.draft.pick")}
                          </Button>
                        ),
                      }
                    : undefined
                }
              />
            )}
          </TeamSection>
        ) : (
          // Every team is full: whoever is left over is in reserve, as a free
          // agent is once the field is locked.
          pool.length > 0 && (
            <TeamSection
              title={t("tournaments.teams.freeAgents")}
              count={String(pool.length)}
              hint={t("tournaments.teams.freeAgentsReserve")}
            >
              <PlayerTable event={event} profiles={props.profiles} players={pool} />
            </TeamSection>
          )
        )}
      </div>

      <aside className="tournament-columns-aside">
        <section className={turn !== null && mine ? "tournament-panel tournament-draft-state is-yours" : "tournament-panel tournament-draft-state"}>
          <h4>{t("tournaments.draft.heading")}</h4>
          {turn === null ? (
            <p className="muted tournament-team-aside-note">{t("tournaments.draft.finished")}</p>
          ) : (
            <>
              <p className="tournament-draft-clock">
                {t("tournaments.draft.onTheClock", { team: teamName(turn) })}
                {mine && <strong> {t("tournaments.draft.yours")}</strong>}
              </p>
              <p className="muted tournament-team-aside-note">
                {t("tournaments.draft.remaining", { count: draft.order.length - draft.current })}
              </p>
              {upNext.length > 0 && (
                <p className="muted tournament-team-aside-note">
                  {t("tournaments.draft.upNext", { teams: upNext.join(" → ") })}
                </p>
              )}
            </>
          )}
          {mayUndoPick(event) && (
            <div className="tournament-draft-actions">
              <Button disabled={busy} onClick={props.teams.draftUndo}>
                {t("tournaments.draft.undo")}
              </Button>
            </div>
          )}
        </section>

        <DraftRules event={event} />
      </aside>
    </div>
  );
}

/** How the draft runs: the Teams section's "how places are given out". */
function DraftRules({ event }: { event: Tourney }) {
  const { t } = useTranslation();
  return (
    <section className="tournament-panel">
      <h4>{t("tournaments.teams.howPlaces")}</h4>
      <ul className="tournament-team-rules">
        <li>{t("tournaments.draft.captainsAreTeams")}</li>
        <li>{t(event.draftSnakes ? "tournaments.draft.orderSnake" : "tournaments.draft.orderLinear")}</li>
        <li>{t("tournaments.draft.teamOf", { size: event.teamSize })}</li>
      </ul>
    </section>
  );
}

/** How many teams after the one on the clock the draft names. */
const UP_NEXT = 3;

/**
 * The teams in the order they first pick: the order captains read the draft
 * in. A team the order never names (none, in a well-formed draft) goes last.
 */
function draftTeams(event: Tourney): TourneyTeam[] {
  const order = event.draft?.order ?? [];
  const first = (team: TourneyTeam) => {
    const at = order.indexOf(team.id);
    return at === -1 ? Number.MAX_SAFE_INTEGER : at;
  };
  return [...event.teams].sort((left, right) => first(left) - first(right));
}

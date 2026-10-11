// The organiser's control of who is on which team.
//
// Separate from `EntrantAdmin`, which is about getting people *into* the event.
// This is about arranging them once they are in: hand the armband to somebody
// else, move a player across, park a substitute, attach a note, and, only where
// the event fetches no ratings, set one by hand.
//
// All four are refused by the service once the bracket is drawn, because the
// draw is made from the teams. So the whole section disappears then rather than
// offering controls that answer "the format is locked".
//
// Drawn as the Teams tab draws its teams, one card each in a grid, so the two
// read as the same field. A member's line used to carry five labelled buttons
// and a select, which wrapped into each other on any card narrower than the
// pane; the occasional tools are now square icons with their name as a
// tooltip, and moving is one compact select at the end of the line.

import { useState } from "react";
import { Button } from "../../../design-system/Button";
import { Icon } from "../../../design-system/Icon";
import type { PlayerSummary, Tourney, TourneyPlayer, TourneyTeam } from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";
import { PlayerChip } from "../PlayerChip";
import { askText } from "../tourneyDialogs";
import { maySetRating, profileOf, teamMembers } from "../../../shared/rules/tourneyRules";

interface TeamAdminProps {
  event: Tourney;
  profiles: PlayerSummary[];
  busy: boolean;
  onSetCaptain: (teamId: string, playerId: string) => void;
  onMovePlayer: (playerId: string, teamId: string | null) => void;
  onEditPlayer: (playerId: string, note: string, rating: number | null) => void;
  onSetDivision: (teamId: string, division: number) => void;
}

export function TeamAdmin(props: TeamAdminProps) {
  const { t } = useTranslation();
  const { event, busy } = props;
  /** Which entrant's note is being edited, and the text so far. */
  const [editing, setEditing] = useState<{ playerId: string; note: string } | null>(null);

  const canRate = maySetRating(event);
  const teamed = new Set(event.teams.flatMap((team) => team.playerIds));
  const parked = event.players.filter((player) => !player.pending && !teamed.has(player.id));
  const teamLabel = (team: TourneyTeam) => (team.name.trim() === "" ? team.id : team.name);

  /** Teams this player could still move to: not their own, and not full. */
  const destinations = (player: TourneyPlayer) =>
    event.teams.filter((team) => team.id !== player.teamId && team.playerIds.length < event.teamSize);

  const noteEditor = (player: TourneyPlayer) => (
    <li className="tournament-admin-row is-editing" key={player.id}>
      <form
        className="tournament-admin-note"
        onSubmit={(submitted) => {
          submitted.preventDefault();
          if (editing === null) return;
          props.onEditPlayer(player.id, editing.note, null);
          setEditing(null);
        }}
      >
        <label className="tournament-field">
          <span>{t("tournaments.teamAdmin.note")}</span>
          <input
            value={editing?.note ?? ""}
            onChange={(changed) => setEditing({ playerId: player.id, note: changed.target.value })}
            placeholder={t("tournaments.teamAdmin.notePlaceholder")}
            maxLength={40}
            autoFocus
          />
        </label>
        <div className="tournament-admin-note-actions">
          <Button disabled={busy} onClick={() => setEditing(null)}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {t("tournaments.teamAdmin.saveNote")}
          </Button>
        </div>
      </form>
    </li>
  );

  const row = (player: TourneyPlayer, teamId: string | null, isCaptain: boolean) => {
    if (editing?.playerId === player.id) return noteEditor(player);
    const profile = profileOf(props.profiles, player);
    const targets = destinations(player);
    return (
      <li className="tournament-admin-row" key={player.id}>
        <span className="tournament-admin-who">
          <span className="tournament-admin-name">
            {profile ? <PlayerChip player={profile} overrideName={player.name} /> : <strong>{player.name}</strong>}
            {isCaptain && (
              <span className="tournament-badge tournament-roster-captain">
                <Icon name="crown" size={12} /> {t("tournaments.teams.captain")}
              </span>
            )}
          </span>
          {/* What the organiser noted, and where to reach them, under the
              name rather than beside it: a line of facts, not a crowd. */}
          {(player.note !== "" || player.discord !== "") && (
            <span className="tournament-admin-facts">
              {player.note !== "" && <span className="tournament-admin-noted">{player.note}</span>}
              {player.discord !== "" && (
                <span className="tournament-discord" title={t("tournaments.entrants.discord")}>
                  <Icon name="discord" size={12} /> {player.discord}
                </span>
              )}
            </span>
          )}
        </span>

        <span className="tournament-roster-rating mono">{player.rating ?? "–"}</span>

        <span className="tournament-admin-tools">
          {/* Only offered to somebody who is not already wearing it. Its
              place is kept on the captain line too, so the rating and the
              other tools stand in one column down the card. */}
          {(teamId === null || isCaptain) && <span className="tournament-admin-gap" aria-hidden />}
          {teamId !== null && !isCaptain && (
            <button
              type="button"
              className="tournaments-icon-button"
              disabled={busy}
              title={t("tournaments.teamAdmin.makeCaptain")}
              aria-label={t("tournaments.teamAdmin.makeCaptain")}
              onClick={() => props.onSetCaptain(teamId, player.id)}
            >
              <Icon name="crown" size={15} />
            </button>
          )}
          <button
            type="button"
            className="tournaments-icon-button"
            disabled={busy}
            title={t("tournaments.teamAdmin.editNote")}
            aria-label={t("tournaments.teamAdmin.editNote")}
            onClick={() => setEditing({ playerId: player.id, note: player.note })}
          >
            <Icon name="edit" size={15} />
          </button>
          {/* Only an unrated event: everywhere else the service fetched the
              rating and refuses a typed one. */}
          {canRate && (
            <button
              type="button"
              className="tournaments-icon-button"
              disabled={busy}
              title={t("tournaments.teamAdmin.setRating")}
              aria-label={t("tournaments.teamAdmin.setRating")}
              onClick={() =>
                askText(
                  t("tournaments.teamAdmin.ratingPrompt"),
                  player.rating === null ? "" : String(player.rating),
                  (typed) => {
                    const rating = Number(typed);
                    if (!Number.isFinite(rating) || rating < 0 || rating > 4000) return;
                    props.onEditPlayer(player.id, player.note, Math.round(rating));
                  },
                  { title: t("tournaments.teamAdmin.setRating"), numeric: true, maxLength: 4 },
                )
              }
            >
              <Icon name="activity" size={15} />
            </button>
          )}
          {/* Parking keeps them in the event without a team, which is what a
              substitute is. */}
          {teamId === null && <span className="tournament-admin-gap" aria-hidden />}
          {teamId !== null && (
            <button
              type="button"
              className="tournaments-icon-button is-danger"
              disabled={busy}
              title={t("tournaments.teamAdmin.park")}
              aria-label={t("tournaments.teamAdmin.park")}
              onClick={() => props.onMovePlayer(player.id, null)}
            >
              <Icon name="userX" size={15} />
            </button>
          )}
          {/* One select rather than a button per team: a field of eight teams
              would otherwise put eight buttons on every line. */}
          {targets.length > 0 && (
            <select
              className="tournament-admin-move"
              value=""
              disabled={busy}
              aria-label={t("tournaments.teamAdmin.moveTo")}
              title={t("tournaments.teamAdmin.moveTo")}
              onChange={(changed) => {
                if (changed.target.value !== "") props.onMovePlayer(player.id, changed.target.value);
              }}
            >
              <option value="">{t("tournaments.teamAdmin.moveTo")}</option>
              {targets.map((team) => (
                <option value={team.id} key={team.id}>
                  {teamLabel(team)}
                </option>
              ))}
            </select>
          )}
        </span>
      </li>
    );
  };

  return (
    <div className="tournament-admin-teams">
      <p className="muted tournament-console-hint">{t("tournaments.teamAdmin.hint")}</p>

      <ul className="tournament-team-grid tournament-admin-grid">
        {[...event.teams]
          .sort((left, right) => left.seed - right.seed)
          .map((team) => {
            const full = team.playerIds.length >= event.teamSize;
            return (
              <li className={full ? "tournament-team-card is-full" : "tournament-team-card"} key={team.id}>
                <div className="tournament-admin-team-head">
                  <span className="tournament-team-name" title={teamLabel(team)}>
                    {teamLabel(team)}
                  </span>
                  <span className={full ? "tournament-console-tag is-ok" : "tournament-console-tag"}>
                    {team.playerIds.length} / {event.teamSize}
                  </span>
                  {/* Splitting the field creates the divisions; this is how one
                      team moves between them afterwards, which is what fixes an
                      uneven split without redoing the whole thing. */}
                  {event.divisions > 1 && (
                    <label className="tournament-admin-division">
                      <span>{t("tournaments.teamAdmin.division")}</span>
                      <select
                        value={team.division}
                        disabled={busy}
                        onChange={(changed) => props.onSetDivision(team.id, Number(changed.target.value))}
                      >
                        {Array.from({ length: event.divisions }, (_, index) => (
                          <option key={index} value={index}>
                            {index + 1}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
                <ul className="tournament-admin-rows">
                  {teamMembers(event, team).map((member) => row(member, team.id, team.captainId === member.id))}
                </ul>
              </li>
            );
          })}
      </ul>

      {parked.length > 0 && (
        <section className="tournament-admin-parked">
          <h6 className="tournament-console-subhead">
            {t("tournaments.teamAdmin.unteamed")}
            <span className="tournaments-group-count">{parked.length}</span>
          </h6>
          <ul className="tournament-admin-rows is-parked">{parked.map((player) => row(player, null, false))}</ul>
        </section>
      )}
    </div>
  );
}

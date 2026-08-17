// The organiser's control of who is on which team.
//
// Separate from `EntrantAdmin`, which is about getting people *into* the event.
// This is about arranging them once they are in: hand the armband to somebody
// else, move a player across, park a substitute, attach a note, and — only where
// the event fetches no ratings — set one by hand.
//
// All four are refused by the service once the bracket is drawn, because the
// draw is made from the teams. So the whole section disappears then rather than
// offering controls that answer "the format is locked".

import { useState } from "react";
import { Button } from "../../design-system/Button";
import type { PlayerSummary, Tourney, TourneyPlayer } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";
import { PlayerChip } from "./PlayerChip";
import { maySetRating, profileOf, teamMembers } from "./tourneyPresentation";

interface TeamAdminProps {
  event: Tourney;
  profiles: PlayerSummary[];
  busy: boolean;
  onSetCaptain: (teamId: string, playerId: string) => void;
  onMovePlayer: (playerId: string, teamId: string | null) => void;
  onEditPlayer: (playerId: string, note: string, rating: number | null) => void;
}

export function TeamAdmin(props: TeamAdminProps) {
  const { t } = useTranslation();
  const { event, busy } = props;
  /** Which entrant's note is being edited, and the text so far. */
  const [editing, setEditing] = useState<{ playerId: string; note: string } | null>(null);

  const canRate = maySetRating(event);
  const teamed = new Set(event.teams.flatMap((team) => team.playerIds));
  const parked = event.players.filter((player) => !player.pending && !teamed.has(player.id));

  const nameOf = (player: TourneyPlayer) => {
    const profile = profileOf(props.profiles, player);
    return profile ? <PlayerChip player={profile} overrideName={player.name} /> : player.name;
  };

  /** Teams this player could still move to: not their own, and not full. */
  const destinations = (player: TourneyPlayer) =>
    event.teams.filter(
      (team) => team.id !== player.teamId && team.playerIds.length < event.teamSize,
    );

  const noteEditor = (player: TourneyPlayer) => (
    <form
      className="tournament-form-row"
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
      <Button type="submit" variant="primary" disabled={busy}>
        {t("tournaments.teamAdmin.saveNote")}
      </Button>
      <Button disabled={busy} onClick={() => setEditing(null)}>
        {t("common.cancel")}
      </Button>
    </form>
  );

  const row = (player: TourneyPlayer, teamId: string | null, isCaptain: boolean) => (
    <li className="tournament-entrant" key={player.id}>
      <span className="tournament-entrant-name">
        {nameOf(player)}
        {player.note !== "" && <span className="muted"> ({player.note})</span>}
      </span>

      {isCaptain && <span className="muted">{t("tournaments.teams.captain")}</span>}

      {/* Only offered to somebody who is not already wearing it. */}
      {teamId !== null && !isCaptain && (
        <Button disabled={busy} onClick={() => props.onSetCaptain(teamId, player.id)}>
          {t("tournaments.teamAdmin.makeCaptain")}
        </Button>
      )}

      {/* One select rather than a button per team: a field of eight teams would
          otherwise put eight buttons on every row. */}
      {destinations(player).length > 0 && (
        <select
          value=""
          disabled={busy}
          aria-label={t("tournaments.teamAdmin.moveTo")}
          onChange={(changed) => {
            if (changed.target.value !== "") props.onMovePlayer(player.id, changed.target.value);
          }}
        >
          <option value="">{t("tournaments.teamAdmin.moveTo")}</option>
          {destinations(player).map((team) => (
            <option value={team.id} key={team.id}>
              {team.name.trim() === "" ? team.id : team.name}
            </option>
          ))}
        </select>
      )}

      {/* Parking keeps them in the event without a team, which is what a
          substitute is. */}
      {teamId !== null && (
        <Button disabled={busy} onClick={() => props.onMovePlayer(player.id, null)}>
          {t("tournaments.teamAdmin.park")}
        </Button>
      )}

      <Button
        disabled={busy}
        onClick={() => setEditing({ playerId: player.id, note: player.note })}
      >
        {t("tournaments.teamAdmin.editNote")}
      </Button>

      {/* Only an unrated event: everywhere else the service fetched the rating
          and refuses a typed one. */}
      {canRate && (
        <Button
          disabled={busy}
          onClick={() => {
            const typed = window.prompt(
              t("tournaments.teamAdmin.ratingPrompt"),
              player.rating === null ? "" : String(player.rating),
            );
            if (typed === null) return;
            const rating = Number(typed.trim());
            if (!Number.isFinite(rating) || rating < 0 || rating > 4000) return;
            props.onEditPlayer(player.id, player.note, Math.round(rating));
          }}
        >
          {t("tournaments.teamAdmin.setRating")}
        </Button>
      )}
    </li>
  );

  return (
    <div className="tournament-entrant-admin">
      <p className="tournament-form-hint muted">{t("tournaments.teamAdmin.hint")}</p>

      <ul className="tournament-team-list">
        {[...event.teams]
          .sort((left, right) => left.seed - right.seed)
          .map((team) => (
            <li className="surface tournament-team" key={team.id}>
              <div className="tournament-team-header">
                <span className="tournament-team-name">
                  {team.name.trim() === "" ? team.id : team.name}
                </span>
                <span className="muted">
                  {team.playerIds.length}/{event.teamSize}
                </span>
              </div>
              <ul className="tournament-entrant-list">
                {teamMembers(event, team).map((member) =>
                  editing?.playerId === member.id
                    ? <li className="tournament-entrant" key={member.id}>{noteEditor(member)}</li>
                    : row(member, team.id, team.captainId === member.id),
                )}
              </ul>
            </li>
          ))}
      </ul>

      {parked.length > 0 && (
        <section>
          <h5>{t("tournaments.teamAdmin.unteamed")}</h5>
          <ul className="tournament-entrant-list">
            {parked.map((player) =>
              editing?.playerId === player.id
                ? <li className="tournament-entrant" key={player.id}>{noteEditor(player)}</li>
                : row(player, null, false),
            )}
          </ul>
        </section>
      )}
    </div>
  );
}

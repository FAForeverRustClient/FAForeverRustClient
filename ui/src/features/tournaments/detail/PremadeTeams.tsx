// Premade teams during signups: a free-for-all of teams, where players give a
// team name when they sign up and are grouped by it when signups close.
//
// The website's premade view: the signed-in player's own team name, which
// they can change here rather than withdrawing and signing up again (which
// cost people their place); the teams forming, grouped the way the service
// will group them; and who has no name yet and will be a substitute. An
// organiser can set anybody's name.

import { useState } from "react";
import { Button } from "../../../design-system/Button";
import { Modal } from "../../../design-system/Modal";
import type { Tourney, TourneyAdmin, TourneyPlayer } from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";

/** Players grouped by team name, case-insensitively, largest team first. */
export function premadeGroups(event: Tourney): { name: string; members: TourneyPlayer[] }[] {
  const groups = new Map<string, TourneyPlayer[]>();
  for (const player of event.players.filter((held) => !held.pending)) {
    const key = (player.teamName ?? "").trim().toLowerCase();
    if (key === "") continue;
    const held = groups.get(key);
    if (held === undefined) groups.set(key, [player]);
    else held.push(player);
  }
  return [...groups.entries()]
    .sort(([leftKey, left], [rightKey, right]) => right.length - left.length || leftKey.localeCompare(rightKey))
    .map(([, members]) => {
      const sorted = [...members].sort((left, right) => (right.rating ?? 0) - (left.rating ?? 0));
      return { name: (sorted[0].teamName ?? "").trim(), members: sorted };
    });
}

export function PremadeTeams({
  event,
  busy,
  onAdmin,
}: {
  event: Tourney;
  busy: boolean;
  onAdmin: (change: TourneyAdmin) => void;
}) {
  const { t } = useTranslation();
  const me = event.players.find((player) => player.id === event.viewer.signedUpPlayerId) ?? null;
  const [name, setName] = useState(me?.teamName ?? "");
  const [editing, setEditing] = useState<TourneyPlayer | null>(null);
  const [editName, setEditName] = useState("");
  const organiser = event.viewer.organiser;
  const groups = premadeGroups(event);
  const unnamed = event.players
    .filter((player) => !player.pending && (player.teamName ?? "").trim() === "")
    .sort((left, right) => (right.rating ?? -1) - (left.rating ?? -1));
  const cap = event.rating.maxTeam;
  const edit = (player: TourneyPlayer) => {
    setEditing(player);
    setEditName(player.teamName ?? "");
  };
  return (
    <>
      {me !== null && (
        <section className="surface tournament-site-panel">
          <h5>{t("tournaments.premade.yours")}</h5>
          <p className="muted">
            {(me.teamName ?? "").trim() !== ""
              ? t("tournaments.premade.entered", { name: (me.teamName ?? "").trim() })
              : t("tournaments.premade.none")}
          </p>
          <div className="tournament-detail-actions">
            <input
              value={name}
              maxLength={30}
              placeholder={t("tournaments.premade.placeholder")}
              onChange={(changed) => setName(changed.target.value)}
            />
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => onAdmin({ type: "setTeamName", payload: { playerId: null, teamName: name } })}
            >
              {t("tournaments.ffa.save")}
            </Button>
          </div>
        </section>
      )}
      {groups.length > 0 && (
        <section className="surface tournament-site-panel">
          <h5>
            {t("tournaments.premade.forming")} <span className="muted">({groups.length})</span>
          </h5>
          <p className="muted">{t("tournaments.premade.formingHint", { size: event.teamSize })}</p>
          <div className="tournament-premade-grid">
            {groups.map((group) => {
              const sum = group.members.reduce((total, player) => total + (player.rating ?? 0), 0);
              const over = group.members.length > event.teamSize;
              return (
                <div
                  key={group.name.toLowerCase()}
                  className={group.members.length === event.teamSize ? "surface tournament-premade is-full" : "surface tournament-premade"}
                >
                  <div className="tournament-premade-head">
                    <strong>{group.name}</strong>
                    {cap !== null && (
                      <span className={sum > cap ? "tournament-warning mono" : "muted mono"} title={t("tournaments.teams.combinedOfMax")}>
                        {sum}/{cap}
                      </span>
                    )}
                    <span className="muted mono">
                      {group.members.length}/{event.teamSize}
                      {over && " ⚠"}
                    </span>
                  </div>
                  {group.members.map((player) => (
                    <div key={player.id}>
                      {player.name} {player.rating !== null && <span className="muted mono">{player.rating}</span>}
                      {player.discord !== "" && <span className="muted"> {"\u{1F4AC}"} {player.discord}</span>}
                      {organiser && (
                        <button type="button" className="tournament-link-button" onClick={() => edit(player)}>
                          {t("tournaments.maps.edit")}
                        </button>
                      )}
                    </div>
                  ))}
                  {over && <p className="tournament-warning">{t("tournaments.premade.tooMany", { size: event.teamSize })}</p>}
                </div>
              );
            })}
          </div>
        </section>
      )}
      {unnamed.length > 0 && (
        <section className="surface tournament-site-panel">
          <h5>
            {t("tournaments.premade.noName")} <span className="muted">({unnamed.length})</span>
          </h5>
          <p className="muted">{t("tournaments.premade.noNameHint")}</p>
          <div className="tournament-detail-actions">
            {unnamed.map((player) => (
              <span className="tournament-badge" key={player.id}>
                {player.name} {player.rating !== null && <span className="muted mono">{player.rating}</span>}
                {organiser && (
                  <button type="button" className="tournament-link-button" onClick={() => edit(player)}>
                    {t("tournaments.premade.setTeam")}
                  </button>
                )}
              </span>
            ))}
          </div>
        </section>
      )}
      {editing !== null && (
        <Modal onClose={() => setEditing(null)} ariaLabel={editing.name} className="tournament-form">
          <h3>{t("tournaments.premade.editTitle", { name: editing.name })}</h3>
          <label className="tournament-field">
            <span>
              {t("tournaments.premade.teamName")} <span className="muted">{t("tournaments.premade.emptySub")}</span>
            </span>
            <input value={editName} maxLength={30} onChange={(changed) => setEditName(changed.target.value)} />
          </label>
          <div className="tournament-form-actions">
            <Button onClick={() => setEditing(null)}>{t("common.cancel")}</Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => {
                onAdmin({ type: "setTeamName", payload: { playerId: editing.id, teamName: editName } });
                setEditing(null);
              }}
            >
              {t("tournaments.ffa.save")}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}

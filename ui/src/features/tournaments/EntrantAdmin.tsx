// The organiser's side of the entrant list: adding, approving, inviting,
// removing, and seeding the field once teams exist.
//
// Adding and inviting take a FAF name, not a free-typed string. The server
// looks it up and refuses one it cannot find, which is the whole reason an
// entry can carry an avatar and a real rating: there is no such thing here as
// an entrant who is not somebody.

import { useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import type { SeedOrder, Tourney } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";

/** Twin of `Tourney::may_reseed`: only between forming teams and the draw. */
export function mayReseed(event: Tourney): boolean {
  return event.status === "drafted" && event.teams.length > 0;
}

interface EntrantAdminProps {
  event: Tourney;
  busy: boolean;
  onAdd: (name: string, rating: number | null) => void;
  onRespondSignup: (playerId: string, accept: boolean) => void;
  onRemove: (playerId: string) => void;
  onInvite: (name: string) => void;
  onUninvite: (fafId: number) => void;
  onReseed: (order: SeedOrder) => void;
  onSplit: (divisions: number) => void;
}

export function EntrantAdmin(props: EntrantAdminProps) {
  const { t } = useTranslation();
  const { event, busy } = props;
  const [addName, setAddName] = useState("");
  const [inviteName, setInviteName] = useState("");

  const pending = event.players.filter((player) => player.pending);
  const signupsOpen = event.status === "signup";
  // Only an unrated tournament asks for a rating: everywhere else the server
  // fetches it, and a number typed here would be ignored.
  const asksForRating = false;

  return (
    <div className="tournament-entrant-admin">
      {pending.length > 0 && (
        <section>
          <h5>{t("tournaments.admin.pending")}</h5>
          <ul className="tournament-entrant-list">
            {pending.map((player) => (
              <li className="tournament-entrant" key={player.id}>
                <span className="tournament-entrant-name">{player.name}</span>
                {player.rating !== null && <span className="muted">{player.rating}</span>}
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => props.onRespondSignup(player.id, true)}
                >
                  {t("tournaments.admin.approve")}
                </Button>
                <Button disabled={busy} onClick={() => props.onRespondSignup(player.id, false)}>
                  {t("tournaments.admin.decline")}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {signupsOpen && (
        <section>
          <h5>{t("tournaments.admin.addHeading")}</h5>
          <form
            className="tournament-form-row"
            onSubmit={(submitted) => {
              submitted.preventDefault();
              if (addName.trim() === "") return;
              props.onAdd(addName, null);
              setAddName("");
            }}
          >
            <label className="tournament-field">
              <span>{t("tournaments.admin.fafName")}</span>
              <input
                value={addName}
                onChange={(changed) => setAddName(changed.target.value)}
                placeholder={t("tournaments.admin.fafNamePlaceholder")}
                maxLength={40}
              />
            </label>
            <Button type="submit" disabled={busy || addName.trim() === ""}>
              <Icon name="plus" size={16} /> {t("tournaments.admin.add")}
            </Button>
          </form>
          {/* Names are exact, because the server matches them exactly. Saying
              so beats the refusal that otherwise arrives. */}
          <p className="tournament-form-hint muted">{t("tournaments.admin.exactNames")}</p>
          {asksForRating && <p className="muted">{t("tournaments.admin.ratingNeeded")}</p>}
        </section>
      )}

      <section>
        <h5>{t("tournaments.admin.inviteHeading")}</h5>
        <form
          className="tournament-form-row"
          onSubmit={(submitted) => {
            submitted.preventDefault();
            if (inviteName.trim() === "") return;
            props.onInvite(inviteName);
            setInviteName("");
          }}
        >
          <label className="tournament-field">
            <span>{t("tournaments.admin.fafName")}</span>
            <input
              value={inviteName}
              onChange={(changed) => setInviteName(changed.target.value)}
              maxLength={40}
            />
          </label>
          <Button type="submit" disabled={busy || inviteName.trim() === ""}>
            {t("tournaments.admin.invite")}
          </Button>
        </form>
        {event.invites.length > 0 && (
          <ul className="tournament-entrant-list">
            {event.invites.map((invite) => (
              <li className="tournament-entrant" key={invite.fafId}>
                <span className="tournament-entrant-name">{invite.name}</span>
                <span className="muted">
                  {t(`tournaments.admin.invite.${invite.status}` as never)}
                </span>
                <Button disabled={busy} onClick={() => props.onUninvite(invite.fafId)}>
                  {t("tournaments.admin.uninvite")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {event.players.length > 0 && (
        <section>
          <h5>{t("tournaments.admin.entrants")}</h5>
          <ul className="tournament-entrant-list">
            {event.players
              .filter((player) => !player.pending)
              .map((player) => (
                <li className="tournament-entrant" key={player.id}>
                  <span className="tournament-entrant-name">
                    {player.name}
                    {player.note !== "" && <span className="muted"> ({player.note})</span>}
                  </span>
                  {player.rating !== null && <span className="muted">{player.rating}</span>}
                  {player.late && (
                    <span className="tournament-badge">{t("tournaments.entrants.late")}</span>
                  )}
                  <Button disabled={busy} onClick={() => props.onRemove(player.id)}>
                    {t("tournaments.admin.remove")}
                  </Button>
                </li>
              ))}
          </ul>
        </section>
      )}

      {/* Seeding only exists between forming teams and drawing the bracket:
          before that there are no teams, after it the draw is fixed. */}
      {mayReseed(event) && (
        <section>
          <h5>{t("tournaments.admin.seeding")}</h5>
          <div className="tournament-detail-actions">
            <Button disabled={busy} onClick={() => props.onReseed({ type: "randomise" })}>
              {t("tournaments.admin.randomise")}
            </Button>
            {/* By rating, best first: the order the server would produce
                itself, sent explicitly so it is a decision rather than a
                default nobody chose. */}
            <Button
              disabled={busy}
              onClick={() =>
                props.onReseed({
                  type: "explicit",
                  payload: {
                    team_ids: [...event.teams]
                      .sort(
                        (left, right) =>
                          right.playerIds.length - left.playerIds.length ||
                          left.seed - right.seed,
                      )
                      .map((team) => team.id),
                  },
                })
              }
            >
              {t("tournaments.admin.seedByRating")}
            </Button>
          </div>

          <label className="tournament-field tournament-divisions">
            <span>{t("tournaments.admin.divisions")}</span>
            <select
              value={event.divisions}
              disabled={busy}
              onChange={(changed) => props.onSplit(Number(changed.target.value) || 1)}
            >
              <option value={0}>{t("tournaments.admin.oneField")}</option>
              {[2, 3, 4, 5, 6].map((count) => (
                <option value={count} key={count}>
                  {count}
                </option>
              ))}
            </select>
          </label>
        </section>
      )}
    </div>
  );
}

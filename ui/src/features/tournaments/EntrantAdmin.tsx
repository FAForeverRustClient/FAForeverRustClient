// The organiser's side of the entrant list: adding, approving, inviting,
// removing, and seeding the field once teams exist.
//
// Adding and inviting pick a FAF *account*, not a typed string. The server
// matches names exactly and refuses one it cannot find, so a typed name is a
// guess that only fails afterwards; picking from a searched list means the
// organiser sees the person — avatar, login, rating — before committing. That is
// also what lets an entry carry an avatar at all: there is no such thing here as
// an entrant who is not somebody.
//
// Every list on this pane shows a person the same way the participant's lists do,
// through `PlayerChip` and the profiles loaded beside the event. They used to
// render bare names, which is how the same entrant could appear as a face in one
// section and a string in another.

import { Button } from "../../design-system/Button";
import type { AccountSearch, PlayerSummary, SeedOrder, Tourney } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";
import { AccountPicker } from "./AccountPicker";
import { PlayerChip } from "./PlayerChip";
import {
  INVITE_STATUS_LABELS,
  mayReseed,
  pendingSignups,
  profileOf,
  profileOfInvite,
} from "./tourneyPresentation";

interface EntrantAdminProps {
  event: Tourney;
  /** The shared name-search state; one picker is in use at a time. */
  accountSearch: AccountSearch;
  onSearchAccounts: (query: string) => void;
  /**
   * The FAF accounts behind the entrants, as loaded beside the event.
   *
   * The organiser's lists show the same people as the participant's, so they
   * show them the same way: as a person with an avatar and a rating, not as a
   * string. Passed in rather than fetched here, because they arrive with the
   * event and one request already covers every list on the pane.
   */
  profiles: PlayerSummary[];
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

  const pending = pendingSignups(event);
  const signupsOpen = event.status === "signup";

  return (
    <div className="tournament-entrant-admin">
      {pending.length > 0 && (
        <section>
          <h5>{t("tournaments.admin.pending")}</h5>
          <ul className="tournament-entrant-list">
            {pending.map((player) => {
              const profile = profileOf(props.profiles, player);
              return (
              <li className="tournament-entrant" key={player.id}>
                <span className="tournament-entrant-name">
                  {profile ? (
                    <PlayerChip player={profile} overrideName={player.name} />
                  ) : (
                    player.name
                  )}
                </span>
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
              );
            })}
          </ul>
        </section>
      )}

      {signupsOpen && (
        <section>
          <h5>{t("tournaments.admin.addHeading")}</h5>
          <AccountPicker
            label={t("tournaments.admin.fafName")}
            placeholder={t("tournaments.admin.fafNamePlaceholder")}
            search={props.accountSearch}
            busy={busy}
            submitLabel={t("tournaments.admin.add")}
            onQueryChange={props.onSearchAccounts}
            // Always without a rating. `org_add_player` accepts one, but only an
            // unrated event needs it, and `publicView` does not send the rating
            // type (see docs/faf-tournaments-api.md), so the client cannot tell
            // one from the other. Asking every organiser for a number the server
            // then ignores is the worse of the two.
            onPick={(login) => props.onAdd(login, null)}
          />
        </section>
      )}

      <section>
        <h5>{t("tournaments.admin.inviteHeading")}</h5>
        <AccountPicker
          label={t("tournaments.admin.fafName")}
          search={props.accountSearch}
          busy={busy}
          submitLabel={t("tournaments.admin.invite")}
          onQueryChange={props.onSearchAccounts}
          onPick={props.onInvite}
        />
        {event.invites.length > 0 && (
          <ul className="tournament-entrant-list">
            {event.invites.map((invite) => {
              // An invitation names its FAF id outright, so the person is known
              // before they have entered anything.
              const profile = profileOfInvite(props.profiles, invite);
              return (
                <li className="tournament-entrant" key={invite.fafId}>
                  <span className="tournament-entrant-name">
                    {profile ? (
                      <PlayerChip player={profile} overrideName={invite.name} />
                    ) : (
                      invite.name
                    )}
                  </span>
                  <span className="muted">{t(INVITE_STATUS_LABELS[invite.status])}</span>
                  <Button disabled={busy} onClick={() => props.onUninvite(invite.fafId)}>
                    {t("tournaments.admin.uninvite")}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {event.players.length > 0 && (
        <section>
          <h5>{t("tournaments.admin.entrants")}</h5>
          <ul className="tournament-entrant-list">
            {event.players
              .filter((player) => !player.pending)
              .map((player) => {
                const profile = profileOf(props.profiles, player);
                return (
                  <li className="tournament-entrant" key={player.id}>
                    <span className="tournament-entrant-name">
                      {profile ? (
                        <PlayerChip player={profile} overrideName={player.name} />
                      ) : (
                        player.name
                      )}
                      {player.note !== "" && <span className="muted"> ({player.note})</span>}
                    </span>
                    {/* The tournament's own rating, which is taken as of the
                        event's rating date and may have been capped: it can
                        differ from the account's, and this is the one that
                        decides seeding. */}
                    {player.rating !== null && <span className="muted">{player.rating}</span>}
                    {player.late && (
                      <span className="tournament-badge">{t("tournaments.entrants.late")}</span>
                    )}
                    <Button disabled={busy} onClick={() => props.onRemove(player.id)}>
                      {t("tournaments.admin.remove")}
                    </Button>
                  </li>
                );
              })}
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

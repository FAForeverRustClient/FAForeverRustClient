// The organiser's side of the entrant list: adding, approving, inviting,
// removing, and seeding the field once teams exist.
//
// Adding and inviting pick a FAF *account*, not a typed string. The server
// matches names exactly and refuses one it cannot find, so a typed name is a
// guess that only fails afterwards; picking from a searched list means the
// organiser sees the person (avatar, login, rating) before committing. That is
// also what lets an entry carry an avatar at all: there is no such thing here as
// an entrant who is not somebody.
//
// Every list on this pane shows a person the same way the participant's lists do,
// through `PlayerChip` and the profiles loaded beside the event. They used to
// render bare names, which is how the same entrant could appear as a face in one
// section and a string in another.

import { useEffect, useState } from "react";
import { Button } from "../../../design-system/Button";
import type {
  AccountSearch,
  EntrantRatings,
  PlayerSummary,
  Replacement,
  SeedOrder,
  Tourney,
  TourneyLoadStatus,
  TourneyPlayer,
} from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";
import { AccountPicker } from "./AccountPicker";
import { BanPlayerDialog } from "./BanPlayerDialog";
import { PlayerRatingsDialog } from "./PlayerRatingsDialog";
import { ReplacePlayerDialog } from "./ReplacePlayerDialog";
import { PlayerChip } from "../PlayerChip";
import { teamNameOf } from "../bracket/matchParts";
import { INVITE_STATUS_LABELS } from "../tourneyPresentation";
import {
  mayReseed,
  pendingSignups,
  profileOf,
  profileOfInvite,
  teamRating,
} from "../../../shared/rules/tourneyRules";

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
  /** One entrant's every rating, and asking for them (issue 158). */
  playerRatings: EntrantRatings | null;
  playerRatingsStatus: TourneyLoadStatus;
  onLoadRatings: (playerId: string, refresh: boolean) => void;
  onBanPlayer: (player: TourneyPlayer, reason: string, expires: number | null, remove: boolean) => void;
  /** Put somebody else in an entrant's place, keeping the place's results. */
  onReplace: (playerId: string, replacement: Replacement) => void;
}

export function EntrantAdmin(props: EntrantAdminProps) {
  const { t } = useTranslation();
  const { event, busy } = props;

  const pending = pendingSignups(event);
  const signupsOpen = event.status === "signup";
  /** The entrant whose ratings are open, or null. */
  const [ratingsOf, setRatingsOf] = useState<TourneyPlayer | null>(null);
  /** The entrant about to be banned, or null. */
  const [banning, setBanning] = useState<TourneyPlayer | null>(null);
  /** The entrant whose place is being handed to somebody else, or null. */
  const [replacing, setReplacing] = useState<TourneyPlayer | null>(null);
  const acceptedInvites = event.invites.filter((invite) => invite.status === "accepted").length;
  // The organiser's own order, by hand, until it is saved. Starts from the
  // seeds the service holds and follows them when a save or a reshuffle lands.
  const bySeed = () => [...event.teams].sort((left, right) => left.seed - right.seed).map((team) => team.id);
  const stored = bySeed().join(",");
  const [order, setOrder] = useState<string[]>(bySeed);
  useEffect(() => setOrder(stored === "" ? [] : stored.split(",")), [stored]);
  const moved = order.join(",") !== stored;
  const move = (index: number, by: number) => {
    const target = index + by;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    [next[index], next[target]] = [next[target], next[index]];
    setOrder(next);
  };
  // A solo entry often has no name of its own and reads as its player, as it
  // does everywhere else in the tab.
  const teamName = (teamId: string) => teamNameOf(event, teamId) ?? teamId;

  return (
    <div className="tournament-entrant-admin">
      {ratingsOf !== null && (
        <PlayerRatingsDialog
          player={ratingsOf}
          ratings={props.playerRatings}
          status={props.playerRatingsStatus}
          onLoad={(refresh) => props.onLoadRatings(ratingsOf.id, refresh)}
          onClose={() => setRatingsOf(null)}
        />
      )}
      {banning !== null && (
        <BanPlayerDialog
          event={event}
          player={banning}
          busy={busy}
          onBan={(reason, expires, remove) => {
            props.onBanPlayer(banning, reason, expires, remove);
            setBanning(null);
          }}
          onClose={() => setBanning(null)}
        />
      )}
      {replacing !== null && (
        <ReplacePlayerDialog
          event={event}
          player={replacing}
          accountSearch={props.accountSearch}
          busy={busy}
          onSearchAccounts={props.onSearchAccounts}
          onReplace={(replacement) => {
            props.onReplace(replacing.id, replacement);
            setReplacing(null);
          }}
          onClose={() => setReplacing(null)}
        />
      )}
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

      {/* Adding somebody outright is a signups-only act, and the service says
          so: `org_add_player` answers "Signups are closed, use the late-signup
          link instead" from every other status. The field used to vanish at that
          point, which reads as the client having lost a feature. It says why
          instead, and points at the one thing that does still work. */}
      {!signupsOpen && (
        <section>
          <h5>{t("tournaments.admin.addHeading")}</h5>
          <p className="muted">{t("tournaments.admin.addClosed")}</p>
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
            // Always without a rating. `org_add_player` accepts one, but only
            // an unrated event has any use for it, and there the rating is set
            // afterwards in the team admin, where `maySetRating` gates it.
            // Asking on every add would put a field in front of every organiser
            // for a number the service ignores in all but one kind of event.
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
                    {/* Every board, not only the one that counts: issue 158. A
                        hand-added entrant has no account to ask about. */}
                    {player.fafId !== null && (
                      <Button
                        disabled={busy}
                        onClick={() => {
                          setRatingsOf(player);
                          props.onLoadRatings(player.id, false);
                        }}
                      >
                        {t("tournaments.admin.ratings")}
                      </Button>
                    )}
                    {/* For somebody in a team: the mid-event drop-out, whose
                        place and results should outlive them. */}
                    {player.teamId !== null && (
                      <Button disabled={busy} onClick={() => setReplacing(player)}>
                        {t("tournaments.replace.replace")}
                      </Button>
                    )}
                    {player.fafId !== null && (
                      <Button disabled={busy} onClick={() => setBanning(player)}>
                        {t("tournaments.admin.ban")}
                      </Button>
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
            {/* Highest combined rating first, unrated last, as the website
                orders it. Worked out from the ratings on screen right now, so
                an organiser's edit to one counts at once. It used to sort by
                team size and the old seed, which is not a rating order at all. */}
            <Button
              disabled={busy}
              onClick={() =>
                props.onReseed({
                  type: "explicit",
                  payload: {
                    team_ids: [...event.teams]
                      .sort((left, right) => teamRating(event, right) - teamRating(event, left))
                      .map((team) => team.id),
                  },
                })
              }
            >
              {t("tournaments.admin.seedByRating")}
            </Button>
            {/* Only where somebody accepted an invitation: the service has no
                invite order to follow otherwise. */}
            {acceptedInvites > 0 && (
              <Button
                disabled={busy}
                title={t("tournaments.admin.seedByInviteHint", { count: acceptedInvites })}
                onClick={() => props.onReseed({ type: "inviteOrder" })}
              >
                {t("tournaments.admin.seedByInvite")}
              </Button>
            )}
          </div>

          {/* By hand: seed 1 at the top. Moves stay local until saved, so a
              reorder is one decision rather than a request per click. */}
          <ol className="tournament-seed-list">
            {order.map((teamId, index) => (
              <li key={teamId} className="tournament-seed-row">
                <span className="mono muted">{index + 1}</span>
                <span className="tournament-seed-name">{teamName(teamId)}</span>
                <span className="mono muted">{(() => {
                  const team = event.teams.find((held) => held.id === teamId);
                  return team === undefined ? "" : teamRating(event, team) || "";
                })()}</span>
                <Button
                  disabled={busy || index === 0}
                  aria-label={t("tournaments.admin.seedUp")}
                  onClick={() => move(index, -1)}
                >
                  {"▲"}
                </Button>
                <Button
                  disabled={busy || index === order.length - 1}
                  aria-label={t("tournaments.admin.seedDown")}
                  onClick={() => move(index, 1)}
                >
                  {"▼"}
                </Button>
              </li>
            ))}
          </ol>
          <div className="tournament-detail-actions">
            <Button
              variant="primary"
              disabled={busy || !moved}
              onClick={() => props.onReseed({ type: "explicit", payload: { team_ids: order } })}
            >
              {t("tournaments.admin.seedSave")}
            </Button>
            {moved && <span className="muted">{t("tournaments.admin.seedUnsaved")}</span>}
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

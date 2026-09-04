import { useMemo, useState, memo } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { Modal } from "../../design-system/Modal";
import { ipc } from "../../ipc/client";
import type { PartyMember, PartyState, PlayerProfile, SocialState } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";
import { PlayerName } from "../../shared/nameColors";
import { ProfileAvatar } from "../../shared/ProfileAvatar";

interface InviteModalProps {
  social: SocialState;
  selfId: number | null;
  partyMemberIds: Set<number>;
  onClose: () => void;
}

function InvitePlayerModal({ social, selfId, partyMemberIds, onClose }: InviteModalProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [invited, setInvited] = useState<Set<number>>(() => new Set());
  const friendNames = useMemo(() => new Set(social.friends.map((name) => name.toLocaleLowerCase())), [social.friends]);
  const candidates = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return social.players
      .filter((player) => player.id !== selfId && !partyMemberIds.has(player.id))
      .filter((player) => !normalized || player.login.toLocaleLowerCase().includes(normalized))
      .sort((left, right) => {
        const friendDelta = Number(friendNames.has(right.login.toLocaleLowerCase())) - Number(friendNames.has(left.login.toLocaleLowerCase()));
        return friendDelta || left.login.localeCompare(right.login);
      });
  }, [friendNames, partyMemberIds, query, selfId, social.players]);

  // Sending again is allowed, and has to be: an invitation is a notification the
  // other side can dismiss, miss, or let expire, and the only recourse is to
  // send another one. The button used to disable itself on the first click,
  // which left the inviter watching a greyed out "Invited" with nothing to do
  // but close the dialog and reopen it.
  const invite = (player: PlayerProfile) => {
    ipc.send({ kind: "Lobby", command: { type: "inviteToParty", payload: { playerId: player.id } } });
    setInvited((current) => new Set(current).add(player.id));
  };

  return (
    <Modal onClose={onClose}>
      <div className="play-dialog-head">
        <div><h2>{t("lobby.party.invite.title")}</h2><p>{t("lobby.party.invite.subtitle")}</p></div>
      </div>
      <label className="search-field matchmaker-invite-search">
        <Icon name="search" size={16} />
        <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("lobby.party.invite.placeholder")} />
      </label>
      <div className="matchmaker-invite-list surface">
        {candidates.length === 0 ? <p className="play-empty">{t("lobby.party.invite.empty")}</p> : candidates.map((player) => {
          const wasInvited = invited.has(player.id);
          const isFriend = friendNames.has(player.login.toLocaleLowerCase());
          return (
            <div className="matchmaker-invite-row" key={player.id}>
              <ProfileAvatar name={player.login} avatarUrl={player.avatarUrl} tooltip={player.avatarTooltip} />
              <span><strong>{player.login}</strong><small>{isFriend ? t("lobby.party.friend") : player.clan ? `[${player.clan}]` : t("lobby.party.player")}</small></span>
              <Button onClick={() => invite(player)}>{t(wasInvited ? "lobby.party.inviteAgain" : "lobby.party.invite")}</Button>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

/** The lobby server's party limit, and the largest matchmaker team size. */
const PARTY_CAPACITY = 4;

interface Props {
  party: PartyState;
  social: SocialState;
  playerId: number | null;
  playerName: string;
  searching: boolean;
}

/**
 * Memoised: the panel above holds a one second clock for the queue countdowns,
 * and a party does not change on that tick.
 */
export const MatchmakerPartyPanel = memo(function MatchmakerPartyPanel({ party, social, playerId, playerName, searching }: Props) {
  const { t } = useTranslation();
  const [inviteOpen, setInviteOpen] = useState(false);
  const isParty = party.members.length > 1;
  const canManageParty = playerId !== null && (party.ownerId === null || playerId === party.ownerId);
  // The lobby's party message carries no names. `PartyMember.to_dict` on the
  // server sends the player id and the factions, nothing else, so every member
  // arrives labelled "Player 123456" by the adapter's fallback. That was
  // visible as soon as a party existed at all: on your own you saw your name,
  // because the seat below is synthesised from the signed-in account, and the
  // moment the server sent a real party it turned into your id.
  //
  // The live player directory is the client's answer to an id everywhere else,
  // and it self heals: a `player_info` arriving after the party message fills
  // the name in rather than freezing whatever was known at the time.
  const nameFor = useMemo(() => {
    const byId = new Map(social.players.map((player) => [player.id, player.login]));
    // `||`, not `??`: an empty login is as useless as a missing one, and the
    // adapter's "Player 123456" is the last thing to fall back to, not the
    // first.
    return (member: PartyMember) =>
      byId.get(member.playerId)
      || (member.playerId === playerId ? playerName : "")
      || member.name;
  }, [social.players, playerId, playerName]);

  // The picture the directory knows for that same id, when it has one.
  const avatarFor = useMemo(() => {
    const byId = new Map(social.players.map((player) => [player.id, player]));
    return (member: PartyMember) => byId.get(member.playerId);
  }, [social.players]);

  const members = useMemo(() => party.members.length > 0
    ? party.members
    : playerId === null ? [] : [{ playerId, name: playerName, factions: [] }],
  [party.members, playerId, playerName]);
  const memberIds = useMemo(() => new Set(members.map((member) => member.playerId)), [members]);

  // One placeholder, not one per free seat. Three identical empty tiles beside a
  // solo player padded the row out to a width that suggested the party was
  // mostly missing rather than simply not started; the count in the heading
  // already says how many seats are open. It disappears at capacity, where
  // there is nothing left to invite into.
  const canInvite = members.length < PARTY_CAPACITY;

  return (
    <section className="matchmaker-card surface-panel party-strip">
      <div className="party-strip-head">
        <div>
          <span className="matchmaker-kicker">{t("lobby.party.yours")}</span>
          <h2>{members.length || 1} of {PARTY_CAPACITY} players</h2>
        </div>
        <div className="party-strip-actions">
          {searching && isParty && (
            <span className="party-strip-locked" title={t("lobby.party.lockedWhileSearching")}>
              <Icon name="lock" size={13} />
              {t("lobby.party.lockedWhileSearching")}
            </span>
          )}
          {isParty && !canManageParty && (
            <span className="party-strip-note">
              {t("lobby.party.leaderOnly")}
            </span>
          )}
          {/* No invite button here any more: the placeholder seat below is the
              same action, in the place the eye already goes. */}
          {isParty && !canManageParty && (
            <Button disabled={searching} onClick={() => ipc.send({ kind: "Lobby", command: { type: "leaveParty" } })}>
              {t("lobby.party.leave")}
            </Button>
          )}
        </div>
      </div>

      <div className="party-seats">
        {members.map((member) => {
          const leader = member.playerId === party.ownerId || (!isParty && member.playerId === playerId);
          return (
            <div className="party-seat" key={member.playerId}>
              <ProfileAvatar
                name={nameFor(member)}
                avatarUrl={avatarFor(member)?.avatarUrl}
                tooltip={avatarFor(member)?.avatarTooltip}
              />
              <span className="party-seat-text">
                <strong><PlayerName name={nameFor(member)} />{member.playerId === playerId ? t("lobby.party.youSuffix") : ""}</strong>
                <small>{leader ? t("lobby.party.leader") : member.factions.length > 0 ? member.factions.join(", ") : t("lobby.party.randomFaction")}</small>
              </span>
              {canManageParty && member.playerId !== playerId ? (
                <button
                  type="button"
                  className="party-seat-kick"
                  disabled={searching}
                  title={searching ? t("lobby.party.lockedWhileSearching") : `Remove ${nameFor(member)}`}
                  aria-label={`Remove ${nameFor(member)}`}
                  onClick={() => ipc.send({ kind: "Lobby", command: { type: "kickPartyMember", payload: { playerId: member.playerId } } })}
                >
                  <Icon name="close" size={15} />
                </button>
              ) : null}
            </div>
          );
        })}
        {canInvite && (
          <button
            type="button"
            className="party-seat party-seat-invite"
            disabled={!canManageParty || searching}
            onClick={() => setInviteOpen(true)}
            title={searching ? t("lobby.party.lockedWhileSearching") : !canManageParty ? t("lobby.party.leaderOnly") : undefined}
          >
            <span className="party-seat-slot"><Icon name="plus" size={15} /></span>
            <span className="party-seat-text"><small>{t("lobby.party.invitePlayer")}</small></span>
          </button>
        )}
      </div>

      {inviteOpen && <InvitePlayerModal social={social} selfId={playerId} partyMemberIds={memberIds} onClose={() => setInviteOpen(false)} />}
    </section>
  );
});

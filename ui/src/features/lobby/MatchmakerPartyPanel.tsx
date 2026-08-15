import { useMemo, useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { Modal } from "../../design-system/Modal";
import { ipc } from "../../ipc/client";
import type { PartyState, PlayerProfile, SocialState } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";
import { PlayerName } from "../../shared/nameColors";

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
              <span className="profile-avatar" aria-hidden>{player.login.charAt(0).toUpperCase()}</span>
              <span><strong>{player.login}</strong><small>{isFriend ? t("lobby.party.friend") : player.clan ? `[${player.clan}]` : t("lobby.party.player")}</small></span>
              <Button disabled={wasInvited} onClick={() => invite(player)}>{t(wasInvited ? "lobby.party.invited" : "lobby.party.invite")}</Button>
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

export function MatchmakerPartyPanel({ party, social, playerId, playerName, searching }: Props) {
  const { t } = useTranslation();
  const [inviteOpen, setInviteOpen] = useState(false);
  const isParty = party.members.length > 1;
  const canManageParty = playerId !== null && (party.ownerId === null || playerId === party.ownerId);
  const members = useMemo(() => party.members.length > 0
    ? party.members
    : playerId === null ? [] : [{ playerId, name: playerName, factions: [] }],
  [party.members, playerId, playerName]);
  const memberIds = useMemo(() => new Set(members.map((member) => member.playerId)), [members]);

  // Free slots are drawn rather than implied. A solo player's "1 / 4" is
  // otherwise a number with no affordance, and the empty seats are what make
  // the invite button look like the next step.
  const freeSlots = Math.max(0, PARTY_CAPACITY - members.length);

  return (
    <section className="matchmaker-card surface-panel party-strip">
      <div className="party-strip-head">
        <div>
          <span className="matchmaker-kicker">{t("lobby.party.yours")}</span>
          <h2>{members.length || 1} of {PARTY_CAPACITY} players</h2>
        </div>
        <div className="party-strip-actions">
          <Button disabled={!canManageParty || searching} onClick={() => setInviteOpen(true)}>
            <Icon name="plus" size={15} /> {t("lobby.party.invitePlayer")}
          </Button>
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
              <span className="profile-avatar" aria-hidden>{member.name.charAt(0).toUpperCase()}</span>
              <span className="party-seat-text">
                <strong><PlayerName name={member.name} />{member.playerId === playerId ? t("lobby.party.youSuffix") : ""}</strong>
                <small>{leader ? t("lobby.party.leader") : member.factions.length > 0 ? member.factions.join(", ") : t("lobby.party.randomFaction")}</small>
              </span>
              {canManageParty && member.playerId !== playerId ? (
                <button type="button" className="party-seat-kick" title={`Remove ${member.name}`} aria-label={`Remove ${member.name}`} onClick={() => ipc.send({ kind: "Lobby", command: { type: "kickPartyMember", payload: { playerId: member.playerId } } })}>
                  <Icon name="close" size={15} />
                </button>
              ) : null}
            </div>
          );
        })}
        {Array.from({ length: freeSlots }, (_, index) => (
          <div className="party-seat party-seat-empty" key={`empty-${index}`} aria-hidden>
            <span className="party-seat-slot" />
            <span className="party-seat-text"><small>{t("lobby.party.openSlot")}</small></span>
          </div>
        ))}
      </div>

      {!canManageParty && <p className="party-panel-note">{t("lobby.party.leaderOnly")}</p>}
      {searching && <p className="party-panel-note">{t("lobby.party.lockedWhileSearching")}</p>}

      {inviteOpen && <InvitePlayerModal social={social} selfId={playerId} partyMemberIds={memberIds} onClose={() => setInviteOpen(false)} />}
    </section>
  );
}

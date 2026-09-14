import { useMemo, useState, memo } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { Modal } from "../../design-system/Modal";
import { ipc } from "../../ipc/client";
import type { PartyMember, PartyState, PlayerLeaguePlacement, PlayerProfile, SocialState } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";
import { PlayerName } from "../../shared/nameColors";
import { ProfileAvatar } from "../../shared/ProfileAvatar";
import { FactionIcon } from "../../shared/FactionIcon";
import { factionIdFromName } from "../../shared/factions";
import { UNLISTED_DIVISION_IMAGE } from "./MatchmakerPlayerCard";

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

/**
 * What a seat queues as, as the game's own emblems.
 *
 * It was the four words, comma separated, which is both the longest thing a
 * 190px seat has to hold and the hardest to read at a glance: "uef, aeon,
 * cybran, seraphim" wrapped onto a second line and then clipped, so the seat
 * showed "uef, aeon, cybran," and a cut off word. The picker above already
 * answers the same question with glyphs, for the reason `team_matchmaking.fxml`
 * does: four names is a reading task, four emblems is a glance.
 *
 * The words stay as the hover text and as each glyph's accessible name, so
 * nothing is lost to somebody who needs them. A faction this client does not
 * know keeps its word rather than being dropped: the list comes off the wire.
 */
function PartyFactions({ factions }: { factions: string[] }) {
  const { t } = useTranslation();
  const ids = new Set(
    factions
      .map(factionIdFromName)
      .filter((id): id is number => id !== null && id >= 1 && id <= 4),
  );
  const isAllOrRandom =
    factions.length === 0
    || ids.size === 4
    || factions.some((f) => f.trim().toLocaleLowerCase() === "random");

  if (isAllOrRandom) {
    // All 4 factions or no choice recorded is the server's way of saying
    // "any of them", which is the mark this client already uses for Random.
    return (
      <span className="party-seat-factions" title={t("lobby.party.randomFaction")}>
        <FactionIcon faction={5} size={14} />
      </span>
    );
  }
  return (
    <span className="party-seat-factions" title={factions.join(", ")}>
      {factions.map((faction) => {
        const id = factionIdFromName(faction);
        return id === null ? (
          <small key={faction}>{faction}</small>
        ) : (
          <FactionIcon key={faction} faction={id} size={14} />
        );
      })}
    </span>
  );
}

/**
 * A seat's league emblem, on the right where the eye lands after the name.
 *
 * Java's `matchmaking_member_card.fxml` shows the same picture for the same
 * reason: who you are queueing with is mostly a question of how good they are,
 * and the division answers it in one glyph where a rating needs reading.
 *
 * Three states, from the backend's map: not looked up yet renders nothing
 * (Java hides `leagueImageView` until the entry arrives); looked up and empty
 * is the unlisted badge the player's own card uses; otherwise the highest
 * active placement, which the list keeps first.
 */
function PartyLeague({ placements }: { placements: PlayerLeaguePlacement[] | undefined }) {
  const { t } = useTranslation();
  const placement = placements?.[0] ?? null;
  const label = placement?.division || t("lobby.matchmaker.unplaced");
  return (
    <span className="party-seat-league" role="img" title={label} aria-label={label}>
      <img
        src={placement?.imageUrl || UNLISTED_DIVISION_IMAGE}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={(event) => { event.currentTarget.src = UNLISTED_DIVISION_IMAGE; }}
      />
    </span>
  );
}

interface Props {
  party: PartyState;
  social: SocialState;
  /** Active league placements by player id, from `playerCard.partyPlacements`. */
  placements: { [key in number]: PlayerLeaguePlacement[] };
  playerId: number | null;
  playerName: string;
  searching: boolean;
  selectedFactions?: string[];
}

/**
 * Memoised: the panel above holds a one second clock for the queue countdowns,
 * and a party does not change on that tick.
 */
export const MatchmakerPartyPanel = memo(function MatchmakerPartyPanel({
  party,
  social,
  placements,
  playerId,
  playerName,
  searching,
  selectedFactions,
}: Props) {
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
    : playerId === null ? [] : [{ playerId, name: playerName, factions: selectedFactions ?? [] }],
  [party.members, playerId, playerName, selectedFactions]);
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
          <h2>{t("lobby.party.ofPlayers", { count: members.length || 1, max: PARTY_CAPACITY })}</h2>
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
          const avatar = avatarFor(member);
          const kickable = canManageParty && member.playerId !== playerId;
          const factions = member.playerId === playerId && selectedFactions !== undefined
            ? selectedFactions
            : member.factions;
          return (
            <div className={`party-seat${kickable ? " has-kick" : ""}`} key={member.playerId}>
              <PartyLeague placements={placements[member.playerId]} />
              <span className="party-seat-text">
                <span className="party-seat-name-row">
                  <strong><PlayerName name={nameFor(member)} /></strong>
                  {leader && (
                    <span
                      className="party-seat-leader"
                      role="img"
                      title={t("lobby.party.leader")}
                      aria-label={t("lobby.party.leader")}
                    >
                      <Icon name="crown" size={13} />
                    </span>
                  )}
                </span>
                <span className="party-seat-meta">
                  <PartyFactions factions={factions} />
                </span>
              </span>
              {avatar?.avatarUrl && (
                <img
                  className="party-seat-avatar"
                  src={avatar.avatarUrl}
                  alt=""
                  title={avatar.avatarTooltip || undefined}
                  loading="lazy"
                  decoding="async"
                  draggable={false}
                />
              )}
              {kickable ? (
                <button
                  type="button"
                  className="party-seat-kick"
                  disabled={searching}
                  title={searching ? t("lobby.party.lockedWhileSearching") : `Remove ${nameFor(member)}`}
                  aria-label={`Remove ${nameFor(member)}`}
                  onClick={() => ipc.send({ kind: "Lobby", command: { type: "kickPartyMember", payload: { playerId: member.playerId } } })}
                >
                  <Icon name="close" size={13} />
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

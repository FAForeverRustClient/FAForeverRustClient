import { useEffect, useMemo, useState, memo } from "react";
import { Button } from "../../../design-system/Button";
import { Icon } from "../../../design-system/Icon";
import { Modal } from "../../../design-system/Modal";
import { RangeSlider } from "../../../design-system/RangeSlider";
import { SearchField, SearchPanel } from "../../../design-system/SearchPanel";
import { ipc } from "../../../ipc/client";
import type { PartyMember, PartyState, PlayerLeaguePlacement, PlayerProfile, SocialState } from "../../../ipc/bindings";
import { formatNumber } from "../../../i18n";
import { useTranslation } from "../../../i18n/useTranslation";
import { PlayerName } from "../../../shared/components/nameColors";
import { ProfileAvatar } from "../../../shared/components/ProfileAvatar";
import { FactionIcon } from "../../../shared/components/FactionIcon";
import { flagSrc } from "../../../shared/countryFlags";
import { useCountryLabel } from "../../../shared/hooks/useCountryLabel";
import { usePlayerMenu } from "../../../shared/hooks/usePlayerMenu";
import { placementLabel } from "../../../shared/leagueNames";
import { factionIdFromName, factionLabelFromName, orderFactionNames } from "../../../shared/factions";
import { UNLISTED_DIVISION_IMAGE } from "./MatchmakerPlayerCard";
// The friend tag is the Play tab's own, styled there.
import "../browser/custom-games.css";

interface InviteModalProps {
  social: SocialState;
  selfId: number | null;
  partyMemberIds: Set<number>;
  onClose: () => void;
}

type QueueRating = "1v1" | "2v2" | "3v3" | "4v4";
type InviteSort = "friend" | "name" | "clan" | QueueRating;
type RatingRange = { low: number | null; high: number | null };

const QUEUE_RATINGS: QueueRating[] = ["1v1", "2v2", "3v3", "4v4"];
const RATING_MIN = -1000;
const RATING_MAX = 4000;

const RATING_BOARDS: Record<QueueRating, string[]> = {
  "1v1": ["ladder_1v1", "ladder1v1"],
  "2v2": ["tmm_2v2", "tmm2v2", "ladder2v2"],
  "3v3": ["tmm_3v3", "tmm3v3", "ladder3v3"],
  "4v4": ["tmm_4v4", "tmm4v4", "tmm_4v4_full_share", "ladder4v4", "4v4_full_share"],
};

/** A matchmaker rating only; global deliberately has no place in this dialog. */
export function inviteQueueRating(player: PlayerProfile, queue: QueueRating): number | null {
  const boards = RATING_BOARDS[queue];
  return player.ratings.find((rating) => boards.includes(rating.leaderboard))?.rating ?? null;
}

function InvitePlayerModal({ social, selfId, partyMemberIds, onClose }: InviteModalProps) {
  const { t } = useTranslation();
  const countryOf = useCountryLabel();
  const { openPlayerMenu, playerMenu, playerMenuTarget } = usePlayerMenu();
  const [query, setQuery] = useState("");
  const [invited, setInvited] = useState<Set<number>>(() => new Set());
  const [sortBy, setSortBy] = useState<InviteSort>("friend");
  const [sortDescending, setSortDescending] = useState(true);
  const [country, setCountry] = useState("*");
  const [clan, setClan] = useState("*");
  const [friendsOnly, setFriendsOnly] = useState(false);
  const [ratingRanges, setRatingRanges] = useState<Record<QueueRating, RatingRange>>(() => ({
    "1v1": { low: null, high: null },
    "2v2": { low: null, high: null },
    "3v3": { low: null, high: null },
    "4v4": { low: null, high: null },
  }));
  const [appliedRatingRanges, setAppliedRatingRanges] = useState(ratingRanges);

  // Small debounce for rating range updates
  useEffect(() => {
    const timeout = window.setTimeout(() => setAppliedRatingRanges(ratingRanges), 500);
    return () => window.clearTimeout(timeout);
  }, [ratingRanges]);

  const friendNames = useMemo(() => new Set(social.friends.map((name) => name.toLocaleLowerCase())), [social.friends]);
  const countries = useMemo(() => {
    const codes = [...new Set(social.players.map((player) => player.country.trim().toLocaleLowerCase()).filter(Boolean))];
    return codes.sort((left, right) => countryOf(left).localeCompare(countryOf(right)));
  }, [countryOf, social.players]);
  const clans = useMemo(() => [...new Set(social.players.map((player) => player.clan.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" })), [social.players]);
  const candidates = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return social.players
      .filter((player) => player.id !== selfId && !partyMemberIds.has(player.id))
      .filter((player) => !normalized || player.login.toLocaleLowerCase().includes(normalized))
      .filter((player) => country === "*" || player.country.toLocaleLowerCase() === country)
      .filter((player) => clan === "*" || (clan === "" ? !player.clan : player.clan === clan))
      .filter((player) => !friendsOnly || friendNames.has(player.login.toLocaleLowerCase()))
      .filter((player) => QUEUE_RATINGS.every((queue) => {
        const range = appliedRatingRanges[queue];
        if (range.low === null && range.high === null) return true;
        const rating = inviteQueueRating(player, queue);
        return rating !== null
          && (range.low === null || rating >= range.low)
          && (range.high === null || rating <= range.high);
      }))
      .sort((left, right) => {
        let comparison = 0;
        if (sortBy === "friend") {
          comparison = Number(friendNames.has(left.login.toLocaleLowerCase()))
            - Number(friendNames.has(right.login.toLocaleLowerCase()));
        } else if (sortBy === "name") {
          comparison = left.login.localeCompare(right.login, undefined, { sensitivity: "base" });
        } else if (sortBy === "clan") {
          if (!left.clan || !right.clan) {
            comparison = left.clan ? -1 : right.clan ? 1 : 0;
            return comparison || left.login.localeCompare(right.login);
          }
          comparison = left.clan.localeCompare(right.clan, undefined, { sensitivity: "base" });
        } else {
          const leftRating = inviteQueueRating(left, sortBy);
          const rightRating = inviteQueueRating(right, sortBy);
          if (leftRating === null || rightRating === null) {
            comparison = leftRating === null ? (rightRating === null ? 0 : 1) : -1;
            return comparison || left.login.localeCompare(right.login);
          }
          comparison = leftRating - rightRating;
        }
        return (sortDescending ? -comparison : comparison)
          || left.login.localeCompare(right.login, undefined, { sensitivity: "base" });
      });
  }, [appliedRatingRanges, clan, country, friendNames, friendsOnly, partyMemberIds, query, selfId, social.players, sortBy, sortDescending]);

  const sortDirectionLabel = sortBy === "friend"
    ? t(sortDescending ? "lobby.party.invite.sort.friendsFirst" : "lobby.party.invite.sort.friendsLast")
    : t(sortDescending ? "lobby.party.invite.sort.descending" : "lobby.party.invite.sort.ascending");

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
    <>
      <Modal onClose={onClose} className="matchmaker-invite-modal">
        <div className="play-dialog-head">
          <div><h2>{t("lobby.party.invite.title")}</h2><p>{t("lobby.party.invite.subtitle")}</p></div>
        </div>
        <SearchPanel
          className="matchmaker-invite-filters"
          onSubmit={(event) => event.preventDefault()}
          advanced={(
            <div className="search-panel-advanced">
              <div className="search-panel-advanced-sliders matchmaker-invite-rating-filters">
                {QUEUE_RATINGS.map((queue) => (
                  <RangeSlider
                    key={queue}
                    label={t("lobby.party.invite.rating", { queue })}
                    min={RATING_MIN}
                    max={RATING_MAX}
                    step={50}
                    low={ratingRanges[queue].low}
                    high={ratingRanges[queue].high}
                    format={formatNumber}
                    onChange={(low, high) => setRatingRanges((current) => ({ ...current, [queue]: { low, high } }))}
                  />
                ))}
              </div>
            </div>
          )}
        >
          <SearchField label={t("lobby.party.invite.placeholder")} className="search-panel-field-grow matchmaker-invite-search">
            <input
              autoFocus
              className="search-panel-control"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("lobby.party.invite.placeholder")}
            />
          </SearchField>
          <div className="search-panel-field search-panel-field-compact matchmaker-invite-sort">
            <span className="search-panel-label">{t("lobby.party.invite.sort.label")}</span>
            <span>
              <select className="search-panel-control" aria-label={t("lobby.party.invite.sort.label")} value={sortBy} onChange={(event) => setSortBy(event.target.value as InviteSort)}>
                <option value="friend">{t("lobby.party.invite.sort.friend")}</option>
                <option value="name">{t("lobby.party.invite.sort.name")}</option>
                <option value="clan">{t("lobby.party.invite.sort.clan")}</option>
                {QUEUE_RATINGS.map((queue) => <option key={queue} value={queue}>{queue}</option>)}
              </select>
              <button
                type="button"
                className="search-panel-control matchmaker-invite-sort-direction"
                aria-label={sortDirectionLabel}
                title={sortDirectionLabel}
                onClick={() => setSortDescending((current) => !current)}
              >
                {sortDescending ? "↓" : "↑"}
              </button>
            </span>
          </div>
          <SearchField label={t("lobby.party.invite.country")} className="search-panel-field-compact">
            <select className="search-panel-control" value={country} onChange={(event) => setCountry(event.target.value)}>
              <option value="*">{t("common.any")}</option>
              {countries.map((code) => <option key={code} value={code}>{countryOf(code)}</option>)}
            </select>
          </SearchField>
          <SearchField label={t("lobby.party.invite.clan")} className="search-panel-field-compact">
            <select className="search-panel-control" value={clan} onChange={(event) => setClan(event.target.value)}>
              <option value="*">{t("common.any")}</option>
              <option value="">{t("lobby.party.invite.clanNone")}</option>
              {clans.map((tag) => <option key={tag} value={tag}>[{tag}]</option>)}
            </select>
          </SearchField>
          <SearchField label={t("lobby.party.invite.relation")} className="search-panel-field-compact">
            <select className="search-panel-control" value={friendsOnly ? "friends" : "all"} onChange={(event) => setFriendsOnly(event.target.value === "friends")}>
              <option value="all">{t("lobby.party.invite.allPlayers")}</option>
              <option value="friends">{t("lobby.party.invite.friendsOnly")}</option>
            </select>
          </SearchField>
        </SearchPanel>
        <div className="matchmaker-invite-list surface">
          {candidates.length === 0 ? <p className="play-empty">{t("lobby.party.invite.empty")}</p> : candidates.map((player) => {
            const wasInvited = invited.has(player.id);
            const isFriend = friendNames.has(player.login.toLocaleLowerCase());
            // Every queue in every row, so the columns line up down the list;
            // one the player has no rating in reads as a dash.
            const queueRatings = QUEUE_RATINGS.map((queue) => {
              const rating = inviteQueueRating(player, queue);
              // The directory reports a zero for players with no 1v1 entry;
              // it is an absence marker, not a rating to show in the row.
              return [queue, rating === 0 && queue === "1v1" ? null : rating] as const;
            });
            return (
              <div className={`matchmaker-invite-row${isFriend ? " is-friend" : ""}`} key={player.id}>
                {/* Avatar, flag, then the name with its clan in front, all on
                    the avatar's 20px line. */}
                <ProfileAvatar name={player.login} avatarUrl={player.avatarUrl} tooltip={player.avatarTooltip} />
                {player.country ? (
                  <img
                    className="matchmaker-invite-flag"
                    src={flagSrc(player.country)}
                    alt={countryOf(player.country)}
                    title={countryOf(player.country)}
                    width={16}
                    height={16}
                  />
                ) : (
                  <span className="matchmaker-invite-flag" aria-hidden />
                )}
                <span className="matchmaker-invite-name">
                  {player.clan && <span className="matchmaker-invite-clan">[{player.clan}]</span>}
                  <button
                    type="button"
                    className={`matchmaker-invite-name-button${playerMenuTarget === player.login ? " is-menu-open" : ""}`}
                    aria-haspopup="menu"
                    aria-expanded={playerMenuTarget === player.login}
                    onClick={(event) => openPlayerMenu(player.login, event)}
                    onContextMenu={(event) => openPlayerMenu(player.login, event)}
                  >
                    <strong>{player.login}</strong>
                  </button>
                  {/* The Play tab's friend tag, as a game row carries it. */}
                  {isFriend && (
                    <span className="game-browser-tags matchmaker-invite-tags">
                      <i className="friend">{t("lobby.party.friend")}</i>
                    </span>
                  )}
                </span>
                {/* Queue and rating as the Training tab states them: the queue
                    as a label over its number. */}
                <dl className="matchmaker-invite-ratings">
                  {queueRatings.map(([queue, rating]) => (
                    <div key={queue}>
                      <dt>{queue}</dt>
                      <dd className={rating === null ? "is-unknown" : undefined}>
                        {rating === null ? "–" : formatNumber(rating)}
                      </dd>
                    </div>
                  ))}
                </dl>
                <Button onClick={() => invite(player)}>{t(wasInvited ? "lobby.party.inviteAgain" : "lobby.party.invite")}</Button>
              </div>
            );
          })}
        </div>
      </Modal>
      {playerMenu}
    </>
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
 *
 * All four picked used to collapse into the Random mark, on the grounds that
 * "any of them" is what it means. It is not what it says. The party is at most
 * four seats and four emblems fit on one line of one, so a seat whose player
 * ticked every faction now shows every faction, and the Random mark is kept
 * for the two cases that really are one: a seat that recorded no choice at
 * all, and a server that answered the word "random".
 */
function PartyFactions({ factions }: { factions: string[] }) {
  const { t } = useTranslation();
  const isRandom =
    factions.length === 0
    || factions.some((faction) => faction.trim().toLocaleLowerCase() === "random");

  if (isRandom) {
    return (
      <span className="party-seat-factions" title={t("lobby.party.randomFaction")}>
        <FactionIcon faction={5} size={14} />
      </span>
    );
  }
  // Sorted rather than taken as it arrived: the wire order is the order the
  // player happened to click the toggles in, so the same three factions drew a
  // different row for each member of the party.
  const ordered = orderFactionNames(factions);
  return (
    <span className="party-seat-factions" title={ordered.map(factionLabelFromName).join(", ")}>
      {ordered.map((faction) => {
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
  const label = placementLabel(placement) ?? t("lobby.matchmaker.unplaced");
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
          {/* Everybody in a party can leave it, the leader included. The button
              used to be hidden from whoever led, on the reasoning that the
              leader manages the party rather than belonging to it. They belong
              to it: a leader who wanted out had to kick every other seat one at
              a time, and the report was simply that pressing Leave did not work
              -- there was nothing to press. The server reassigns or dissolves
              the party by itself, the way it does when the leader disconnects. */}
          {isParty && (
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
            // The leader's seat is outlined rather than badged: a crown after
            // the name competed with it for width, one floating above the
            // seat looked detached, and a label read as clutter.
            <div
              className={`party-seat${kickable ? " has-kick" : ""}${leader ? " is-leader" : ""}`}
              key={member.playerId}
              title={leader ? t("lobby.party.leader") : undefined}
            >
              <PartyLeague placements={placements[member.playerId]} />
              <span className="party-seat-text">
                <span className="party-seat-name-row">
                  <strong><PlayerName name={nameFor(member)} /></strong>
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
                  title={searching ? t("lobby.party.lockedWhileSearching") : t("lobby.party.removeMember", { name: nameFor(member) })}
                  aria-label={t("lobby.party.removeMember", { name: nameFor(member) })}
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

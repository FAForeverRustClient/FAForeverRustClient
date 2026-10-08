import { useEffect, useLayoutEffect, useMemo, useRef, useState, memo, type CSSProperties, type RefObject } from "react";
import { Button } from "../../../design-system/Button";
import { Icon } from "../../../design-system/Icon";
import { Modal } from "../../../design-system/Modal";
import { RangeSlider } from "../../../design-system/RangeSlider";
import { ResizeHandle } from "../../../design-system/ResizeHandle";
import { SearchField, SearchPanel, SearchPanelToggle } from "../../../design-system/SearchPanel";
import { ipc } from "../../../ipc/client";
import type {
  BrowsingPreferences,
  PartyMember,
  PartyState,
  PlayerLeaguePlacement,
  PlayerProfile,
  SocialState,
} from "../../../ipc/bindings";
import { formatNumber } from "../../../i18n";
import { useTranslation } from "../../../i18n/useTranslation";
import { PlayerName } from "../../../shared/components/nameColors";
import { ProfileAvatar } from "../../../shared/components/ProfileAvatar";
import { FactionIcon } from "../../../shared/components/FactionIcon";
import { flagSrc } from "../../../shared/countryFlags";
import { useCountryLabel } from "../../../shared/hooks/useCountryLabel";
import { useColumnOrder } from "../../../shared/hooks/useColumnOrder";
import { useAppStore } from "../../../store/store";
import { usePlayerMenu } from "../../../shared/hooks/usePlayerMenu";
import { placementLabel } from "../../../shared/leagueNames";
import { factionIdFromName, factionLabelFromName, orderFactionNames } from "../../../shared/factions";
import { UNLISTED_DIVISION_IMAGE } from "./MatchmakerPlayerCard";
import { isFilterRecord, useRememberedFilter } from "../../../shared/filterMemory";

interface InviteModalProps {
  social: SocialState;
  selfId: number | null;
  partyMemberIds: Set<number>;
  onClose: () => void;
}

type QueueRating = "1v1" | "2v2" | "3v3" | "4v4";
/** What a header sorts by. `null` is the order the dialog opens in: friends first, then by name. */
type InviteSort = "name" | QueueRating;
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

/**
 * The invite list's movable columns, in designed order: the player and the
 * four queue ratings.
 *
 * Around them, outside the movable ones: the block that says who the player
 * is at a glance (avatar, flag and clan) at the start, and the invite button
 * at the end. The block and the player have widths; the four ratings have
 * none, so they share what is left of the row equally and stand at even
 * distances between the names and the button, each centred in its share.
 */
const INVITE_COLUMN_COUNT = 5;
const PLAYER_COLUMN = 0;
/** What each designed column sorts by. */
const INVITE_COLUMN_SORTS: InviteSort[] = ["name", "1v1", "2v2", "3v3", "4v4"];
/**
 * The three widths, as stored: the identity block, the player, the invite
 * button's track. The block is a 40px avatar, a 16px flag and a clan tag with
 * their gaps and the cell's padding; 200px holds a long FAF login. The track:
 * see `ACTION_DEFAULT_PX` and `useInviteButtonFit`.
 */
const IDENTITY_WIDTH = 0;
const PLAYER_WIDTH = 1;
const ACTION_WIDTH = 2;
const INVITE_WIDTH_COUNT = 3;
const IDENTITY_DEFAULT_PX = 128;
const PLAYER_DEFAULT_PX = 200;
/** The narrowest the block and the player may be dragged to: the block keeps avatar and flag whole. */
const IDENTITY_FLOOR_PX = 96;
const PLAYER_FLOOR_PX = 80;
/** The narrowest a rating's share may become while a divider is dragged. */
const RATING_FLOOR_PX = 56;
/**
 * The button's track by default. Wider than the button, so the ratings' even
 * shares end well before it: with a 200px player column holding mostly much
 * shorter names, that is what puts the ratings in the middle between the
 * names and the button, as the dialog was signed off with. Also room for the
 * longest "Invite again" in any catalogue before the button has been measured.
 */
const ACTION_DEFAULT_PX = 160;
/** The button cell's padding after the button; it has none before it. */
const CELL_PADDING_PX = 8;

/**
 * The stored widths, or the defaults for anything not saved by this layout.
 * The dialog's earlier layouts stored two, five, six or nine widths; read by
 * position they made the rows wider than the dialog.
 */
function resolveInviteWidths(
  stored: readonly number[] | undefined,
  defaults: readonly number[],
  floors: readonly number[],
): number[] {
  if (!stored || stored.length !== INVITE_WIDTH_COUNT) return [...defaults];
  return stored.map((width, index) =>
    width > 0 ? Math.max(floors[index], Math.round(width)) : defaults[index],
  );
}

function saveInviteColumns(patch: Partial<Pick<BrowsingPreferences, "matchmakerInviteColumns" | "matchmakerInviteOrder">>) {
  ipc.send({ kind: "Settings", command: { type: "patchBrowsing", payload: { patch } } });
}

/**
 * How wide the invite button's track has to be: the button at its widest, as
 * "Invite again" in the reader's language, and the cell's padding after it. Measured
 * off a hidden copy of that button, because the label's length is the
 * catalogue's and the font's, not a number this file can know. It is the
 * track's floor, so a drag never cuts the label off, and its default where it
 * is wider than `ACTION_DEFAULT_PX`.
 */
function useInviteButtonFit(label: string) {
  const probe = useRef<HTMLSpanElement | null>(null);
  const [fit, setFit] = useState<number | null>(null);
  // Again whenever the label changes, as it does with the language.
  useLayoutEffect(() => {
    const width = probe.current?.getBoundingClientRect().width;
    if (width) setFit(Math.ceil(width) + CELL_PADDING_PX);
  }, [label]);
  return { probe, fit };
}

/**
 * The invite list's three widths, and what its three dividers do to them.
 *
 * Not the shared `useListColumns`: every divider there trades width between
 * the two columns either side of it, and neither the identity block nor the
 * button's track is a column of its. Here a divider resizes the block, the
 * player or the track alone, and the ratings give or take the difference
 * between them, staying evenly spaced. They give no more than leaves each its
 * floor, so the rows never grow wider than the list.
 */
function useInviteColumnWidths(headerRef: RefObject<HTMLTableRowElement | null>, buttonFit: number | null) {
  const stored = useAppStore((state) => state.state.settings.browsing.matchmakerInviteColumns);
  const defaults = [IDENTITY_DEFAULT_PX, PLAYER_DEFAULT_PX, Math.max(ACTION_DEFAULT_PX, buttonFit ?? 0)];
  const floors = [IDENTITY_FLOOR_PX, PLAYER_FLOOR_PX, buttonFit ?? ACTION_DEFAULT_PX];
  // Local while a divider is held and until the saved widths come back, as in
  // `useColumnWidths`: dropped at release, the old widths flashed back first.
  const [dragged, setDragged] = useState<number[] | null>(null);
  const storedKey = (stored ?? []).join(",");
  useEffect(() => setDragged(null), [storedKey]);
  const widths = dragged ?? resolveInviteWidths(stored, defaults, floors);
  // What the drag started from, the ratings' spare room at that moment, and
  // where it has got to. A ref, because a keyboard nudge starts, moves and
  // ends in one handler, before any state set in between has rendered.
  const drag = useRef<{ origin: number[]; room: number; latest: number[] | null } | null>(null);

  const start = () => {
    const ratings = headerRef.current?.querySelectorAll<HTMLElement>("[data-rating]") ?? [];
    const room = [...ratings].reduce(
      (sum, cell) => sum + Math.max(0, cell.getBoundingClientRect().width - RATING_FLOOR_PX),
      0,
    );
    drag.current = { origin: widths, room, latest: null };
    return drag.current;
  };
  return {
    widths,
    onStart: () => {
      start();
    },
    /** `index` alone, growing by `delta`, the ratings making up the difference. */
    resize: (index: number, delta: number) => {
      const session = drag.current ?? start();
      const { origin, room } = session;
      const next = [...origin];
      next[index] = Math.max(
        floors[index],
        Math.min(origin[index] + room, origin[index] + Math.round(delta)),
      );
      session.latest = next;
      setDragged(next);
    },
    onEnd: () => {
      const latest = drag.current?.latest;
      drag.current = null;
      if (latest) saveInviteColumns({ matchmakerInviteColumns: latest });
    },
    clear: () => {
      drag.current = null;
      setDragged(null);
    },
  };
}

/** The direction a header sorts in on its first click: names A to Z, ratings high to low. */
function firstDirection(sort: InviteSort): "ascending" | "descending" {
  return QUEUE_RATINGS.includes(sort as QueueRating) ? "descending" : "ascending";
}

function InvitePlayerModal({ social, selfId, partyMemberIds, onClose }: InviteModalProps) {
  const { t } = useTranslation();
  const countryOf = useCountryLabel();
  const { openPlayerMenu, playerMenu, playerMenuTarget } = usePlayerMenu();
  // The search and the filters are remembered as the filter setting says
  // (#447); the sort is not a filter.
  const isText = (value: unknown) => typeof value === "string";
  const [query, setQuery] = useRememberedFilter("invite.search", "", isText);
  const [invited, setInvited] = useState<Set<number>>(() => new Set());
  const [sort, setSort] = useState<{ key: InviteSort; direction: "ascending" | "descending" } | null>(null);
  const [country, setCountry] = useRememberedFilter("invite.country", "*", isText);
  const [clan, setClan] = useRememberedFilter("invite.clan", "*", isText);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [ratingRanges, setRatingRanges] = useRememberedFilter<Record<QueueRating, RatingRange>>(
    "invite.ratings",
    () => ({
      "1v1": { low: null, high: null },
      "2v2": { low: null, high: null },
      "3v3": { low: null, high: null },
      "4v4": { low: null, high: null },
    }),
    (value) => isFilterRecord(value) && QUEUE_RATINGS.every((queue) => isFilterRecord(value[queue])),
  );
  const [appliedRatingRanges, setAppliedRatingRanges] = useState(ratingRanges);

  // The order as every list view has it (`useColumnOrder`), the widths the
  // dialog's own way: see `useInviteColumnWidths`. Stored on their own, so a
  // drag here moves no other list.
  const headerRef = useRef<HTMLTableRowElement | null>(null);
  const headRef = useRef<HTMLDivElement | null>(null);
  const storedOrder = useAppStore((state) => state.state.settings.browsing.matchmakerInviteOrder);
  const columnOrder = useColumnOrder(
    storedOrder,
    INVITE_COLUMN_COUNT,
    (next) => saveInviteColumns({ matchmakerInviteOrder: next }),
    headerRef,
  );
  const { order, moving } = columnOrder;
  const button = useInviteButtonFit(t("lobby.party.inviteAgain"));
  const columns = useInviteColumnWidths(headerRef, button.fit);
  /** Designed widths and designed order again, in one settings write. */
  const resetColumns = () => {
    columns.clear();
    columnOrder.clear();
    saveInviteColumns({ matchmakerInviteColumns: [], matchmakerInviteOrder: [] });
  };

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
    const isFriend = (player: PlayerProfile) => friendNames.has(player.login.toLocaleLowerCase());
    return social.players
      .filter((player) => player.id !== selfId && !partyMemberIds.has(player.id))
      .filter((player) => !normalized || player.login.toLocaleLowerCase().includes(normalized))
      .filter((player) => country === "*" || player.country.toLocaleLowerCase() === country)
      .filter((player) => clan === "*" || (clan === "" ? !player.clan : player.clan === clan))
      .filter((player) => QUEUE_RATINGS.every((queue) => {
        const range = appliedRatingRanges[queue];
        if (range.low === null && range.high === null) return true;
        const rating = inviteQueueRating(player, queue);
        return rating !== null
          && (range.low === null || rating >= range.low)
          && (range.high === null || rating <= range.high);
      }))
      .sort((left, right) => {
        const byName = left.login.localeCompare(right.login, undefined, { sensitivity: "base" });
        // Unsorted, as the dialog opens: friends first, then by name.
        if (sort === null) return Number(isFriend(right)) - Number(isFriend(left)) || byName;
        let comparison = 0;
        if (sort.key === "name") {
          comparison = byName;
        } else {
          const leftRating = inviteQueueRating(left, sort.key);
          const rightRating = inviteQueueRating(right, sort.key);
          if (leftRating === null || rightRating === null) {
            return (leftRating === null ? (rightRating === null ? 0 : 1) : -1) || byName;
          }
          comparison = leftRating - rightRating;
        }
        return (sort.direction === "descending" ? -comparison : comparison) || byName;
      });
  }, [appliedRatingRanges, clan, country, friendNames, partyMemberIds, query, selfId, social.players, sort]);

  /**
   * A header click: the column's first direction, then the other, then back to
   * the order the dialog opened in, which is the only way back to friends
   * first now that there is no sort dropdown.
   */
  const onSort = (key: InviteSort) => setSort((current) => {
    if (current?.key !== key) return { key, direction: firstDirection(key) };
    if (current.direction === firstDirection(key)) {
      return { key, direction: current.direction === "ascending" ? "descending" : "ascending" };
    }
    return null;
  });

  const activeRatingFilters = QUEUE_RATINGS.filter(
    (queue) => ratingRanges[queue].low !== null || ratingRanges[queue].high !== null,
  ).length;

  // Sending again is allowed, and has to be: an invitation is a notification the
  // other side can dismiss, miss, or let expire, and the only recourse is to
  // send another one. The button used to disable itself on the first click,
  // which left the inviter watching a greyed out "Invited" with nothing to do
  // but close the dialog and reopen it.
  const invite = (player: PlayerProfile) => {
    ipc.send({ kind: "Lobby", command: { type: "inviteToParty", payload: { playerId: player.id } } });
    setInvited((current) => new Set(current).add(player.id));
  };

  const columnLabels = [t("lobby.party.player"), "1v1", "2v2", "3v3", "4v4"];
  // The fixed block has no title on screen, so a screen reader is told what it holds.
  const identityLabel = [
    t("lobby.party.invite.avatar"),
    t("lobby.party.invite.country"),
    t("lobby.party.invite.clan"),
  ].join(", ");
  const moveHint = t("lobby.browser.moveColumn");
  /**
   * A divider, at the leading edge of the header cell that holds it. Two of
   * them: at the identity block's end it resizes the block, at the player's
   * end the player. The ratings take up the difference and stay evenly
   * spaced, which is also why there is none between two ratings. `label`
   * names the column that grows as it is dragged right.
   */
  const divider = (label: string, onDrag: (delta: number) => void) => (
    <ResizeHandle
      className="matchmaker-invite-col-handle is-ruled"
      label={t("lobby.browser.resizeColumn", { column: label })}
      onStart={columns.onStart}
      onDrag={onDrag}
      onEnd={columns.onEnd}
      onReset={resetColumns}
    />
  );
  /** One header cell, for the designed column `column` drawn at `position`. */
  const headerCell = (column: number, position: number) => {
    const key = INVITE_COLUMN_SORTS[column];
    const isRating = column !== PLAYER_COLUMN;
    const cellProps = {
      ...columnOrder.cell(column),
      "data-column": column,
      "data-rating": isRating || undefined,
      title: moveHint,
      className: [isRating ? "matchmaker-invite-rating" : "", moving === column ? "is-moving" : ""]
        .filter(Boolean)
        .join(" ") || undefined,
    };
    const handle = position === 0
      ? divider(identityLabel, (delta) => columns.resize(IDENTITY_WIDTH, delta))
      : order[position - 1] === PLAYER_COLUMN
        ? divider(columnLabels[PLAYER_COLUMN], (delta) => columns.resize(PLAYER_WIDTH, delta))
        : null;
    const active = sort?.key === key;
    return (
      <th key={column} {...cellProps} aria-sort={active ? sort.direction : "none"}>
        {handle}
        <button type="button" onClick={() => onSort(key)}>
          {columnLabels[column]}
          <span aria-hidden="true">{active ? (sort.direction === "ascending" ? "↑" : "↓") : "↕"}</span>
        </button>
      </th>
    );
  };

  // The header's table and the rows' table are laid out on these same columns.
  // The ratings' have no width, so they share what the others leave equally.
  const colgroup = (
    <colgroup>
      <col key="identity" style={{ width: `${columns.widths[IDENTITY_WIDTH]}px` }} />
      {order.map((column) =>
        column === PLAYER_COLUMN
          ? <col key={column} style={{ width: `${columns.widths[PLAYER_WIDTH]}px` }} />
          : <col key={column} />,
      )}
      <col key="action" style={{ width: `${columns.widths[ACTION_WIDTH]}px` }} />
    </colgroup>
  );

  return (
    <>
      <Modal onClose={onClose} className="matchmaker-invite-modal">
        <div className="play-dialog-head">
          <div><h2>{t("lobby.party.invite.title")}</h2></div>
        </div>
        <SearchPanel
          className="matchmaker-invite-filters"
          onSubmit={(event) => event.preventDefault()}
          advanced={filtersOpen ? (
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
          ) : undefined}
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
          {/* The rating sliders open from here, as every search panel's
              further filters do, with the number of them in use. */}
          <SearchPanelToggle
            expanded={filtersOpen}
            count={activeRatingFilters}
            onClick={() => setFiltersOpen((open) => !open)}
          />
        </SearchPanel>
        {/* The header is a table of its own above the scrolling one, both on
            the same columns, so the titles stay put and the scrollbar runs
            beside the players only. Both boxes keep the scrollbar's room, so
            the two tables are equally wide whether the list overflows or not. */}
        {/* Every invite button as wide as the widest, "Invite again", so a row
            whose button says "Invite" starts it on the divider just the same,
            and sending an invitation moves nothing. */}
        <div
          className="matchmaker-invite-list surface"
          style={button.fit === null
            ? undefined
            : ({ "--matchmaker-invite-button": `${button.fit - CELL_PADDING_PX}px` } as CSSProperties)}
        >
          <div className="matchmaker-invite-head" ref={headRef}>
            <table className="matchmaker-invite-table">
              {colgroup}
              <thead>
                {/* The list's own cells in the stored order; each says which
                    column it is, which is how a drag finds them. The block in
                    front and the button's track are no columns of the list:
                    no title, nothing to drag or sort. */}
                <tr className={`list-head${moving !== null ? " is-moving" : ""}`} ref={headerRef}>
                  <th aria-label={identityLabel} />
                  {order.map((column, position) => headerCell(column, position))}
                  {/* The button's track: no title, but a divider at its start,
                      and the hidden copy of the widest button it measures. */}
                  <th aria-label={t("lobby.party.invite")}>
                    {divider(t("lobby.party.invite"), (delta) => columns.resize(ACTION_WIDTH, -delta))}
                    <span ref={button.probe} className="matchmaker-invite-probe" aria-hidden="true">
                      <Button variant="primary" tabIndex={-1}>{t("lobby.party.inviteAgain")}</Button>
                    </span>
                  </th>
                </tr>
              </thead>
            </table>
          </div>
          {/* A list too wide for a narrow window scrolls sideways here, and
              the header is moved along with it. */}
          <div
            className="matchmaker-invite-scroll"
            onScroll={(event) => {
              if (headRef.current) headRef.current.scrollLeft = event.currentTarget.scrollLeft;
            }}
          >
            <table className="matchmaker-invite-table">
              {colgroup}
              <tbody>
                {candidates.length === 0 ? (
                  <tr>
                    <td colSpan={INVITE_COLUMN_COUNT + 2} className="play-empty">{t("lobby.party.invite.empty")}</td>
                  </tr>
                ) : candidates.map((player) => {
                  const wasInvited = invited.has(player.id);
                  const isFriend = friendNames.has(player.login.toLocaleLowerCase());
                  // In designed order here, drawn in the stored one.
                  const cells = [
                    <td key={0}>
                      {/* A friend's name is written in the friend colour. */}
                      <button
                        type="button"
                        className={`matchmaker-invite-name-button${playerMenuTarget === player.login ? " is-menu-open" : ""}`}
                        aria-haspopup="menu"
                        aria-expanded={playerMenuTarget === player.login}
                        title={isFriend ? t("lobby.party.friend") : undefined}
                        onClick={(event) => openPlayerMenu(player.login, event)}
                        onContextMenu={(event) => openPlayerMenu(player.login, event)}
                      >
                        <strong>{player.login}</strong>
                      </button>
                    </td>,
                    ...QUEUE_RATINGS.map((queue, index) => {
                      const rating = inviteQueueRating(player, queue);
                      // The directory reports a zero for players with no 1v1
                      // entry; it is an absence marker, not a rating to show.
                      const shown = rating === 0 && queue === "1v1" ? null : rating;
                      return (
                        <td key={1 + index} className={`matchmaker-invite-rating${shown === null ? " is-unknown" : ""}`}>
                          {shown === null ? "–" : formatNumber(shown)}
                        </td>
                      );
                    }),
                  ];
                  return (
                    <tr className={`matchmaker-invite-row${isFriend ? " is-friend" : ""}`} key={player.id}>
                      {/* Who the player is at a glance, as one block in front of
                          the list's columns: the avatar (its slot kept, empty,
                          when there is none), the flag and the clan. */}
                      <td>
                        <span className="matchmaker-invite-identity">
                          {player.avatarUrl ? (
                            <ProfileAvatar name={player.login} avatarUrl={player.avatarUrl} tooltip={player.avatarTooltip} />
                          ) : (
                            <span className="matchmaker-invite-avatar-empty" aria-hidden />
                          )}
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
                          <span className="matchmaker-invite-clan">{player.clan ? `[${player.clan}]` : ""}</span>
                        </span>
                      </td>
                      {order.map((column) => cells[column])}
                      <td className="matchmaker-invite-action">
                        <Button variant="primary" onClick={() => invite(player)}>
                          {t(wasInvited ? "lobby.party.inviteAgain" : "lobby.party.invite")}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
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

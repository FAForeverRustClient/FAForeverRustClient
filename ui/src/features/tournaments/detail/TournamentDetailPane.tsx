// One tournament, in sections.
//
// The order is the order a player needs them: what this is, what the rules say,
// who else is in, where the bracket stands, what people are saying. Manage is
// last because it is the organiser's, and only they are shown it.
//
// Entering is the primary action and sits in the header, not in a section. It
// is the one thing a player opens this tab to do.

import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "../../../design-system/Button";
import { Icon } from "../../../design-system/Icon";
import { Modal } from "../../../design-system/Modal";
import type {
  DescImageAnswer,
  AccountSearch,
  Article,
  ChatPost,
  ChatRoom,
  MapListStatus,
  PlayerSummary,
  RatingCheck,
  EntrantRatings,
  RenameCheck,
  Tourney,
  TourneyLoadStatus,
  TourneyMatch,
  TourneySeries,
  VaultMap,
} from "../../../ipc/bindings";
import type { MessageKey } from "../../../i18n";
import { useTranslation } from "../../../i18n/useTranslation";
import { AuditLogPanel } from "./AuditLogPanel";
import type { SitePage } from "../site/sitePages";
import { PublishBanner } from "./PublishBanner";
import { DisplaySettingsDialog } from "./DisplaySettingsDialog";
import { PinButton, PinnedChat } from "./PinnedChat";
import { swissShowsBracket } from "../bracket/swissPresentation";
import {
  hotkeyAction,
  isMasked,
  loadHotkeys,
  saveHotkeys,
  TourneyDisplayContext,
  useRevealed,
  useStoredFlag,
  type TourneyDisplay,
} from "../display";
import { StatsPanel } from "./StatsPanel";
import { RichLine } from "../RichLine";
import type { MapImport } from "../manage/MapImportDialog";
import { statusPill, turnInfo } from "../orientation";
import { EntryNotices } from "./EntryNotices";
import { TournamentHero } from "./TournamentHero";
import { EventToolsSlot } from "./eventToolsSlot";
import "../../../design-system/section-tabs.css";
import { BracketView } from "../bracket/BracketView";
import { ChatPanel } from "./ChatPanel";
import { DraftPanel } from "../bracket/DraftPanel";
import { EntrantsPanel } from "./EntrantsPanel";
import { TeamsPanel } from "./TeamsPanel";
import { ManagePanel } from "../manage/ManagePanel";
import { NewsPanel } from "./NewsPanel";
import { OverviewPanel } from "./OverviewPanel";
import { StandingsPanel } from "../bracket/StandingsPanel";
import type { ChatActions, TourneyActions } from "../tourneyActions";
import { myVetoSteps, vetoSettled } from "../bracket/vetoPresentation";
import { MapsPanel } from "./MapsPanel";
import { listedMatches, MatchesPanel } from "./MatchesPanel";
import { vetoMatches, VetoesPanel } from "./VetoesPanel";
import { ChatRoomView } from "./ChatRoomView";
import { MatchChatContext, matchRoomId, type MatchChatApi } from "../bracket/matchChat";
import { matchLabel } from "../bracket/matchLabels";
import { teamNameOf } from "../bracket/matchParts";
import {
  mayCheckIn,
  mayPublish,
  maySignUp,
  mayUndoCheckIn,
  selfOrganised,
  unreadNews,
  unreadTotal,
} from "../../../shared/rules/tourneyRules";

type Section =
  | "overview"
  | "news"
  | "players"
  | "teams"
  | "draft"
  | "bracket"
  | "matches"
  | "stats"
  | "vetoes"
  | "maps"
  | "standings"
  | "chat"
  | "manage"
  | "log";

const SECTION_LABELS: Record<Section, MessageKey> = {
  overview: "tournaments.section.overview",
  news: "tournaments.section.news",
  players: "tournaments.section.players",
  teams: "tournaments.section.teams",
  draft: "tournaments.section.draft",
  bracket: "tournaments.section.bracket",
  matches: "tournaments.section.matches",
  stats: "tournaments.section.stats",
  vetoes: "tournaments.section.vetoes",
  maps: "tournaments.section.maps",
  standings: "tournaments.section.standings",
  chat: "tournaments.section.chat",
  manage: "tournaments.section.manage",
  log: "tournaments.section.log",
};

/**
 * A section's name for this event.
 *
 * Swiss and free-for-all events have rounds, not a bracket: nothing is knocked
 * out along a tree, everyone plays the next round against a new opponent. The
 * website calls the section Rounds for both, and so does the stage stepper
 * there (issue 367).
 */
function sectionLabel(section: Section, event: Tourney): MessageKey {
  if (
    section === "bracket" &&
    (event.competition === "freeForAll" || (event.bracketKind === "swiss" && !swissShowsBracket(event)))
  ) {
    return "tournaments.section.rounds";
  }
  return SECTION_LABELS[section];
}

interface TournamentDetailPaneProps {
  event: Tourney;
  /** Every command the sections can send, grouped by what it acts on. */
  actions: TourneyActions;
  /** The last picture pasted into the event's text and stored. */
  pastedImage?: DescImageAnswer | null;
  /** This account is a site admin with its powers on. */
  siteAdmin?: boolean;
  /** Open one of the site's pages, from the Overview's links. */
  onOpenPage?: (page: SitePage) => void;
  onOpenUrl: (url: string) => void;
  /**
   * A section to open, from outside: the pending bar's "Go". The nonce makes
   * a second request for the same section open it again.
   */
  jump?: { section: string; nonce: number } | null;
  detailLoading: boolean;
  /** Every series, for the organiser's picker. Loaded when Manage is opened. */
  series: TourneySeries[];
  /** The list behind this detail, as candidates for a qualifier link. */
  events: Tourney[];
  profiles: PlayerSummary[];
  articles: Article[];
  /** Where the tournament service lives, for its own image paths. */
  assetBase: string;
  vault: VaultMap[];
  vaultStatus: MapListStatus;
  chatRooms: ChatRoom[];
  openRoomId: string | null;
  chatPosts: ChatPost[];
  chatStatus: TourneyLoadStatus;
  /** The room pinned beside the sections, and its posts. */
  pinnedRoomId: string | null;
  pinnedPosts: ChatPost[];
  busy: boolean;
  busyMatchId: string | null;
  /** The organiser's name-search state, forwarded to the entrant pickers. */
  accountSearch: AccountSearch;
  /** The organiser's last check of entrant names against FAF. */
  renames: RenameCheck | null;
  renamesStatus: TourneyLoadStatus;
  /** This account's last rating check. */
  ratingCheck: RatingCheck | null;
  ratingCheckStatus: TourneyLoadStatus;
  /** One entrant's every rating, for the organiser. */
  playerRatings: EntrantRatings | null;
  playerRatingsStatus: TourneyLoadStatus;
  /** Importing maps from another event, for Manage. */
  mapImport: MapImport;
}

export function TournamentDetailPane(props: TournamentDetailPaneProps) {
  const { t } = useTranslation();
  const { busy, actions } = props;
  const [section, setSection] = useState<Section>("overview");

  // The website's three display switches, kept on this machine and never sent.
  const [playerView, setPlayerView] = useStoredFlag("faf_player_view");
  const [showPlayers, setShowPlayers] = useStoredFlag("faf_show_players");
  const [streamer, setStreamer] = useStoredFlag("faf_streamer_mode");
  const [revealed, toggleReveal] = useRevealed(props.event.id);
  const [hotkeys, setHotkeys] = useState(loadHotkeys);
  const [displaySettings, setDisplaySettings] = useState(false);
  const toolsSlot = useContext(EventToolsSlot);
  const rights = props.event.viewer.organiser;
  // View as player: the event as a player sees it, organiser tools and all,
  // on this screen only. The service still sends what it sends, and the
  // switch stays, so the way back is where it was.
  const event = useMemo(
    () =>
      playerView && rights
        ? { ...props.event, viewer: { ...props.event.viewer, organiser: false } }
        : props.event,
    [playerView, rights, props.event],
  );
  // Memoised, as the match chat below is: every section that reads either
  // context is redrawn whenever its value is a new object, memoised or not.
  const display = useMemo<TourneyDisplay>(
    () => ({
      showPlayers,
      streamer,
      masked: (entry) => isMasked(streamer, revealed, entry),
      toggleReveal,
    }),
    [showPlayers, streamer, revealed, toggleReveal],
  );
  const root = useRef<HTMLDivElement>(null);

  // The pinned room lets go of itself once its match is over, and says so:
  // a finished match's chat is read in the Chat tab, not kept beside it.
  const pinnedRoom = props.chatRooms.find((room) => room.id === props.pinnedRoomId);
  const [pinNotice, setPinNotice] = useState(false);
  const pinnedDone = pinnedRoom?.done === true;
  useEffect(() => {
    if (!pinnedDone) return;
    actions.chat.pin(null);
    setPinNotice(true);
    // Only the room finishing lets go of it, not a new set of commands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinnedDone]);

  // A caster opening a running event gets streamer mode once, so the first
  // look on stream does not give the results away. Once per tournament; the
  // switch is theirs afterwards.
  useEffect(() => {
    if (!props.event.viewer.caster || props.event.status !== "running") return;
    const key = `faf_sm_auto_${props.event.id}`;
    try {
      if (window.localStorage.getItem(key) !== null) return;
      window.localStorage.setItem(key, "1");
    } catch {
      return;
    }
    setStreamer(true);
  }, [props.event.id, props.event.status, props.event.viewer.caster, setStreamer]);

  // The shortcuts. Not while typing, not with a modifier, not over a dialog,
  // and only while this pane is on screen: the client keeps other tabs mounted.
  useEffect(() => {
    const listen = (pressed: KeyboardEvent) => {
      if (pressed.ctrlKey || pressed.metaKey || pressed.altKey || pressed.repeat) return;
      const target = pressed.target as HTMLElement | null;
      if (target !== null && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) {
        return;
      }
      if (document.querySelector(".modal-backdrop") !== null) return;
      if (root.current === null || root.current.offsetParent === null) return;
      const action = hotkeyAction(hotkeys, pressed.key);
      if (action === "players") setShowPlayers(!showPlayers);
      else if (action === "streamer") setStreamer(!streamer);
      else if (action === "playerView" && rights) setPlayerView(!playerView);
    };
    window.addEventListener("keydown", listen);
    return () => window.removeEventListener("keydown", listen);
  }, [hotkeys, showPlayers, streamer, playerView, rights, setShowPlayers, setStreamer, setPlayerView]);

  /** A switch's tooltip, with its shortcut where one is bound. */
  const toggleTitle = (base: MessageKey, key: string, tail: MessageKey) =>
    [t(base), key === "" ? "" : t("tournaments.display.shortcut", { key: key.toUpperCase() }), t(tail)]
      .filter((part) => part !== "")
      .join(" ");

  // Twins of `may_sign_up` and `may_withdraw`, the first in shared/rules where
  // the conformance harness pins it.
  const mayEnter = maySignUp(event);
  const mayWithdraw = event.viewer.signedUpPlayerId !== null && event.status === "signup";
  // Check-in is for a full team of self-made teams, during signups and on or
  // after the day it opens: it decides who is dropped when the field is
  // locked. It used to be offered only after the lock, which is exactly when
  // the service refuses it.
  const offerCheckIn = mayCheckIn(event, Math.floor(Date.now() / 1000));
  const offerUndoCheckIn = mayUndoCheckIn(event);

  // The rooms carry the exact counts once loaded; until then the detail's own
  // total says whether there is anything to read at all.
  const unread = props.chatRooms.length > 0 ? unreadTotal(props.chatRooms) : event.myUnreadCount;
  const now = Math.floor(Date.now() / 1000);
  const pill = statusPill(event, now);
  const turn = turnInfo(event, t);
  const openVetoes = vetoMatches(event).filter((entry) => !vetoSettled(event, entry)).length;
  const owedVetoes = event.matches.reduce((total, entry) => total + myVetoSteps(event, entry), 0);

  /*
   * FAF's whole map catalogue, asked for by the sections that draw a preview
   * rather than when the tab mounts. It is the largest thing the client holds:
   * twenty thousand maps, measured at about twelve megabytes of heap, and a
   * player who came to look at a bracket was paying for all of it.
   *
   * An effect rather than the click handler, which is where this started and was
   * wrong: a section can be open without having been clicked. Switching from one
   * tournament to another while standing on Manage left every map without a
   * preview, and so did anything that re-mounted the pane.
   */
  // Manage only. The rounds used to ask for it too, for the veto previews, and
  // a player opening a match's vetoes waited on the whole catalogue before a
  // single picture appeared; those pictures are the organiser's own uploads
  // now, which the website shows too.
  const needsVault = section === "manage";
  useEffect(() => {
    if (needsVault) actions.maps.needVault();
    // Asked again for a new event, and not for a new set of commands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsVault, event.id]);

  useEffect(() => {
    if (props.jump == null) return;
    const wanted = props.jump.section as Section;
    if (wanted in SECTION_LABELS) openSection(wanted);
    // Only a new jump opens a section; everything else the reader chose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.jump?.nonce]);

  const openSection = (next: Section) => {
    setSection(next);
    // The rooms are loaded on demand rather than with the detail: chat is
    // beside the bracket, not the point of it, and a tab nobody opens should
    // not cost a request per tournament.
    if (next === "chat" && props.chatRooms.length === 0) actions.chat.load();
    // The series list is a second endpoint, and most visits never open Manage.
    if (next === "manage" && props.series.length === 0) actions.series.load();

    // Opening the announcements is what reading them means. The service keeps
    // the mark, so the badge clears on every device rather than once here.
    if (next === "news" && unreadNews(event) > 0) actions.news.markRead();
  };

  // A link that names what it points at: open the section, then, once it has
  // drawn, bring that element into view and flash it for two seconds. The
  // website's `data-focus`, with its 60 ms wait for the new tab to render. A
  // target the section does not draw (the rating check outside signups) just
  // leaves the reader on the section.
  const openAndFocus = (next: Section, focus?: string) => {
    openSection(next);
    if (focus === undefined) return;
    window.setTimeout(() => {
      const node = document.getElementById(focus);
      if (node === null) return;
      node.scrollIntoView({ behavior: "smooth", block: "center" });
      node.classList.add("is-focus-flash");
      window.setTimeout(() => node.classList.remove("is-focus-flash"), 2000);
    }, 60);
  };

  // The match whose chat is open in the popup, if any. The room itself is the
  // tab's one open room, so the popup and the Chat tab never disagree about it.
  const [matchChat, setMatchChat] = useState<TourneyMatch | null>(null);
  const { chatRooms } = props;
  const chatApi = useMemo<MatchChatApi>(
    () => ({
      open: (entry) => {
        // The room list carries the unread counts; load it if the Chat tab
        // never has.
        if (chatRooms.length === 0) actions.chat.load();
        setMatchChat(entry);
        actions.chat.openRoom(matchRoomId(entry));
      },
      unread: (entry) => chatRooms.find((room) => room.id === matchRoomId(entry))?.unread ?? 0,
    }),
    [chatRooms, actions.chat],
  );

  // The Chat tab's own pin, which also takes back the notice that the last
  // pinned room let go of itself.
  const tabChat = useMemo<ChatActions>(
    () => ({
      ...actions.chat,
      pin: (roomId) => {
        setPinNotice(false);
        actions.chat.pin(roomId);
      },
    }),
    [actions.chat],
  );

  return (
    <MatchChatContext.Provider value={chatApi}>
    <TourneyDisplayContext.Provider value={display}>
    <div className="surface tournament-detail" ref={root}>
      {/* The display switches, at the end of the site's tab row. */}
      {toolsSlot !== null &&
        createPortal(
          <div className="tournament-display-toggles">
            <span className="tournament-toggle-group" role="group" aria-label={t("tournaments.display.title")}>
              {rights && (
                <button
                  type="button"
                  className={playerView ? "tournament-toggle is-on" : "tournament-toggle"}
                  aria-pressed={playerView}
                  title={toggleTitle("tournaments.display.playerViewHint", hotkeys.playerView, "tournaments.display.playerViewTail")}
                  onClick={() => setPlayerView(!playerView)}
                >
                  <span className="tournament-toggle-dot" aria-hidden /> {t("tournaments.display.playerView")}
                </button>
              )}
              <button
                type="button"
                className={showPlayers ? "tournament-toggle is-on" : "tournament-toggle"}
                aria-pressed={showPlayers}
                title={toggleTitle("tournaments.display.showPlayersHint", hotkeys.players, "tournaments.display.ownScreen")}
                onClick={() => setShowPlayers(!showPlayers)}
              >
                <span className="tournament-toggle-dot" aria-hidden /> {t("tournaments.display.showPlayers")}
              </button>
              <button
                type="button"
                className={streamer ? "tournament-toggle is-on" : "tournament-toggle"}
                aria-pressed={streamer}
                title={toggleTitle("tournaments.display.streamerHint", hotkeys.streamer, "tournaments.display.ownScreen")}
                onClick={() => setStreamer(!streamer)}
              >
                <span className="tournament-toggle-dot" aria-hidden /> {t("tournaments.display.streamer")}
              </button>
            </span>
            <button
              type="button"
              className="tournaments-icon-button"
              title={t("tournaments.display.title")}
              aria-label={t("tournaments.display.title")}
              onClick={() => setDisplaySettings(true)}
            >
              <Icon name="settings" size={15} />
            </button>
          </div>,
          toolsSlot,
        )}

      <TournamentHero
        event={event}
        pill={pill}
        assetBase={props.assetBase}
        actions={
          <>
            {mayEnter && (
              <Button className="tournament-hero-primary" variant="primary" onClick={actions.entry.signUp} disabled={busy}>
                <Icon name="plus" size={18} /> {t("tournaments.action.enter")}
              </Button>
            )}
            {offerCheckIn && (
              <Button className="tournament-hero-primary" variant="primary" onClick={() => actions.entry.checkIn(true)} disabled={busy}>
                <Icon name="check" size={18} /> {t("tournaments.action.checkIn")}
              </Button>
            )}
            {offerUndoCheckIn && (
              <Button onClick={() => actions.entry.checkIn(false)} disabled={busy}>
                {t("tournaments.teams.undoCheckIn")}
              </Button>
            )}
            {mayWithdraw && (
              <Button onClick={actions.entry.withdraw} disabled={busy}>
                {t("tournaments.action.withdraw")}
              </Button>
            )}
            {!event.viewer.loggedIn && (
              <span className="muted tournament-hero-note">{t("tournaments.action.signInFirst")}</span>
            )}
          </>
        }
      />

      {/* The shared section tabs' look (`section-tabs`), kept as a navigation
          of buttons: the sections are views of one event, and the tests and
          the pending bar's jumps address them as such. */}
      <nav className="section-tabs tournament-sections" aria-label={t("tournaments.section.label")}>
        {(Object.keys(SECTION_LABELS) as Section[])
          // Manage is an organiser's door out to the website; nobody else needs
          // to be told it exists. Teams only exist where there are teams to
          // form: a solo event has none until the organiser makes them.
          .filter((candidate) => candidate !== "manage" || event.viewer.organiser)
          // The log is the organiser's too, and only where the service sent
          // one: it withholds `tlog` from everyone else, so an empty section
          // would be indistinguishable from an event nothing has happened in.
          .filter(
            (candidate) =>
              candidate !== "log" || (event.viewer.organiser && event.auditLog.length > 0),
          )
          .filter(
            (candidate) =>
              candidate !== "teams" || selfOrganised(event) || event.teams.length > 0,
          )
          // The draft is a section only where there is one: a draft-formation
          // event before it starts, or one running. Everywhere else it would be
          // a tab that opens on nothing.
          .filter(
            (candidate) =>
              candidate !== "draft" ||
              event.draft !== null ||
              (event.viewer.organiser && event.formation === "draft"),
          )
          // Standings exist once there is something to stand on: a drawn
          // bracket, or an import that arrived with its own final table. Before
          // that the tab would open on "nothing yet", which is a worse answer
          // than not offering it.
          // Standings are always there, as on the website: before anything is
          // played they say when they will appear. Stats once the event is
          // over, for everyone.
          .filter((candidate) => candidate !== "stats" || event.status === "finished")
          // Matches once there is a head-to-head match to list, and Vetoes
          // while the bracket runs and some match has a run to show: the
          // website's conditions. Maps is always there, as it is on the website.
          .filter((candidate) => candidate !== "matches" || listedMatches(event).length > 0)
          .filter(
            (candidate) =>
              candidate !== "vetoes" ||
              ((event.status === "running" || event.status === "finished") &&
                vetoMatches(event).length > 0),
          )
          // News is a section only when there is news, or somebody who can
          // write it. An empty tab that nobody can fill is a dead end.
          .filter(
            (candidate) =>
              candidate !== "news" || event.news.length > 0 || event.viewer.organiser,
          )
          .map((candidate) => (
            <button
              type="button"
              key={candidate}
              className={candidate === section ? "tournament-section is-active active" : "tournament-section"}
              aria-current={candidate === section}
              onClick={() => openSection(candidate)}
            >
              <span className="section-tab-label">{t(sectionLabel(candidate, event))}</span>
              {candidate === "players" && <span className="section-tab-count">{event.playerCount}</span>}
              {/* How many announcements there are, in one chip that lights up
                  while any of them is new to this account. A second chip with
                  the unread count beside it read as "1 1". */}
              {candidate === "news" && event.news.length > 0 && (
                <span className={unreadNews(event) > 0 ? "section-tab-count is-unread" : "section-tab-count"}>
                  {event.news.length}
                </span>
              )}
              {/* Strongest first, as on the website: an organiser being asked
                  for, then a mention of this account, then anything unread. */}
              {candidate === "chat" &&
                (event.viewer.organiser && event.chatPingCount > 0 ? (
                  <span className="tournament-badge is-mention" title={t("tournaments.chat.pingsTitle")}>
                    {"\u{1F514}"}
                    {event.chatPingCount}
                  </span>
                ) : event.myMentionCount > 0 ? (
                  <span className="tournament-badge is-mention">{event.myMentionCount}</span>
                ) : (
                  unread > 0 && <span className="tournament-badge">{unread > 9 ? "9+" : unread}</span>
                ))}
              {candidate === "vetoes" && openVetoes > 0 && <span className="section-tab-count">{openVetoes}</span>}
              {/* The steps this account owes, across every match: the count
                  above is everyone's work, this one is yours. */}
              {candidate === "vetoes" && owedVetoes > 0 && (
                <span className="tournament-badge">{owedVetoes}</span>
              )}
            </button>
          ))}
      </nav>

      {mayPublish(event) && (
        <PublishBanner
          event={event}
          assetBase={props.assetBase}
          busy={busy}
          organiser={actions.organiser}
        />
      )}

      {/* The one thing waiting on this account, above whichever section is
          open: the section it points at is usually not that one. */}
      {turn !== null && (
        <div className="tournament-turn-banner" role="status">
          <span className="tournament-turn-dot" aria-hidden="true" />
          <span className="tournament-turn-text">{turn.text}</span>
          <Button variant="primary" onClick={() => openSection(turn.section)}>
            {t(turn.cta)}
          </Button>
        </div>
      )}

      {props.detailLoading && <p className="muted">{t("tournaments.detailLoading")}</p>}

      {/* Everything but the bracket reads at a measure rather than at the
          window's width. The pane is as wide as the client, which on a wide
          monitor put a label on the far left and its own control a thousand
          pixels away. The bracket is the exception because it is a *diagram*:
          it has to be able to use every pixel and scroll sideways past them. */}
      {pinNotice && (
        <p className="muted tournament-pin-notice">
          {t("tournaments.chat.pinClosedDone")}{" "}
          <button type="button" className="tournament-link-button" onClick={() => setPinNotice(false)}>
            {t("common.close")}
          </button>
        </p>
      )}
      <div
        className={[
          "tournament-body-row",
          props.pinnedRoomId !== null ? "has-pin" : "",
          // The chat takes the pane's remaining height, which the row has to
          // take first: a row sized to its content left `is-fill` nothing to
          // fill, and the log a short box over an empty pane (issue 367).
          section === "chat" ? "is-fill" : "",
        ]
          .filter((name) => name !== "")
          .join(" ")}
      >
      <div
        className={
          section === "bracket"
            ? "tournament-section-body is-wide"
            : section === "chat"
              ? "tournament-section-body is-wide is-fill"
              : "tournament-section-body"
        }
      >

      {/* A ban or an invitation to answer, over the section rather than
          under it: it is what stands between this account and entering. */}
      {(section === "overview" || section === "players") && (
        <EntryNotices
          event={event}
          busy={busy}
          entry={actions.entry}
        />
      )}

      {section === "overview" && (
        <OverviewPanel
          event={event}
          articles={props.articles}
          assetBase={props.assetBase}
          onOpenSection={openAndFocus}
          onOpenUrl={props.onOpenUrl}
          onOpenPage={props.onOpenPage}
        />
      )}

      {section === "news" && (
        <NewsPanel
          event={event}
          busy={busy}
          assetBase={props.assetBase}
          news={actions.news}
        />
      )}


      {section === "players" && (
        <EntrantsPanel
          event={event}
          profiles={props.profiles}
          ratingCheck={{
            check: props.ratingCheck,
            status: props.ratingCheckStatus,
            busy,
            onCheck: actions.entry.checkRating,
          }}
        />
      )}

      {section === "teams" && (
        <TeamsPanel
          event={event}
          profiles={props.profiles}
          busy={busy}
          teams={actions.teams}
          entry={actions.entry}
          onAdmin={actions.organiser.admin}
        />
      )}

      {/* An import of a format with no bracket (round robin, Swiss, groups)
          brought only its tables; saying so beats an empty diagram. */}
      {section === "bracket" && event.imported && event.standingsOnly && (
        <p className="muted">
          <RichLine
            text={t("tournaments.bracket.importedNoBracket", {
              type: event.importedType.trim() !== "" ? event.importedType.trim() : t("tournaments.bracket.nonBracketFormat"),
            })}
            onLink={() => openSection("standings")}
          />
        </p>
      )}

      {section === "stats" && <StatsPanel event={event} />}

      {section === "bracket" && !(event.imported && event.standingsOnly) && (
        <BracketView
          busy={busy}
          event={event}
          profiles={props.profiles}
          busyMatchId={props.busyMatchId}
          vault={props.vault}
          assetBase={props.assetBase}
          matches={actions.matches}
          onAdmin={actions.organiser.admin}
          onAssignPool={actions.maps.assignPool}
        />
      )}

      {section === "draft" && (
        <DraftPanel
          event={event}
          profiles={props.profiles}
          busy={busy}
          teams={actions.teams}
          organiser={actions.organiser}
        />
      )}

      {section === "matches" && (
        <MatchesPanel
          event={event}
          profiles={props.profiles}
          vault={props.vault}
          assetBase={props.assetBase}
          busyMatchId={props.busyMatchId}
          matches={actions.matches}
          onAdmin={actions.organiser.admin}
          onAssignPool={actions.maps.assignPool}
        />
      )}

      {section === "vetoes" && (
        <VetoesPanel
          event={event}
          profiles={props.profiles}
          vault={props.vault}
          assetBase={props.assetBase}
          busyMatchId={props.busyMatchId}
          veto={actions.matches.veto}
        />
      )}

      {section === "maps" && (
        <MapsPanel
          event={event}
          vault={props.vault}
          assetBase={props.assetBase}
          onManage={() => openSection("manage")}
        />
      )}

      {section === "standings" && (
        <StandingsPanel event={event} profiles={props.profiles} />
      )}

      {section === "chat" && (
        <ChatPanel
          event={event}
          rooms={props.chatRooms}
          openRoomId={props.openRoomId}
          posts={props.chatPosts}
          status={props.chatStatus}
          busy={busy}
          chat={tabChat}
          pinnedRoomId={props.pinnedRoomId}
        />
      )}

      {section === "log" && <AuditLogPanel event={event} />}

      {section === "manage" && (
        <ManagePanel
          siteAdmin={props.siteAdmin}
          pastedImage={props.pastedImage}
          event={event}
          vault={props.vault}
          vaultStatus={props.vaultStatus}
          assetBase={props.assetBase}
          series={props.series}
          events={props.events}
          profiles={props.profiles}
          accountSearch={props.accountSearch}
          renames={props.renames}
          renamesStatus={props.renamesStatus}
          playerRatings={props.playerRatings}
          playerRatingsStatus={props.playerRatingsStatus}
          mapImport={props.mapImport}
          busy={busy}
          onOpenUrl={props.onOpenUrl}
          organiser={actions.organiser}
          entrants={actions.entrants}
          teams={actions.teams}
          maps={actions.maps}
          seriesActions={actions.series}
          chat={actions.chat}
        />
      )}
      </div>
      {props.pinnedRoomId !== null && (
        <PinnedChat
          event={event}
          roomId={props.pinnedRoomId}
          room={pinnedRoom}
          posts={props.pinnedPosts}
          busy={busy}
          chat={actions.chat}
          onOpenInTab={() => {
            if (props.pinnedRoomId === null) return;
            openSection("chat");
            actions.chat.openRoom(props.pinnedRoomId);
          }}
          onUnpin={() => actions.chat.pin(null)}
        />
      )}
      </div>
    </div>
    {matchChat !== null && props.openRoomId === matchRoomId(matchChat) && (
      <Modal
        onClose={() => setMatchChat(null)}
        className="tournament-match-chat"
        ariaLabel={t("tournaments.chat.matchChat")}
      >
        <h3>{t("tournaments.chat.matchChat")}</h3>
        <p className="muted">
          {matchLabel(event, matchChat, t)}: {teamNameOf(event, matchChat.team1) ?? ""}{" "}
          {t("tournaments.swiss.vs")} {teamNameOf(event, matchChat.team2) ?? ""}
        </p>
        {/* Pinning from here closes the popup: the room goes on beside the
            bracket instead, which is what pinning is for. */}
        {matchChat.status !== "done" && (
          <PinButton
            roomId={matchRoomId(matchChat)}
            pinnedRoomId={props.pinnedRoomId}
            full
            onPin={(roomId) => {
              actions.chat.pin(roomId);
              if (roomId !== null) setMatchChat(null);
            }}
          />
        )}
        <ChatRoomView
          event={event}
          roomId={matchRoomId(matchChat)}
          posts={props.chatPosts}
          status={props.chatStatus}
          busy={busy}
          onPost={actions.chat.post}
          chat={actions.chat}
          compact
        />
      </Modal>
    )}
    {displaySettings && (
      <DisplaySettingsDialog
        keys={hotkeys}
        onChange={(keys) => {
          saveHotkeys(keys);
          setHotkeys(keys);
        }}
        onClose={() => setDisplaySettings(false)}
      />
    )}
    </TourneyDisplayContext.Provider>
    </MatchChatContext.Provider>
  );
}


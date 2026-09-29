// One tournament, in sections.
//
// The order is the order a player needs them: what this is, what the rules say,
// who else is in, where the bracket stands, what people are saying. Manage is
// last because it is the organiser's, and only they are shown it.
//
// Entering is the primary action and sits in the header, not in a section. It
// is the one thing a player opens this tab to do.

import { useEffect, useState } from "react";
import { Button } from "../../../design-system/Button";
import { Icon } from "../../../design-system/Icon";
import { Modal } from "../../../design-system/Modal";
import type {
  AccountSearch,
  Article,
  BracketConfig,
  ChatPost,
  ChatRoom,
  FactionVetoConfig,
  FfaReport,
  MapDraft,
  MapListStatus,
  PoolDraft,
  PlayerSummary,
  FormatDraft,
  QualifierRule,
  RatingCheck,
  EntrantRatings,
  RenameCheck,
  SeedOrder,
  TourneyPlayer,
  SeriesDraft,
  Tourney,
  TourneyAdmin,
  TourneyLoadStatus,
  TourneyDraft,
  TourneyMatch,
  TourneyPhase,
  TourneySeries,
  VaultMap,
} from "../../../ipc/bindings";
import type { MessageKey } from "../../../i18n";
import { useTranslation } from "../../../i18n/useTranslation";
import { AuditLogPanel } from "./AuditLogPanel";
import { PublishBanner } from "./PublishBanner";
import { StatsPanel } from "./StatsPanel";
import { RichLine } from "../RichLine";
import type { MapImport } from "../manage/MapImportDialog";
import { eventDaysLabel, stages, statusPill, turnInfo } from "../orientation";
import { EntryNotices } from "./EntryNotices";
import { BracketView } from "../bracket/BracketView";
import { ChatPanel } from "./ChatPanel";
import { DraftPanel } from "../bracket/DraftPanel";
import { EntrantsPanel } from "./EntrantsPanel";
import { TeamsPanel } from "./TeamsPanel";
import { ManagePanel } from "../manage/ManagePanel";
import { NewsPanel } from "./NewsPanel";
import { OverviewPanel } from "./OverviewPanel";
import { StandingsPanel } from "../bracket/StandingsPanel";
import type { VetoHandlers } from "../bracket/VetoPanel";
import { myVetoSteps, vetoSettled } from "../bracket/vetoPresentation";
import { MapsPanel } from "./MapsPanel";
import { listedMatches, MatchesPanel } from "./MatchesPanel";
import { vetoMatches, VetoesPanel } from "./VetoesPanel";
import { ChatRoomView } from "./ChatRoomView";
import { MatchChatContext, matchRoomId, type MatchChatApi } from "../bracket/matchChat";
import { matchLabel } from "../bracket/matchLabels";
import { teamNameOf } from "../bracket/matchParts";
import { formatMoment, typeLine } from "../tourneyPresentation";
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
    (event.bracketKind === "swiss" || event.competition === "freeForAll")
  ) {
    return "tournaments.section.rounds";
  }
  return SECTION_LABELS[section];
}

interface TournamentDetailPaneProps {
  event: Tourney;
  detailLoading: boolean;
  /** Every series, for the organiser's picker. Loaded when Manage is opened. */
  series: TourneySeries[];
  /** The list behind this detail, as candidates for a qualifier link. */
  events: Tourney[];
  profiles: PlayerSummary[];
  articles: Article[];
  /** Where the tournament service lives, for its own image paths. */
  assetBase: string;
  /** Ask for the map vault, if it has not been loaded yet. */
  onNeedVault: () => void;
  vault: VaultMap[];
  vaultStatus: MapListStatus;
  chatRooms: ChatRoom[];
  openRoomId: string | null;
  chatPosts: ChatPost[];
  chatStatus: TourneyLoadStatus;
  busy: boolean;
  busyMatchId: string | null;
  /** The organiser's name-search state, forwarded to the entrant pickers. */
  accountSearch: AccountSearch;
  onSearchAccounts: (query: string) => void;
  /** The organiser's last check of entrant names against FAF. */
  renames: RenameCheck | null;
  renamesStatus: TourneyLoadStatus;
  onCheckRenames: () => void;
  /** This account's last rating check, and asking for one. */
  ratingCheck: RatingCheck | null;
  ratingCheckStatus: TourneyLoadStatus;
  onCheckRating: () => void;
  onDeclineInvite: () => void;
  /** One entrant's every rating, for the organiser. */
  playerRatings: EntrantRatings | null;
  playerRatingsStatus: TourneyLoadStatus;
  onLoadPlayerRatings: (playerId: string, refresh: boolean) => void;
  onBanPlayer: (player: TourneyPlayer, reason: string, expires: number | null, remove: boolean) => void;
  /** Importing maps from another event, for Manage. */
  mapImport: MapImport;
  onSignUp: () => void;
  onWithdraw: () => void;
  /** Check this account's team in, or take the check-in back. */
  onCheckIn: (checkedIn: boolean) => void;
  onReport: (entry: TourneyMatch) => void;
  onAnswer: (entry: TourneyMatch, accept: boolean) => void;
  onHost: (entry: TourneyMatch) => void;
  onOpenChat: () => void;
  onOpenRoom: (roomId: string) => void;
  onPost: (body: string, replyTo: string | null) => void;
  onAssignPool: (roundKey: string, poolId: string) => void;
  onOpenUrl: (url: string) => void;
  /** Play a FAF replay by its vault id, in the client. */
  onWatchReplay: (uid: number) => void;
  /** Save the settings, from the form Manage now shows inline. */
  onEditInfo: (draft: TourneyDraft) => void;
  onPublish: () => void;
  onAdvance: (phase: TourneyPhase, config?: BracketConfig) => void;
  onArchive: () => void;
  onCreateTeam: (name: string) => void;
  onRequestJoin: (teamId: string) => void;
  onCancelJoin: (teamId: string) => void;
  onRespondJoin: (teamId: string, playerId: string, accept: boolean) => void;
  onInvite: (teamId: string, playerId: string) => void;
  onRespondInvite: (teamId: string, accept: boolean) => void;
  onLeaveTeam: () => void;
  onDisbandTeam: (teamId: string) => void;
  onRenameTeam: (teamId: string, name: string) => void;
  onAddPlayer: (name: string, rating: number | null) => void;
  onSetCaptain: (teamId: string, playerId: string) => void;
  onMovePlayer: (playerId: string, teamId: string | null) => void;
  onEditPlayer: (playerId: string, note: string, rating: number | null) => void;
  onSetDivision: (teamId: string, division: number) => void;
  onSaveMap: (map: MapDraft) => void;
  onPublishMap: (mapId: string, published: boolean) => void;
  onDeleteMap: (mapId: string) => void;
  onSetFactionVeto: (config: FactionVetoConfig) => void;
  /** One of the organiser's single-call changes. */
  onAdmin: (change: TourneyAdmin) => void;
  onSavePool: (pool: PoolDraft) => void;
  onPublishPool: (poolId: string, published: boolean) => void;
  onDeletePool: (poolId: string) => void;
  onDeleteChatPost: (roomId: string, postId: string) => void;
  onRefreshChat: (roomId: string) => void;
  onMute: (fafId: number, name: string, muted: boolean) => void;
  onAddOrganiser: (fafId: number, name: string) => void;
  onSetOrganiserVisibility: (fafId: number, hidden: boolean) => void;
  onSetCaster: (fafId: number, name: string, casting: boolean) => void;
  onAbandon: (abandoned: boolean) => void;
  onEditFormat: (format: FormatDraft) => void;
  onEditNews: (newsId: string, body: string, important: boolean) => void;
  onMarkNewsRead: () => void;
  onLoadSeries: () => void;
  onSetSeries: (seriesId: string | null) => void;
  onSaveSeries: (draft: SeriesDraft) => void;
  onAddQualifier: (qualifierId: string, rule: QualifierRule) => void;
  onRemoveQualifier: (linkId: string) => void;
  veto: VetoHandlers;
  onReportFfa: (report: FfaReport) => void;
  onDraftPick: (playerId: string) => void;
  onDraftUndo: () => void;
  onSetCaptains: (playerIds: string[]) => void;
  onRespondSignup: (playerId: string, accept: boolean) => void;
  onRemovePlayer: (playerId: string) => void;
  onInvitePlayer: (name: string) => void;
  onUninvite: (fafId: number) => void;
  onReseed: (order: SeedOrder) => void;
  onSplitDivisions: (divisions: number) => void;
  onPostNews: (body: string, important: boolean) => void;
  onDeleteNews: (newsId: string) => void;
}

export function TournamentDetailPane(props: TournamentDetailPaneProps) {
  const { t } = useTranslation();
  const { event, busy } = props;
  const [section, setSection] = useState<Section>("overview");

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
  const days = eventDaysLabel(event.eventDays);
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
    if (needsVault) props.onNeedVault();
    // The callback is stable per render of the view above; re-running on it
    // would ask again on every keystroke anywhere in the pane.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsVault, event.id]);

  const openSection = (next: Section) => {
    setSection(next);
    // The rooms are loaded on demand rather than with the detail: chat is
    // beside the bracket, not the point of it, and a tab nobody opens should
    // not cost a request per tournament.
    if (next === "chat" && props.chatRooms.length === 0) props.onOpenChat();
    // The series list is a second endpoint, and most visits never open Manage.
    if (next === "manage" && props.series.length === 0) props.onLoadSeries();

    // Opening the announcements is what reading them means. The service keeps
    // the mark, so the badge clears on every device rather than once here.
    if (next === "news" && unreadNews(event) > 0) props.onMarkNewsRead();
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
  const chatApi: MatchChatApi = {
    open: (entry) => {
      // The room list carries the unread counts; load it if the Chat tab
      // never has.
      if (props.chatRooms.length === 0) props.onOpenChat();
      setMatchChat(entry);
      props.onOpenRoom(matchRoomId(entry));
    },
    unread: (entry) => props.chatRooms.find((room) => room.id === matchRoomId(entry))?.unread ?? 0,
  };

  return (
    <MatchChatContext.Provider value={chatApi}>
    <div className="surface tournament-detail">
      <header className="tournament-detail-header">
        <div>
          <h3>{event.name || t("tournaments.untitled")}</h3>
          {/* The website's line under the name: official or community, then
              what kind of event, then the days a multi-day event runs on. */}
          <p className="muted tournament-type-line">
            <span className={`tournament-tag is-${event.category}`}>
              {t(event.category === "official" ? "tournaments.list.official" : "tournaments.list.community")}
            </span>{" "}
            {typeLine(event, t)}
            {days !== "" && (
              <>
                {" · "}
                <span className="tournament-days" title={t("tournaments.header.daysTitle")}>
                  {days}
                </span>
              </>
            )}
          </p>
        </div>
        <div className="tournament-detail-actions">
          <span
            className={`tournament-pill is-${pill.tone}`}
            title={
              pill.tone === "presignup"
                ? t("tournaments.header.opensAt", { when: formatMoment(event.signupOpensAt, "") })
                : undefined
            }
          >
            {t(pill.label)}
          </span>
          {mayEnter && (
            <Button variant="primary" onClick={props.onSignUp} disabled={busy}>
              <Icon name="plus" size={16} /> {t("tournaments.action.enter")}
            </Button>
          )}
          {offerCheckIn && (
            <Button variant="primary" onClick={() => props.onCheckIn(true)} disabled={busy}>
              {t("tournaments.action.checkIn")}
            </Button>
          )}
          {offerUndoCheckIn && (
            <Button onClick={() => props.onCheckIn(false)} disabled={busy}>
              {t("tournaments.teams.undoCheckIn")}
            </Button>
          )}
          {mayWithdraw && (
            <Button onClick={props.onWithdraw} disabled={busy}>
              {t("tournaments.action.withdraw")}
            </Button>
          )}
          {!event.viewer.loggedIn && (
            <span className="muted">{t("tournaments.action.signInFirst")}</span>
          )}
        </div>
      </header>

      <ol className="tournament-stepper" aria-label={t("tournaments.stage.label")}>
        {stages(event).map((stage) => (
          <li
            key={stage.label}
            className={`is-${stage.state}`}
            aria-current={stage.state === "now" ? "step" : undefined}
          >
            {t(stage.label)}
          </li>
        ))}
      </ol>

      <nav className="tournament-sections" aria-label={t("tournaments.section.label")}>
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
              className={candidate === section ? "tournament-section is-active" : "tournament-section"}
              aria-current={candidate === section}
              onClick={() => openSection(candidate)}
            >
              {t(sectionLabel(candidate, event))}
              {candidate === "players" && ` (${event.playerCount})`}
              {candidate === "news" && event.news.length > 0 && ` (${event.news.length})`}
              {/* Two different counts on purpose: the news tab says how many
                  announcements there are, and the badge beside it how many are
                  new to this account. */}
              {candidate === "news" && unreadNews(event) > 0 && (
                <span className="tournament-badge">{unreadNews(event)}</span>
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
              {candidate === "vetoes" && openVetoes > 0 && ` (${openVetoes})`}
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
          onPublish={props.onPublish}
          onAdmin={props.onAdmin}
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
      <div
        className={
          section === "bracket"
            ? "tournament-section-body is-wide"
            : section === "chat"
              ? "tournament-section-body is-wide is-fill"
              : "tournament-section-body"
        }
      >

      {section === "overview" && (
        <OverviewPanel
          event={event}
          articles={props.articles}
          assetBase={props.assetBase}
          onOpenSection={openAndFocus}
          onOpenUrl={props.onOpenUrl}
        />
      )}

      {section === "news" && (
        <NewsPanel
          event={event}
          busy={busy}
          onPost={props.onPostNews}
          onEdit={props.onEditNews}
          onDelete={props.onDeleteNews}
        />
      )}


      {(section === "overview" || section === "players") && (
        <EntryNotices
          event={event}
          check={props.ratingCheck}
          checkStatus={props.ratingCheckStatus}
          busy={busy}
          onDecline={props.onDeclineInvite}
          onCheckRating={props.onCheckRating}
        />
      )}

      {section === "players" && <EntrantsPanel event={event} profiles={props.profiles} />}

      {section === "teams" && (
        <TeamsPanel
          event={event}
          profiles={props.profiles}
          busy={busy}
          onCreate={props.onCreateTeam}
          onRequestJoin={props.onRequestJoin}
          onCancelJoin={props.onCancelJoin}
          onRespondJoin={props.onRespondJoin}
          onInvite={props.onInvite}
          onRespondInvite={props.onRespondInvite}
          onLeave={props.onLeaveTeam}
          onDisband={props.onDisbandTeam}
          onRename={props.onRenameTeam}
          onCheckIn={props.onCheckIn}
          onSetCaptain={props.onSetCaptain}
          onAdmin={props.onAdmin}
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
          event={event}
          profiles={props.profiles}
          busyMatchId={props.busyMatchId}
          onReport={props.onReport}
          onAnswer={props.onAnswer}
          onHost={props.onHost}
          vault={props.vault}
          assetBase={props.assetBase}
          veto={props.veto}
          onReportFfa={props.onReportFfa}
          onAdmin={props.onAdmin}
        />
      )}

      {section === "draft" && (
        <DraftPanel
          event={event}
          profiles={props.profiles}
          busy={busy}
          onPick={props.onDraftPick}
          onUndo={props.onDraftUndo}
          onSetCaptains={props.onSetCaptains}
          onStart={() => props.onAdvance("startDraft")}
          onAdmin={props.onAdmin}
        />
      )}

      {section === "matches" && (
        <MatchesPanel
          event={event}
          profiles={props.profiles}
          vault={props.vault}
          assetBase={props.assetBase}
          busyMatchId={props.busyMatchId}
          onReport={props.onReport}
          onAnswer={props.onAnswer}
          onHost={props.onHost}
          onWatchReplay={props.onWatchReplay}
          veto={props.veto}
          onAdmin={props.onAdmin}
          onAssignPool={props.onAssignPool}
        />
      )}

      {section === "vetoes" && (
        <VetoesPanel
          event={event}
          profiles={props.profiles}
          vault={props.vault}
          assetBase={props.assetBase}
          busyMatchId={props.busyMatchId}
          veto={props.veto}
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
          onOpenRoom={props.onOpenRoom}
          onPost={props.onPost}
          onDeletePost={props.onDeleteChatPost}
          onMute={props.onMute}
          onRefresh={props.onRefreshChat}
        />
      )}

      {section === "log" && <AuditLogPanel event={event} />}

      {section === "manage" && (
        <ManagePanel
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
          onCheckRenames={props.onCheckRenames}
          playerRatings={props.playerRatings}
          playerRatingsStatus={props.playerRatingsStatus}
          onLoadPlayerRatings={props.onLoadPlayerRatings}
          onBanPlayer={props.onBanPlayer}
          mapImport={props.mapImport}
          onSearchAccounts={props.onSearchAccounts}
          busy={busy}
          onEditInfo={props.onEditInfo}
          onPublish={props.onPublish}
          onAdvance={props.onAdvance}
          onArchive={props.onArchive}
          onAssignPool={props.onAssignPool}
          onOpenUrl={props.onOpenUrl}
          onAddPlayer={props.onAddPlayer}
          onSetCaptain={props.onSetCaptain}
          onMovePlayer={props.onMovePlayer}
          onEditPlayer={props.onEditPlayer}
          onSetDivision={props.onSetDivision}
          onSaveMap={props.onSaveMap}
          onPublishMap={props.onPublishMap}
          onDeleteMap={props.onDeleteMap}
          onSetFactionVeto={props.onSetFactionVeto}
          onAdmin={props.onAdmin}
          onSavePool={props.onSavePool}
          onPublishPool={props.onPublishPool}
          onDeletePool={props.onDeletePool}
          onSetSeries={props.onSetSeries}
          onSaveSeries={props.onSaveSeries}
          onAddQualifier={props.onAddQualifier}
          onRemoveQualifier={props.onRemoveQualifier}
          onMute={props.onMute}
          onAddOrganiser={props.onAddOrganiser}
          onSetOrganiserVisibility={props.onSetOrganiserVisibility}
          onSetCaster={props.onSetCaster}
          onAbandon={props.onAbandon}
          onEditFormat={props.onEditFormat}
          onRespondSignup={props.onRespondSignup}
          onRemovePlayer={props.onRemovePlayer}
          onInvitePlayer={props.onInvitePlayer}
          onUninvite={props.onUninvite}
          onReseed={props.onReseed}
          onSplitDivisions={props.onSplitDivisions}
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
        <ChatRoomView
          event={event}
          roomId={matchRoomId(matchChat)}
          posts={props.chatPosts}
          status={props.chatStatus}
          busy={busy}
          onPost={props.onPost}
          onDeletePost={props.onDeleteChatPost}
          onMute={props.onMute}
          onRefresh={props.onRefreshChat}
          compact
        />
      </Modal>
    )}
    </MatchChatContext.Provider>
  );
}


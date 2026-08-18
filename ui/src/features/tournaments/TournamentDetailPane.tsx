// One tournament, in sections.
//
// The order is the order a player needs them: what this is, what the rules say,
// who else is in, where the bracket stands, what people are saying. Manage is
// last because it is the organiser's, and only they are shown it.
//
// Entering is the primary action and sits in the header, not in a section. It
// is the one thing a player opens this tab to do.

import { useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import type {
  AccountSearch,
  Article,
  BracketConfig,
  ChatPost,
  ChatRoom,
  FfaReport,
  MapDraft,
  MapListStatus,
  PoolDraft,
  PlayerSummary,
  FormatDraft,
  QualifierRule,
  SeedOrder,
  SeriesDraft,
  Tourney,
  TourneyLoadStatus,
  TourneyMatch,
  TourneyPhase,
  TourneySeries,
  VaultMap,
} from "../../ipc/bindings";
import type { MessageKey } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";
import { AuditLogPanel } from "./AuditLogPanel";
import { BracketView } from "./BracketView";
import { ChatPanel } from "./ChatPanel";
import { DraftPanel } from "./DraftPanel";
import { EntrantsPanel } from "./EntrantsPanel";
import { TeamsPanel } from "./TeamsPanel";
import { ManagePanel } from "./ManagePanel";
import { NewsPanel } from "./NewsPanel";
import { StandingsPanel } from "./StandingsPanel";
import { formatDay, formatMoment, formatOf, ratingGateOf } from "./tourneyPresentation";
import { selfOrganised, standingsKind, unreadNews, unreadTotal } from "../../shared/tourneyRules";

type Section =
  | "overview"
  | "news"
  | "rules"
  | "entrants"
  | "teams"
  | "draft"
  | "bracket"
  | "standings"
  | "chat"
  | "manage"
  | "log";

const SECTION_LABELS: Record<Section, MessageKey> = {
  overview: "tournaments.section.overview",
  news: "tournaments.section.news",
  rules: "tournaments.section.rules",
  entrants: "tournaments.section.entrants",
  teams: "tournaments.section.teams",
  draft: "tournaments.section.draft",
  bracket: "tournaments.section.bracket",
  standings: "tournaments.section.standings",
  chat: "tournaments.section.chat",
  manage: "tournaments.section.manage",
  log: "tournaments.section.log",
};

interface TournamentDetailPaneProps {
  event: Tourney;
  detailLoading: boolean;
  /** Every series, for the organiser's picker. Loaded when Manage is opened. */
  series: TourneySeries[];
  /** The list behind this detail, as candidates for a qualifier link. */
  events: Tourney[];
  profiles: PlayerSummary[];
  articles: Article[];
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
  onSignUp: () => void;
  onWithdraw: () => void;
  onCheckIn: () => void;
  onReport: (entry: TourneyMatch) => void;
  onAnswer: (entry: TourneyMatch, accept: boolean) => void;
  onHost: (entry: TourneyMatch) => void;
  onOpenChat: () => void;
  onOpenRoom: (roomId: string) => void;
  onPost: (body: string) => void;
  onAssignPool: (roundKey: string, poolId: string) => void;
  onOpenUrl: (url: string) => void;
  onEdit: () => void;
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
  onVetoAct: (matchId: string, mapId: string) => void;
  onVetoSetSides: (matchId: string, teamA: string) => void;
  onVetoUndo: (matchId: string) => void;
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

  // Twins of `may_sign_up` and `may_withdraw`. The rating gate and the entrant
  // cap are deliberately not checked: the server owns those and explains them
  // far better than a hidden button would.
  const maySignUp =
    event.viewer.loggedIn && event.viewer.signedUpPlayerId === null && event.status === "signup";
  const mayWithdraw = event.viewer.signedUpPlayerId !== null && event.status === "signup";
  // Check-in opens on the day of the event and needs a team, which only exists
  // once the organiser has formed them. Offering it earlier produces a refusal
  // that reads as a broken button rather than as "not yet".
  const checkInOpen =
    event.checkInOpensAt === null || event.checkInOpensAt * 1000 <= Date.now();
  const mayCheckIn =
    event.viewer.memberTeamId !== null &&
    event.status === "drafted" &&
    checkInOpen &&
    !event.teams.some((team) => team.id === event.viewer.memberTeamId && team.checkedIn);

  const unread = unreadTotal(props.chatRooms);

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

  return (
    <div className="surface tournament-detail">
      <header className="tournament-detail-header">
        <div>
          <h3>{event.name || t("tournaments.untitled")}</h3>
          <p className="muted">
            {formatOf(event)} · {t(`tournaments.bracketKind.${event.bracketKind}` as MessageKey)}
            {event.eventDate !== null && ` · ${formatMoment(event.eventDate, "")}`}
          </p>
        </div>
        <div className="tournament-detail-actions">
          {maySignUp && (
            <Button variant="primary" onClick={props.onSignUp} disabled={busy}>
              <Icon name="plus" size={16} /> {t("tournaments.action.enter")}
            </Button>
          )}
          {mayCheckIn && (
            <Button variant="primary" onClick={props.onCheckIn} disabled={busy}>
              {t("tournaments.action.checkIn")}
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
          .filter((candidate) => candidate !== "standings" || standingsKind(event) !== "none")
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
              {t(SECTION_LABELS[candidate])}
              {candidate === "entrants" && ` (${event.playerCount})`}
              {candidate === "news" && event.news.length > 0 && ` (${event.news.length})`}
              {/* Two different counts on purpose: the news tab says how many
                  announcements there are, and the badge beside it how many are
                  new to this account. */}
              {candidate === "news" && unreadNews(event) > 0 && (
                <span className="tournament-badge">{unreadNews(event)}</span>
              )}
              {candidate === "chat" && unread > 0 && (
                <span className="tournament-badge">{unread}</span>
              )}
            </button>
          ))}
      </nav>

      {props.detailLoading && <p className="muted">{t("tournaments.detailLoading")}</p>}

      {section === "overview" && <Overview event={event} />}

      {section === "news" && (
        <NewsPanel
          event={event}
          busy={busy}
          onPost={props.onPostNews}
          onEdit={props.onEditNews}
          onDelete={props.onDeleteNews}
        />
      )}

      {section === "rules" && (
        <div className="tournament-rules">
          {event.description.trim() !== "" && (
            <p className="tournament-description">{event.description}</p>
          )}
          {/* The site-wide pages, shown for an official event: they are what the
              tournament team actually maintains, and every official tournament
              points at the same text. */}
          {event.category === "official" &&
            props.articles.map((article) => (
              <section key={article.id}>
                <h5>{article.title}</h5>
                <p className="tournament-description">{article.body}</p>
              </section>
            ))}
          {event.description.trim() === "" &&
            (event.category !== "official" || props.articles.length === 0) && (
              <p className="muted">{t("tournaments.rules.none")}</p>
            )}
        </div>
      )}

      {section === "entrants" && <EntrantsPanel event={event} profiles={props.profiles} />}

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
        />
      )}

      {section === "bracket" && (
        <BracketView
          event={event}
          profiles={props.profiles}
          busyMatchId={props.busyMatchId}
          onReport={props.onReport}
          onAnswer={props.onAnswer}
          onHost={props.onHost}
          vault={props.vault}
          onVetoAct={props.onVetoAct}
          onVetoSetSides={props.onVetoSetSides}
          onVetoUndo={props.onVetoUndo}
          onReportFfa={props.onReportFfa}
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
          series={props.series}
          events={props.events}
          profiles={props.profiles}
          accountSearch={props.accountSearch}
          onSearchAccounts={props.onSearchAccounts}
          busy={busy}
          onEdit={props.onEdit}
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
  );
}

function Overview({ event }: { event: Tourney }) {
  const { t } = useTranslation();
  const gate = ratingGateOf(event, t);
  const fact = (label: MessageKey, value: string) =>
    value === "" ? null : (
      <div key={label}>
        <dt className="muted">{t(label)}</dt>
        <dd>{value}</dd>
      </div>
    );

  return (
    <>
      <dl className="tournament-facts">
        {fact("tournaments.overview.eventDate", formatMoment(event.eventDate, ""))}
        {fact("tournaments.overview.signupCloses", formatDay(event.signupClosesAt, ""))}
        {fact("tournaments.overview.checkIn", formatMoment(event.checkInDeadline, ""))}
        {fact("tournaments.overview.entrants", String(event.playerCount))}
        {fact("tournaments.overview.ratingGate", gate)}
        {fact("tournaments.overview.organisers", event.organisers.join(", "))}
        {fact(
          "tournaments.overview.reporting",
          t(
            event.playerReporting
              ? "tournaments.overview.reportingPlayers"
              : "tournaments.overview.reportingOrganiser",
          ),
        )}
      </dl>
      {event.description.trim() !== "" && (
        <p className="tournament-description">{event.description}</p>
      )}
    </>
  );
}

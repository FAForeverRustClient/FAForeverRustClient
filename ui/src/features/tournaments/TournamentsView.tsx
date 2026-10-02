// Tournaments: FAF's competitive events, from a player's side of them.
//
// Backed by `faf-tournaments`, the tournament team's own service, which
// replaced the Challonge bridge this tab first shipped against. That service
// models what Challonge could not: teams of one to six, map pools per round,
// check-in windows, rating gates, and a bracket that is an explicit graph
// rather than a set of round numbers to be inferred from.
//
// The scope is the website's own, built in lifecycle order: create an event,
// take entrants, form teams, seed, draw, record results. A participant's path
// through the same tab is the short one: see an event, enter it, check in,
// play, talk. What an organiser cannot do here yet is listed in
// `docs/tourney-features.md`, which is kept honest against `server.js`.

import { useEffect, useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import type {
  AppCommand,
  SiteWrite,
  BracketConfig,
  MatchReport,
  SeedOrder,
  Tourney,
  TourneyCommand,
  TourneyDraft,
  TourneyMatch,
  TourneyPhase,
} from "../../ipc/bindings";
import type { MessageKey } from "../../i18n";
import { ipc } from "../../ipc/client";
import { openHttpsUrl } from "../../shared/externalLinks";
import { useAppStore } from "../../store/store";
import { matchTitle } from "./matchTitle";
import { MatchReportDialog } from "./bracket/MatchReportDialog";
import { ScoreSubmitDialog } from "./bracket/ScoreSubmitDialog";
import { TournamentDetailPane } from "./detail/TournamentDetailPane";
import { TournamentForm } from "./manage/TournamentForm";
import { SignUpDialog } from "./SignUpDialog";
import { HostRequest, PendingBar, SiteNav } from "./site/SiteChrome";
import { AccessPage, FaqPage, HallOfFamePage } from "./site/SitePageViews";
import { SeriesIndex, SeriesPage } from "./site/SeriesPages";
import { ConsolePage } from "./site/ConsolePage";
import type { SitePage } from "./site/sitePages";
import {
  countdownTo,
  formatDay,
  formatPrize,
  groupOf,
  groupedEvents,
  type ListGroup,
} from "./tourneyPresentation";
import {
  archiveByYear,
  eventDayCount,
  eventDaysLabel,
  listCountdowns,
  listKind,
  listRatingLine,
  listTeamsLine,
  statusPill,
} from "./orientation";
import { busyMatchId, mayReport, openEvent, signupNeedsRating } from "../../shared/rules/tourneyRules";
import "./tournaments.css";
import { useTranslation } from "../../i18n/useTranslation";

/** Every command this tab sends is a tourney command; this is the only wrapper. */
const send = (command: TourneyCommand) =>
  ipc.send({ kind: "Tourney", command } satisfies AppCommand);

/**
 * Reload what the tab shows.
 *
 * Hosting rides along rather than being asked once at startup. It is granted
 * per account by the site admin, so it changes *while* the client runs, and a
 * refresh that left it alone meant the create button stayed missing until the
 * whole client was restarted, with no way to tell that from being refused.
 */
const load = () => {
  send({ type: "load" });
  send({ type: "loadHosting" });
};

/**
 * The three groups that are always open, in the order they are read.
 *
 * The website's order: your drafts, then what is being played right now, then
 * what is coming. Ongoing sat below Upcoming until issue 367, which put the
 * event people are following under a list of events that have not started.
 *
 * The fourth, the finished and abandoned, folds away behind a disclosure and is
 * rendered on its own below.
 */
const LIVE_GROUPS: [Exclude<ListGroup, "past">, MessageKey][] = [
  ["drafts", "tournaments.list.drafts"],
  ["ongoing", "tournaments.list.ongoing"],
  ["upcoming", "tournaments.list.upcoming"],
];

/** How many finished events a year of the archive draws before "show more". */
const ARCHIVE_PAGE = 50;

/** How often the countdowns are recomputed. Minute resolution, minute ticks. */
const TICK_MS = 60_000;

export function TournamentsView() {
  const { t } = useTranslation();
  const state = useAppStore((store) => store.state.tourney);
  const vault = useAppStore((store) => store.state.maps.vault);
  const vaultStatus = useAppStore((store) => store.state.maps.vaultStatus);
  const [reporting, setReporting] = useState<TourneyMatch | null>(null);
  const [editing, setEditing] = useState<"create" | "edit" | null>(null);
  /** The event whose signup dialog is open, if any. */
  const [entering, setEntering] = useState<string | null>(null);
  const [showPast, setShowPast] = useState(false);
  /** Which of the site's pages is showing; the list and the detail by default. */
  const [page, setPage] = useState<SitePage>({ kind: "events" });
  /** A section the pending bar asked the detail to open. */
  const [jump, setJump] = useState<{ section: string; nonce: number } | null>(null);
  /** How many of each archive year are drawn, keyed by year (0 for undated). */
  const [pastShown, setPastShown] = useState<Record<number, number>>({});
  // A countdown drawn once is wrong within the minute, and this tab is one
  // people leave open waiting for exactly the thing it counts down to.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (useAppStore.getState().state.tourney.status.type === "idle") {
      load();
      // Site-wide and cached for the session: the rules pages do not belong to
      // any one tournament, so they are fetched once rather than per event.
      send({ type: "loadArticles" });
      // Hosting is approval-only, granted per account. Asked once, because the
      // alternative is a create button that answers "not approved yet".
      send({ type: "loadHosting" });
      // This account's own Discord handle, so the signup dialog opens on what
      // the service already has rather than on an empty field that would clear
      // it if anybody pressed save.
      send({ type: "loadProfile" });
    }
  }, []);

  useEffect(() => {
    const poll = () => send({ type: "loadSite", payload: { read: "pending" } });
    poll();
    const timer = window.setInterval(poll, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const site = state.site;
  const siteWrite = (write: SiteWrite) => send({ type: "siteWrite", payload: { write } });
  /** Open a page, reading what it shows as it opens. */
  const openPage = (next: SitePage) => {
    setPage(next);
    if (next.kind === "hall") send({ type: "loadSite", payload: { read: "hallOfFame" } });
    if (next.kind === "console") send({ type: "loadSite", payload: { read: "console" } });
    if (next.kind === "faq") send({ type: "loadArticles" });
    if (next.kind === "access") {
      send({ type: "loadSite", payload: { read: { access: { kind: next.access } } } });
    }
    if (next.kind === "series") {
      send({ type: "loadSeries" });
      if (next.seriesId !== null) send({ type: "openSeries", payload: { seriesId: next.seriesId } });
      else send({ type: "closeSeries" });
    }
  };
  const openEventPage = (tournamentId: string, section?: string) => {
    setPage({ kind: "events" });
    send({ type: "select", payload: { tournamentId } });
    if (section !== undefined) setJump({ section, nonce: Date.now() });
  };

  /**
   * Ask for FAF's map catalogue, once, and only when something needs it.
   *
   * This tab does read it: the map database, the pools, the veto grids and the
   * bracket's map previews all resolve a tournament's own map names against the
   * vault, and without it an organiser sees "not in the vault" beside every one.
   *
   * It used to be asked for when the tab mounted, and that was too eager by a
   * long way. The vault is the largest thing the client holds: up to twenty
   * thousand maps, which measures at about twelve megabytes of heap and
   * seventeen as JSON, and a full state snapshot carries all of it. A player
   * opening the tab to see whether their match is up was paying that price for
   * nothing. It is now asked for by the two sections that show a preview.
   */
  const needVault = () => {
    // Idle or failed, not just idle: one lost request must not leave every map
    // in the event marked "not in the vault" for the rest of the session.
    const status = useAppStore.getState().state.maps.vaultStatus.type;
    if (status === "idle" || status === "failed") {
      ipc.send({ kind: "Maps", command: { type: "loadVault" } });
    }
  };

  // Never show one tournament's bracket under another's name: the pane waits
  // for the detail that belongs to the row that is open.
  const open = openEvent(state.detail, state.selectedId);
  const loading = state.status.type === "loading";
  const busy = state.pending !== null;
  // One match's spinner must not disable the rest of the bracket, so the
  // pending write is narrowed to the match it names, if it names one.
  const busyMatch = busyMatchId(state.pending);

  const act = (command: TourneyCommand) => send(command);

  const groups = groupedEvents(state.events);

  // An event that was running when it was opened moves into the archive the
  // moment it finishes. Folding it away under the reader, with its own detail
  // still on screen beside the gap, reads as the row having vanished.
  const selectedIsPast =
    state.selectedId !== null &&
    state.events.some((event) => event.id === state.selectedId && groupOf(event) === "past");
  useEffect(() => {
    if (selectedIsPast) setShowPast(true);
  }, [selectedIsPast]);

  /**
   * One row of the list.
   *
   * The badge is the event's status, except where the status is not the whole
   * truth. An event whose signups have not opened yet still says `signup`, and
   * saying "Signups open" over a date three weeks out is the client telling
   * somebody to go and enter something they cannot enter. An abandoned one says
   * `signup` or `running` too, and is neither.
   */
  const row = (event: Tourney) => {
    // The website's three countdowns, in its precedence: signups opening, else
    // the event starting; signups closing rides beside the status rather than
    // replacing it, because "Signups open" is still the news.
    const countdowns = listCountdowns(event, now);
    const untilSignups = countdownTo(countdowns.signupsOpen, now);
    const untilStart = countdownTo(countdowns.eventStarts, now);
    const untilClose = countdownTo(countdowns.signupsClose, now);
    const pill = statusPill(event, now);
    const days = eventDayCount(event.eventDays);
    const ratingLine = listRatingLine(event, t);
    const teamsLine = listTeamsLine(event, t);
    const prize = formatPrize(event.prize);
    const facts = [
      listKind(event),
      ...(event.imported ? [] : [t("tournaments.list.signedUp", { count: event.playerCount })]),
      ...(ratingLine === "" ? [] : [ratingLine]),
      ...(teamsLine === "" ? [] : [teamsLine]),
    ];
    return (
      <li key={event.id}>
        <button
          type="button"
          className={
            event.id === state.selectedId
              ? "surface surface-interactive tournament-row is-active"
              : "surface surface-interactive tournament-row"
          }
          aria-current={event.id === state.selectedId}
          onClick={() => send({ type: "select", payload: { tournamentId: event.id } })}
        >
          {/* No "you are entered" badge here, however useful it would be.
              `GET /api/tournaments` sends no viewer block, so the answer is
              known only for whichever event happens to be open, and a badge
              that appears on a row the moment you click it reads as the client
              having just signed you up. A wrong answer about your own entry is
              worse than none. */}
          <span className="tournament-row-name">{event.name || t("tournaments.untitled")}</span>
          {/* Official or community, on the row rather than only inside. It is
              the first thing a player wants to know about an event they have
              not heard of: an official one is run by the tournament team under
              FAF's own rules and pays from FAF's fund. The service sends it with
              the list, so this costs nothing. */}
          {/* One line for both marks: what the event is, then where it is up
              to. Stacked they made every row three lines tall. */}
          <span className="tournament-row-marks">
            <span className={`tournament-tag is-${event.category}`}>
              {t(
                event.category === "official"
                  ? "tournaments.list.official"
                  : "tournaments.list.community",
              )}
            </span>
            {/* A draft says so, and a director looking at somebody else's
                says that too: they can open it, not run it. */}
            {!event.published && (
              <span
                className="tournament-badge"
                title={t(event.canManage ? "tournaments.list.draftTitle" : "tournaments.list.viewOnlyTitle")}
              >
                {t(event.canManage ? "tournaments.list.draftBadge" : "tournaments.list.viewOnly")}
              </span>
            )}
            {untilClose !== null && (
              <span className="tournament-countdown is-close">
                {t("tournaments.list.closesIn", { time: untilClose })}
              </span>
            )}
            {untilClose === null && untilSignups !== null ? (
              <span className="tournament-countdown">{t("tournaments.list.signupsIn", { time: untilSignups })}</span>
            ) : untilClose === null && untilStart !== null ? (
              <span className="tournament-countdown">{t("tournaments.list.startsIn", { time: untilStart })}</span>
            ) : (
              <span className={`tournament-badge is-${pill.tone}`}>{t(pill.label)}</span>
            )}
          </span>
          <span className="tournament-row-when muted">
            {formatDay(event.eventDate, t("tournaments.noDate"))}
            {days > 0 && (
              <>
                {" · "}
                <span className="tournament-days" title={eventDaysLabel(event.eventDays)}>
                  {t("tournaments.list.dayCount", { count: days })}
                </span>
              </>
            )}
            {prize !== "" && (
              <>
                {" · "}
                <span className="tournament-row-prize">{prize}</span>
              </>
            )}
          </span>
          <span className="tournament-row-when muted">{facts.join(" · ")}</span>
        </button>
      </li>
    );
  };

  // Open the host dialog on the Play tab with the match's title filled in.
  // Not "host it outright": the map and the featured mod are still the host's
  // call, and the existing dialog already asks for them properly.
  const hostMatch = (entry: TourneyMatch) => {
    if (open === null) return;
    ipc.send({
      kind: "Lobby",
      command: { type: "prepareHost", payload: { title: matchTitle(open, entry) } },
    });
    ipc.send({ kind: "Nav", command: { type: "select", payload: { tab: "play" } } });
  };

  return (
    <div className="tournaments-view">
      <header className="tournaments-header">
        <div>
          <span className="tournaments-eyebrow">{t("tournaments.eyebrow")}</span>
          <h2>{t("tournaments.title")}</h2>
        </div>
        <div className="tournament-detail-actions">
          {state.hosting.allowed && (
            <Button
              variant="primary"
              onClick={() => {
                act({ type: "loadSeries" });
                // The form's two starting points: named formats and this
                // account's earlier events, both read as the form opens.
                act({ type: "loadPresets" });
                act({ type: "loadCopySources" });
                setEditing("create");
              }}
              disabled={busy}
            >
              <Icon name="plus" size={16} /> {t("tournaments.form.createTitle")}
            </Button>
          )}
          {/* Said out loud rather than left as an absent button: a surface that
              simply vanishes is indistinguishable from one that is broken. */}
          {state.hosting.loggedIn && !state.hosting.allowed && (
            <span className="muted">
              {t(
                state.hosting.pending
                  ? "tournaments.form.hostPending"
                  : "tournaments.form.hostNotAllowed",
              )}
            </span>
          )}
          <HostRequest hosting={state.hosting} busy={busy} onWrite={siteWrite} />
          {/* The same deployment the tab reads from, opened in the browser.
              The tournament site is not going away: it works on a phone, which
              is where a good share of sign-ups happen, and it is where events
              created outside the client still live. `assetBase` is the service
              the tab is actually talking to, so this cannot point somewhere
              else after a deployment move, and it is absent until the first
              load answers. */}
          {state.assetBase !== "" && (
            <Button onClick={() => void openHttpsUrl(state.assetBase)}>
              <Icon name="external" size={16} /> {t("tournaments.viewOnline")}
            </Button>
          )}
          <Button onClick={load} disabled={loading}>
            <Icon name="refresh" size={16} />{" "}
            {t(loading ? "tournaments.refreshing" : "tournaments.refresh")}
          </Button>
        </div>
      </header>

      <SiteNav page={page} account={site.account} busy={busy} onPage={openPage} onWrite={siteWrite} />
      <PendingBar
        pending={site.pending}
        openId={page.kind === "events" ? state.selectedId : null}
        inConsole={page.kind === "console"}
        onGo={(tournamentId, section) => openEventPage(tournamentId, section)}
        onReview={() => openPage({ kind: "console" })}
        onDismiss={() => siteWrite({ type: "dismissRequests" })}
      />

      {state.status.type === "failed" && (
        <div className="surface-error tournaments-error">
          <span>{state.status.payload.reason}</span>
          <Button onClick={load}>
            <Icon name="refresh" size={16} /> {t("common.retry")}
          </Button>
        </div>
      )}

      {/* The server's own sentence, kept until it is dismissed. It is the one
          line that says which rating gate was missed or how many replay ids are
          still wanted, and a banner that vanished on the next render would
          never be read. */}
      {state.actionError !== null && (
        <div className="surface-error tournaments-error">
          <span>{state.actionError.reason}</span>
          <Button onClick={() => send({ type: "dismissActionError" })}>
            <Icon name="close" size={16} /> {t("common.close")}
          </Button>
        </div>
      )}

      {page.kind === "events" && loading && state.events.length === 0 && (
        <div className="surface tournaments-state muted">{t("tournaments.loading")}</div>
      )}

      {page.kind === "events" && state.status.type === "ready" && state.events.length === 0 && (
        <div className="surface tournaments-state muted">{t("tournaments.none")}</div>
      )}

      {page.kind === "hall" && <HallOfFamePage hall={site.hall} status={site.hallStatus} />}
      {page.kind === "faq" && (
        <FaqPage
          articles={state.articles}
          articleId={page.articleId}
          assetBase={state.assetBase}
          siteAdmin={site.account.siteAdmin}
          onOpen={(articleId) => setPage({ kind: "faq", articleId })}
        />
      )}
      {page.kind === "access" && (
        <AccessPage
          access={page.access}
          status={page.access === "editor" ? site.editorAccess : site.importerAccess}
          name={site.account.fafName}
          busy={busy}
          onWrite={siteWrite}
          onSwitch={(access) => openPage({ kind: "access", access })}
        />
      )}
      {page.kind === "console" && (
        <ConsolePage
          console={site.console}
          status={site.consoleStatus}
          account={site.account}
          assetBase={state.assetBase}
          articleImage={site.articleImage}
          accountSearch={state.accountSearch}
          busy={busy}
          onSearchAccounts={(query) => act({ type: "searchAccounts", payload: { query } })}
          onWrite={siteWrite}
        />
      )}
      {page.kind === "series" &&
        (page.seriesId !== null && state.openSeries !== null && state.openSeries.id === page.seriesId ? (
          <SeriesPage
            key={state.openSeries.id}
            series={state.openSeries}
            assetBase={state.assetBase}
            busy={busy}
            accountSearch={state.accountSearch}
            onSearchAccounts={(query) => act({ type: "searchAccounts", payload: { query } })}
            onBack={() => openPage({ kind: "series", seriesId: null })}
            onOpenEvent={(tournamentId) => openEventPage(tournamentId)}
            onWrite={siteWrite}
            onSave={(draft) =>
              act({ type: "saveSeries", payload: { draft: { id: page.seriesId ?? "", ...draft } } })
            }
            onDelete={() => {
              act({ type: "deleteSeries", payload: { seriesId: page.seriesId ?? "" } });
              openPage({ kind: "series", seriesId: null });
            }}
          />
        ) : page.seriesId !== null ? (
          <p className="muted">{t("tournaments.loading")}</p>
        ) : (
          <SeriesIndex
            series={state.series}
            mayCreate={site.account.allowed || site.account.siteAdmin || site.account.director}
            busy={busy}
            onOpen={(seriesId) => openPage({ kind: "series", seriesId })}
            onCreate={(name) =>
              act({
                type: "saveSeries",
                payload: { draft: { id: "", name, description: "", colour: "plain", category: null } },
              })
            }
          />
        ))}

      {page.kind === "events" && state.events.length > 0 && (
        <div className="tournaments-body">
          <div className="tournaments-list">
            {LIVE_GROUPS.map(([group, heading]) =>
              groups[group].length === 0 ? null : (
                <section className="tournaments-group" key={group}>
                  <h3>
                    {t(heading)} <span className="muted">({groups[group].length})</span>
                  </h3>
                  <ul>{groups[group].map(row)}</ul>
                </section>
              ),
            )}

            {/* The archive, folded. Every event FAF has ever run is in this
                list, and the finished ones outnumber the live ones by an order
                of magnitude within a season: unfolded, they are a scroll with
                the useful part off the top of it. Kept rather than filtered
                out, because an organiser reruns a series by reading last
                year's, and that is a real thing people do here. */}
            {groups.past.length > 0 && (
              <section className="tournaments-group">
                <button
                  type="button"
                  className="tournaments-archive-toggle"
                  aria-expanded={showPast}
                  onClick={() => setShowPast((open) => !open)}
                >
                  <Icon name={showPast ? "chevronDown" : "chevronRight"} size={14} />
                  <span>{t("tournaments.list.past")}</span>
                  <span className="muted">({groups.past.length})</span>
                </button>
                {/* By the year it was played, newest first, and fifty at a
                    time within a year: years of imported events are thousands
                    of rows, and nobody scrolls through those. */}
                {showPast &&
                  archiveByYear(groups.past).map(({ year, events }) => {
                    const key = year ?? 0;
                    const shown = pastShown[key] ?? ARCHIVE_PAGE;
                    const left = events.length - shown;
                    return (
                      <div className="tournaments-archive-year" key={key}>
                        <h4>
                          {year ?? t("tournaments.list.noYear")} <span className="muted">({events.length})</span>
                        </h4>
                        <ul>{events.slice(0, shown).map(row)}</ul>
                        {left > 0 && (
                          <Button
                            onClick={() => setPastShown((held) => ({ ...held, [key]: shown + ARCHIVE_PAGE }))}
                          >
                            {t("tournaments.list.showMore", {
                              count: Math.min(left, ARCHIVE_PAGE),
                              total: events.length,
                            })}
                          </Button>
                        )}
                      </div>
                    );
                  })}
              </section>
            )}
          </div>

          {open !== null ? (
            <TournamentDetailPane
              event={open}
              onOpenPage={openPage}
              jump={jump}
              siteAdmin={site.account.siteAdmin}
              pastedImage={state.descImage}
              onUploadImage={(dataUrl) =>
                act({ type: "uploadDescImage", payload: { tournamentId: open.id, dataUrl } })
              }
              detailLoading={state.detailStatus.type === "loading"}
              series={state.series}
              events={state.events}
              profiles={state.entrantProfiles}
              articles={state.articles}
              assetBase={state.assetBase}
              onNeedVault={needVault}
              vault={vault}
              vaultStatus={vaultStatus}
              chatRooms={state.chatRooms}
              openRoomId={state.openRoomId}
              chatPosts={state.chatPosts}
              chatStatus={state.chatStatus}
              busy={busy}
              busyMatchId={busyMatch}
              accountSearch={state.accountSearch}
              onSearchAccounts={(query) => act({ type: "searchAccounts", payload: { query } })}
              renames={state.renames}
              renamesStatus={state.renamesStatus}
              onCheckRenames={() => act({ type: "checkRenames", payload: { tournamentId: open.id } })}
              ratingCheck={state.ratingCheck}
              ratingCheckStatus={state.ratingCheckStatus}
              onCheckRating={() => act({ type: "checkRating", payload: { tournamentId: open.id } })}
              onDeclineInvite={() => act({ type: "declineInvite", payload: { tournamentId: open.id } })}
              playerRatings={state.playerRatings}
              playerRatingsStatus={state.playerRatingsStatus}
              mapImport={{
                sources: state.copySources,
                sourcesStatus: state.copySourcesStatus,
                source: state.copySource,
                sourceStatus: state.copySourceStatus,
                onLoadSources: () => act({ type: "loadCopySources" }),
                onLoadSource: (tournamentId) => act({ type: "loadCopySource", payload: { tournamentId } }),
              }}
              onLoadPlayerRatings={(playerId, refresh) =>
                act({ type: "loadPlayerRatings", payload: { tournamentId: open.id, playerId, refresh } })
              }
              onBanPlayer={(player, reason, expires, remove) =>
                player.fafId !== null &&
                act({
                  type: "banPlayer",
                  payload: {
                    tournamentId: open.id,
                    playerId: player.id,
                    fafId: player.fafId,
                    name: player.name,
                    reason,
                    expires,
                    remove,
                  },
                })
              }
              onSignUp={() => setEntering(open.id)}
              onWithdraw={() => act({ type: "withdraw", payload: { tournamentId: open.id } })}
              onCheckIn={(checkedIn) =>
                act({ type: "checkIn", payload: { tournamentId: open.id, checkedIn } })
              }
              onReport={setReporting}
              onAnswer={(entry, accept) =>
                act({
                  type: "answerReport",
                  payload: { tournamentId: open.id, matchId: entry.id, accept },
                })
              }
              onHost={hostMatch}
              onOpenChat={() => act({ type: "loadChat", payload: { tournamentId: open.id } })}
              onOpenRoom={(roomId) =>
                act({ type: "openRoom", payload: { tournamentId: open.id, roomId } })
              }
              onPost={(body, replyTo) => {
                if (state.openRoomId === null) return;
                act({
                  type: "postChat",
                  payload: { tournamentId: open.id, roomId: state.openRoomId, body, replyTo },
                });
              }}
              onAssignPool={(roundKey, poolId) =>
                act({ type: "assignPool", payload: { tournamentId: open.id, roundKey, poolId } })
              }
              onOpenUrl={(url) => {
                void openHttpsUrl(url);
              }}
              onEditInfo={(draft: TourneyDraft) =>
                act({ type: "editInfo", payload: { tournamentId: open.id, draft } })
              }
              onPublish={() => act({ type: "publish", payload: { tournamentId: open.id } })}
              onAdvance={(phase: TourneyPhase, config?: BracketConfig) =>
                act({
                  type: "advance",
                  // Null rather than absent: the config is only ever set on
                  // `start_bracket`, and the service defaults every value from
                  // the event's own plan when it is not there.
                  payload: { tournamentId: open.id, phase, config: config ?? null },
                })
              }
              onArchive={() => act({ type: "archive", payload: { tournamentId: open.id } })}
              onCreateTeam={(name) =>
                act({ type: "createTeam", payload: { tournamentId: open.id, name } })
              }
              onRequestJoin={(teamId) =>
                act({ type: "requestJoin", payload: { tournamentId: open.id, teamId } })
              }
              onCancelJoin={(teamId) =>
                act({ type: "cancelJoin", payload: { tournamentId: open.id, teamId } })
              }
              onRespondJoin={(teamId, playerId, accept) =>
                act({
                  type: "respondJoin",
                  payload: { tournamentId: open.id, teamId, playerId, accept },
                })
              }
              onInvite={(teamId, playerId) =>
                act({
                  type: "inviteToTeam",
                  payload: { tournamentId: open.id, teamId, playerId },
                })
              }
              onRespondInvite={(teamId, accept) =>
                act({ type: "respondInvite", payload: { tournamentId: open.id, teamId, accept } })
              }
              onLeaveTeam={() => act({ type: "leaveTeam", payload: { tournamentId: open.id } })}
              onDisbandTeam={(teamId) =>
                act({ type: "disbandTeam", payload: { tournamentId: open.id, teamId } })
              }
              onRenameTeam={(teamId, name) =>
                act({ type: "renameTeam", payload: { tournamentId: open.id, teamId, name } })
              }
              // Picking somebody ends the search: the field closed, and leaving
              // a clickable list behind would invite adding the same person
              // twice.
              onAddPlayer={(name, rating) => {
                act({ type: "addPlayer", payload: { tournamentId: open.id, name, rating } });
                act({ type: "clearAccountSearch" });
              }}
              onSetCaptain={(teamId, playerId) =>
                act({ type: "setCaptain", payload: { tournamentId: open.id, teamId, playerId } })
              }
              onMovePlayer={(playerId, teamId) =>
                act({ type: "movePlayer", payload: { tournamentId: open.id, playerId, teamId } })
              }
              onEditPlayer={(playerId, note, rating) =>
                act({ type: "editPlayer", payload: { tournamentId: open.id, playerId, note, rating } })
              }
              onDraftPick={(playerId) =>
                act({ type: "draftPickPlayer", payload: { tournamentId: open.id, playerId } })
              }
              onDraftUndo={() =>
                act({ type: "draftUndo", payload: { tournamentId: open.id } })
              }
              onSetCaptains={(playerIds) =>
                act({ type: "setCaptains", payload: { tournamentId: open.id, playerIds } })
              }
              onReportFfa={(report) =>
                act({ type: "reportFfa", payload: { tournamentId: open.id, report } })
              }
              veto={{
                onAct: (matchId, mapId) =>
                  act({ type: "vetoAct", payload: { tournamentId: open.id, matchId, mapId } }),
                onSetSides: (matchId, teamA) =>
                  act({ type: "vetoSetSides", payload: { tournamentId: open.id, matchId, teamA } }),
                onUndo: (matchId) =>
                  act({ type: "vetoUndo", payload: { tournamentId: open.id, matchId } }),
                onFaction: (matchId, game, faction) =>
                  act({
                    type: "factionVeto",
                    payload: { tournamentId: open.id, matchId, game, faction },
                  }),
                onFactionReset: (matchId, game, slot) =>
                  act({
                    type: "administer",
                    payload: { tournamentId: open.id, change: { type: "factionReset", payload: { matchId, game, slot } } },
                  }),
              }}
              onSaveMap={(map) => act({ type: "saveMap", payload: { tournamentId: open.id, map } })}
              onPublishMap={(mapId, published) =>
                act({ type: "publishMap", payload: { tournamentId: open.id, mapId, published } })
              }
              onDeleteMap={(mapId) =>
                act({ type: "deleteMap", payload: { tournamentId: open.id, mapId } })
              }
              onWatchReplay={(uid) =>
                ipc.send({ kind: "Replays", command: { type: "watchVault", payload: { uid } } })
              }
              onSetFactionVeto={(config) =>
                act({ type: "setFactionVeto", payload: { tournamentId: open.id, config } })
              }
              onAdmin={(change) =>
                act({ type: "administer", payload: { tournamentId: open.id, change } })
              }
              onSavePool={(pool) =>
                act({ type: "savePool", payload: { tournamentId: open.id, pool } })
              }
              onPublishPool={(poolId, published) =>
                act({ type: "publishPool", payload: { tournamentId: open.id, poolId, published } })
              }
              onDeletePool={(poolId) =>
                act({ type: "deletePool", payload: { tournamentId: open.id, poolId } })
              }
              onRefreshChat={(roomId) =>
                act({ type: "refreshChat", payload: { tournamentId: open.id, roomId } })
              }
              onRefreshDetail={() => act({ type: "refreshDetail", payload: { tournamentId: open.id } })}
              pinnedRoomId={state.pinnedRoomId}
              pinnedPosts={state.pinnedPosts}
              onPin={(roomId) => act({ type: "pinRoom", payload: { tournamentId: open.id, roomId } })}
              onPostTo={(roomId, body, replyTo) =>
                act({ type: "postChat", payload: { tournamentId: open.id, roomId, body, replyTo } })
              }
              onDeleteChatPost={(roomId, postId) =>
                act({
                  type: "deleteChatPost",
                  payload: { tournamentId: open.id, roomId, postId },
                })
              }
              onMute={(fafId, name, muted) =>
                act({ type: "muteChat", payload: { tournamentId: open.id, fafId, name, muted } })
              }
              onAddOrganiser={(fafId, name) =>
                act({ type: "addOrganiser", payload: { tournamentId: open.id, fafId, name } })
              }
              onSetCaster={(fafId, name, casting) =>
                act({ type: "setCaster", payload: { tournamentId: open.id, fafId, name, casting } })
              }
              onSetOrganiserVisibility={(fafId, hidden) =>
                act({
                  type: "setOrganiserVisibility",
                  payload: { tournamentId: open.id, fafId, hidden },
                })
              }
              onAbandon={(abandoned) =>
                act({ type: "abandon", payload: { tournamentId: open.id, abandoned } })
              }
              onEditFormat={(format) =>
                act({ type: "editFormat", payload: { tournamentId: open.id, format } })
              }
              onEditNews={(newsId, body, important) =>
                act({
                  type: "editNews",
                  payload: { tournamentId: open.id, newsId, body, important },
                })
              }
              onMarkNewsRead={() =>
                act({ type: "markNewsRead", payload: { tournamentId: open.id } })
              }
              onLoadSeries={() => act({ type: "loadSeries" })}
              onSetSeries={(seriesId) =>
                act({ type: "setSeries", payload: { tournamentId: open.id, seriesId } })
              }
              onSaveSeries={(draft) => act({ type: "saveSeries", payload: { draft } })}
              onAddQualifier={(qualifierId, rule) =>
                act({
                  type: "addQualifier",
                  payload: { tournamentId: open.id, qualifierId, rule },
                })
              }
              onRemoveQualifier={(linkId) =>
                act({ type: "removeQualifier", payload: { tournamentId: open.id, linkId } })
              }
              onSetDivision={(teamId, division) =>
                act({ type: "setDivision", payload: { tournamentId: open.id, teamId, division } })
              }
              onRespondSignup={(playerId, accept) =>
                act({
                  type: "respondSignup",
                  payload: { tournamentId: open.id, playerId, accept },
                })
              }
              onRemovePlayer={(playerId) =>
                act({ type: "removePlayer", payload: { tournamentId: open.id, playerId } })
              }
              onInvitePlayer={(name) => {
                act({ type: "invitePlayer", payload: { tournamentId: open.id, name } });
                act({ type: "clearAccountSearch" });
              }}
              onUninvite={(fafId) =>
                act({ type: "uninvite", payload: { tournamentId: open.id, fafId } })
              }
              onReseed={(order: SeedOrder) =>
                act({ type: "reseed", payload: { tournamentId: open.id, order } })
              }
              onSplitDivisions={(divisions) =>
                act({ type: "splitDivisions", payload: { tournamentId: open.id, divisions } })
              }
              onPostNews={(body, important) =>
                act({ type: "postNews", payload: { tournamentId: open.id, body, important } })
              }
              onDeleteNews={(newsId) =>
                act({ type: "deleteNews", payload: { tournamentId: open.id, newsId } })
              }
            />
          ) : (
            <div className="surface tournaments-state muted">
              {state.detailStatus.type === "loading"
                ? t("tournaments.detailLoading")
                : t("tournaments.select")}
            </div>
          )}
        </div>
      )}

      {editing !== null && (
        <TournamentForm
          event={editing === "edit" ? open : null}
          series={state.series}
          busy={busy}
          onSubmit={(draft: TourneyDraft) => {
            if (editing === "edit" && open !== null) {
              act({ type: "editInfo", payload: { tournamentId: open.id, draft } });
            } else {
              act({ type: "create", payload: { draft } });
            }
            setEditing(null);
          }}
          onClose={() => setEditing(null)}
          presets={state.presets}
          sources={state.copySources}
          template={state.template}
          templateStatus={state.templateStatus}
          onLoadTemplate={(tournamentId) => act({ type: "loadTemplate", payload: { tournamentId } })}
        />
      )}

      {entering !== null && (
        <SignUpDialog
          name={state.events.find((event) => event.id === entering)?.name ?? ""}
          discord={state.discord}
          needsRating={(() => {
            const entered = open !== null && open.id === entering ? open : state.events.find((event) => event.id === entering);
            return entered !== undefined && signupNeedsRating(entered);
          })()}
          busy={busy}
          onConfirm={(discord, rating) => {
            // The handle first, so an organiser reading the entrant list sees
            // it against the entry rather than a minute later.
            if (discord !== null) act({ type: "setDiscord", payload: { handle: discord } });
            act({ type: "signUp", payload: { tournamentId: entering, rating } });
            setEntering(null);
          }}
          onClose={() => setEntering(null)}
        />
      )}

      {reporting !== null && open !== null && !mayReport(open, reporting) && (
        <ScoreSubmitDialog
          event={open}
          entry={reporting}
          busy={busy}
          onSubmit={(report: MatchReport) => {
            // `report_submit`, the player path: it counts once the other side
            // or an organiser confirms it.
            act({ type: "submitReport", payload: { tournamentId: open.id, report } });
            setReporting(null);
          }}
          onClose={() => setReporting(null)}
        />
      )}

      {reporting !== null && open !== null && mayReport(open, reporting) && (
        <MatchReportDialog
          event={open}
          entry={reporting}
          busy={busy}
          onSubmit={(report: MatchReport) => {
            // `report`, the organiser path: it takes a forfeit and an explicit
            // winner, and replay ids without demanding one per game.
            act({ type: "decideReport", payload: { tournamentId: open.id, report } });
            setReporting(null);
          }}
          onAnswer={(accept) => {
            act({
              type: "answerReport",
              payload: { tournamentId: open.id, matchId: reporting.id, accept },
            });
            setReporting(null);
          }}
          onClose={() => setReporting(null)}
        />
      )}
    </div>
  );
}

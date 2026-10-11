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
//
// This file is the tab's shell: the header, the site's navigation and its
// other pages, and the dialogs. The event list (`TournamentEventList`) and the
// selected event (`TournamentEventDetail`) are their own components, each
// subscribing to the fields it reads.

import { useEffect, useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { StatusNotice } from "../../design-system/StatusNotice";
import type {
  MatchReport,
  TourneyCommand,
  TourneyDraft,
  TourneyMatch,
} from "../../ipc/bindings";
import { openHttpsUrl } from "../../shared/externalLinks";
import { useAppStore } from "../../store/store";
import { MatchReportDialog } from "./bracket/MatchReportDialog";
import { ScoreSubmitDialog } from "./bracket/ScoreSubmitDialog";
import { TournamentForm } from "./manage/TournamentForm";
import { SignUpDialog } from "./SignUpDialog";
import { HostRequest, PendingBar, SiteNav } from "./site/SiteChrome";
import { TournamentSitePages } from "./TournamentSitePages";
import { TournamentEventList } from "./TournamentEventList";
import { TournamentEventDetail } from "./TournamentEventDetail";
import { load, send } from "./tourneyCommands";
import { useTourneySite } from "./useTourneySite";
import { useEventListFold } from "./useEventListFold";
import { mayReport, openEvent, signupNeedsRating } from "../../shared/rules/tourneyRules";
import "./tournaments.css";
import { useTranslation } from "../../i18n/useTranslation";
import { plainError } from "../../shared/plainError";

/** How often the countdowns are recomputed. Minute resolution, minute ticks. */
const TICK_MS = 60_000;

export function TournamentsView() {
  const { t } = useTranslation();
  const events = useAppStore((store) => store.state.tourney.events);
  const status = useAppStore((store) => store.state.tourney.status);
  const selectedId = useAppStore((store) => store.state.tourney.selectedId);
  const detail = useAppStore((store) => store.state.tourney.detail);
  const pending = useAppStore((store) => store.state.tourney.pending);
  const hosting = useAppStore((store) => store.state.tourney.hosting);
  const assetBase = useAppStore((store) => store.state.tourney.assetBase);
  const actionError = useAppStore((store) => store.state.tourney.actionError);
  const account = useAppStore((store) => store.state.tourney.site.account);
  const sitePending = useAppStore((store) => store.state.tourney.site.pending);
  const series = useAppStore((store) => store.state.tourney.series);
  const presets = useAppStore((store) => store.state.tourney.presets);
  const copySources = useAppStore((store) => store.state.tourney.copySources);
  const template = useAppStore((store) => store.state.tourney.template);
  const templateStatus = useAppStore((store) => store.state.tourney.templateStatus);
  const discord = useAppStore((store) => store.state.tourney.discord);
  const [reporting, setReporting] = useState<TourneyMatch | null>(null);
  const [editing, setEditing] = useState<"create" | "edit" | null>(null);
  /** The event whose signup dialog is open, if any. */
  const [entering, setEntering] = useState<string | null>(null);
  // A countdown drawn once is wrong within the minute, and this tab is one
  // people leave open waiting for exactly the thing it counts down to. Kept
  // here rather than in the list: each tick redraws the whole tab, and the
  // detail pane and the series pages read the clock as they draw (check-in
  // windows, "starts in"), so they ride on it too.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  const { page, setPage, jump, siteWrite, openPage, openEventPage } = useTourneySite();
  const fold = useEventListFold();

  // Never show one tournament's bracket under another's name: the pane waits
  // for the detail that belongs to the row that is open.
  const open = openEvent(detail, selectedId);
  const loading = status.type === "loading";
  /** Nothing has answered yet: idle until the mount effect asks, then loading. */
  const firstLoad = status.type === "idle" || loading;
  const busy = pending !== null;

  const act = (command: TourneyCommand) => send(command);

  return (
    <div className="tournaments-view">
      <header className="tournaments-header">
        <div>
          <span className="tournaments-eyebrow">{t("tournaments.eyebrow")}</span>
          <h2>{t("tournaments.title")}</h2>
        </div>
        <div className="tournament-detail-actions">
          {hosting.allowed && (
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
          {hosting.loggedIn && !hosting.allowed && (
            <span className="muted">
              {t(
                hosting.pending
                  ? "tournaments.form.hostPending"
                  : "tournaments.form.hostNotAllowed",
              )}
            </span>
          )}
          <HostRequest hosting={hosting} busy={busy} onWrite={siteWrite} />
          {/* The same deployment the tab reads from, opened in the browser.
              The tournament site is not going away: it works on a phone, which
              is where a good share of sign-ups happen, and it is where events
              created outside the client still live. `assetBase` is the service
              the tab is actually talking to, so this cannot point somewhere
              else after a deployment move, and it is absent until the first
              load answers. */}
          {/* Drawn from the start and disabled until it has somewhere to go,
              rather than appearing once the first load answers and pushing
              the buttons beside it along. */}
          <Button disabled={assetBase === ""} onClick={() => void openHttpsUrl(assetBase)}>
            <Icon name="external" size={16} /> {t("tournaments.viewOnline")}
          </Button>
          <Button onClick={load} disabled={loading}>
            <Icon name="refresh" size={16} />{" "}
            {/* Both labels share one cell, so the button is as wide as the
                longer one in either state and nothing beside it moves. */}
            <span className="tournaments-refresh-label">
              <span className={loading ? "is-hidden" : undefined} aria-hidden={loading}>{t("tournaments.refresh")}</span>
              <span className={loading ? undefined : "is-hidden"} aria-hidden={!loading}>{t("tournaments.refreshing")}</span>
            </span>
          </Button>
        </div>
      </header>

      <SiteNav page={page} account={account} busy={busy} onPage={openPage} onWrite={siteWrite} />
      <PendingBar
        pending={sitePending}
        openId={page.kind === "events" ? selectedId : null}
        inConsole={page.kind === "console"}
        onGo={(tournamentId, section) => openEventPage(tournamentId, section)}
        onReview={() => openPage({ kind: "console" })}
        onDismiss={() => siteWrite({ type: "dismissRequests" })}
      />

      {status.type === "failed" && (
        <StatusNotice tone="error" action={{ label: t("common.retry"), onClick: load }} detail={status.payload.reason}>
          {t("tournaments.loadFailed", { reason: plainError(status.payload.reason) })}
        </StatusNotice>
      )}

      {/* The server's own sentence, kept until it is dismissed. It is the one
          line that says which rating gate was missed or how many replay ids are
          still wanted, and a banner that vanished on the next render would
          never be read. It passes through `plainError` as written; what that
          rewords is a transport failure, which used to arrive here as the
          HTTP client's English, and the original stays on hover. */}
      {actionError !== null && (
        <StatusNotice
          tone="error"
          secondary={{ label: t("common.close"), onClick: () => send({ type: "dismissActionError" }) }}
          detail={actionError.reason}
        >
          {plainError(actionError.reason)}
        </StatusNotice>
      )}

      {page.kind === "events" && status.type === "ready" && events.length === 0 && (
        <div className="surface tournaments-state muted">{t("tournaments.none")}</div>
      )}

      <TournamentSitePages
        page={page}
        busy={busy}
        setPage={setPage}
        openPage={openPage}
        openEventPage={openEventPage}
        siteWrite={siteWrite}
      />

      {/* The list and the detail are laid out before the first load answers,
          with the loading line in the list's own column. A loading box in
          their place was swapped for the two columns on arrival, and the
          whole tab jumped. */}
      {page.kind === "events" && (events.length > 0 || firstLoad) && (
        <div className="tournaments-body">
          <TournamentEventList now={now} fold={fold} />

          <TournamentEventDetail
            jump={jump}
            onOpenPage={openPage}
            onSignUp={setEntering}
            onReport={setReporting}
          />
        </div>
      )}

      {editing !== null && (
        <TournamentForm
          event={editing === "edit" ? open : null}
          series={series}
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
          presets={presets}
          sources={copySources}
          template={template}
          templateStatus={templateStatus}
          onLoadTemplate={(tournamentId) => act({ type: "loadTemplate", payload: { tournamentId } })}
        />
      )}

      {entering !== null && (
        <SignUpDialog
          name={events.find((event) => event.id === entering)?.name ?? ""}
          discord={discord}
          needsRating={(() => {
            const entered = open !== null && open.id === entering ? open : events.find((event) => event.id === entering);
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

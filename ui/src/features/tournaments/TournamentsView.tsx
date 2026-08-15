// Tournaments: FAF's competitive events, mirroring the Java client's
// `TournamentsController`: a list on the left, the selected event's detail on
// the right, ordered upcoming-first with finished events last.
//
// The detail pane is built from state rather than the Java client's HTML
// template. That template substitutes the organiser's raw description into a
// WebView; here the description arrives already reduced to plain text (see
// `faf-domain`'s `protocol::tournaments`), so nothing an organiser writes can
// execute in the client. Everything the template offered: name, bracket link,
// format, dates, description, banner: is present.

import { useEffect, useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import type { Tournament } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { openHttpsUrl, optionalHttpsUrl } from "../../shared/externalLinks";
import { useAppStore } from "../../store/store";
import { formatMoment, statusOf, STATUS_LABELS } from "./tournamentStatus";
import "./tournaments.css";

const load = () => ipc.send({ kind: "Tournaments", command: { type: "load" } });
const select = (tournamentId: number) =>
  ipc.send({ kind: "Tournaments", command: { type: "select", payload: { tournamentId } } });

/** Re-derive statuses on a timer so a bracket that starts while the tab is open says so. */
function useNowSeconds(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

export function TournamentsView() {
  const state = useAppStore((store) => store.state.tournaments);
  const now = useNowSeconds();

  useEffect(() => {
    if (useAppStore.getState().state.tournaments.status.type === "idle") void load();
  }, []);

  const selected =
    state.tournaments.find((tournament) => tournament.id === state.selectedId) ?? null;
  const loading = state.status.type === "loading";

  return (
    <div className="tournaments-view">
      <header className="tournaments-header">
        <div>
          <span className="tournaments-eyebrow">Competitive events</span>
          <h2>Tournaments</h2>
        </div>
        <Button onClick={() => void load()} disabled={loading}>
          <Icon name="refresh" size={16} /> {loading ? "Refreshing…" : "Refresh"}
        </Button>
      </header>

      {state.status.type === "failed" && (
        <div className="surface-error tournaments-error">
          <span>{state.status.payload.reason}</span>
          <Button onClick={() => void load()}>
            <Icon name="refresh" size={16} /> Retry
          </Button>
        </div>
      )}

      {loading && state.tournaments.length === 0 && (
        <div className="surface tournaments-state muted">Loading tournaments…</div>
      )}

      {state.status.type === "ready" && state.tournaments.length === 0 && (
        <div className="surface tournaments-state muted">
          No tournaments are scheduled right now. Check back before the next event.
        </div>
      )}

      {state.tournaments.length > 0 && (
        <div className="tournaments-body">
          <ul className="tournaments-list">
            {state.tournaments.map((tournament) => {
              const status = statusOf(tournament, now);
              return (
                <li key={tournament.id}>
                  <button
                    type="button"
                    className={
                      tournament.id === state.selectedId
                        ? "surface surface-interactive tournament-row is-active"
                        : "surface surface-interactive tournament-row"
                    }
                    aria-current={tournament.id === state.selectedId}
                    onClick={() => void select(tournament.id)}
                  >
                    <span className="tournament-row-name">{tournament.name || "Untitled"}</span>
                    <span className={`tournament-badge is-${status}`}>
                      {STATUS_LABELS[status]}
                    </span>
                    <span className="tournament-row-when muted">
                      {formatMoment(tournament.startingAt, "No starting date set")}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          {selected ? (
            <TournamentDetail tournament={selected} now={now} />
          ) : (
            <div className="surface tournaments-state muted">Select a tournament.</div>
          )}
        </div>
      )}
    </div>
  );
}

function TournamentDetail({ tournament, now }: { tournament: Tournament; now: number }) {
  const status = statusOf(tournament, now);
  const signUpUrl = optionalHttpsUrl(tournament.signUpUrl);
  const challongeUrl = optionalHttpsUrl(tournament.challongeUrl);

  return (
    <section className="surface-panel tournament-detail">
      <header>
        <div>
          <span className={`tournament-badge is-${status}`}>{STATUS_LABELS[status]}</span>
          <h3>{tournament.name || "Untitled"}</h3>
        </div>
        <div className="tournament-detail-actions">
          {/* Signup, seeding and results all live on Challonge: the client
              never had a way to enter a bracket, in any of the three clients. */}
          {status === "openForRegistration" && signUpUrl && (
            <Button variant="primary" onClick={() => void openHttpsUrl(signUpUrl)}>
              <Icon name="external" size={16} /> Sign up
            </Button>
          )}
          {challongeUrl && (
            <Button onClick={() => void openHttpsUrl(challongeUrl)}>
              <Icon name="external" size={16} /> Open on challonge.com
            </Button>
          )}
        </div>
      </header>

      <dl className="tournament-facts">
        <div>
          <dt>Game type</dt>
          <dd>{tournament.tournamentType || "Unknown"}</dd>
        </div>
        <div>
          <dt>Participants</dt>
          <dd>{tournament.participantCount}</dd>
        </div>
        <div>
          <dt>Starting at</dt>
          <dd>{formatMoment(tournament.startingAt, "No starting date set")}</dd>
        </div>
        <div>
          <dt>Completed at</dt>
          <dd>{formatMoment(tournament.completedAt, "Not completed yet")}</dd>
        </div>
      </dl>

      {tournament.description && (
        <p className="tournament-description">{tournament.description}</p>
      )}

      {tournament.liveImageUrl && (
        <img
          className="tournament-banner"
          src={tournament.liveImageUrl}
          alt={`${tournament.name} bracket`}
          loading="lazy"
        />
      )}
    </section>
  );
}

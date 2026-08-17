// Tournaments: FAF's competitive events, from a player's side of them.
//
// Backed by `faf-tournaments`, the tournament team's own service, which
// replaced the Challonge bridge this tab first shipped against. That service
// models what Challonge could not: teams of one to six, map pools per round,
// check-in windows, rating gates, and a bracket that is an explicit graph
// rather than a set of round numbers to be inferred from.
//
// The scope is deliberately a *participant's*: see an event, enter it, check
// in, play, report a result, talk to the other players. Creating a tournament
// and configuring its format stay on the website, reached from Manage. The one
// organiser task kept here is assigning map pools, because picking maps is a
// search through FAF's vault with previews and the website cannot match that.

import { useEffect, useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import type {
  AppCommand,
  MatchReport,
  SeedOrder,
  TourneyCommand,
  TourneyDraft,
  TourneyMatch,
  TourneyPhase,
} from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { openHttpsUrl } from "../../shared/externalLinks";
import { useAppStore } from "../../store/store";
import { matchTitle } from "./matchTitle";
import { MatchReportDialog } from "./MatchReportDialog";
import { TournamentDetailPane } from "./TournamentDetailPane";
import { TournamentForm } from "./TournamentForm";
import { busyMatchId, formatDay, openEvent, STATUS_LABELS } from "./tourneyPresentation";
import "./tournaments.css";
import { useTranslation } from "../../i18n/useTranslation";

/** Every command this tab sends is a tourney command; this is the only wrapper. */
const send = (command: TourneyCommand) =>
  ipc.send({ kind: "Tourney", command } satisfies AppCommand);

const load = () => send({ type: "load" });

export function TournamentsView() {
  const { t } = useTranslation();
  const state = useAppStore((store) => store.state.tourney);
  const vault = useAppStore((store) => store.state.maps.vault);
  const [reporting, setReporting] = useState<TourneyMatch | null>(null);
  const [editing, setEditing] = useState<"create" | "edit" | null>(null);

  useEffect(() => {
    if (useAppStore.getState().state.tourney.status.type === "idle") {
      load();
      // Site-wide and cached for the session: the rules pages do not belong to
      // any one tournament, so they are fetched once rather than per event.
      send({ type: "loadArticles" });
      // Hosting is approval-only, granted per account. Asked once, because the
      // alternative is a create button that answers "not approved yet".
      send({ type: "loadHosting" });
    }
  }, []);

  // Never show one tournament's bracket under another's name: the pane waits
  // for the detail that belongs to the row that is open.
  const open = openEvent(state.detail, state.selectedId);
  const loading = state.status.type === "loading";
  const busy = state.pending !== null;
  // One match's spinner must not disable the rest of the bracket, so the
  // pending write is narrowed to the match it names, if it names one.
  const busyMatch = busyMatchId(state.pending);

  const act = (command: TourneyCommand) => send(command);

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
            <Button variant="primary" onClick={() => setEditing("create")} disabled={busy}>
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
          <Button onClick={load} disabled={loading}>
            <Icon name="refresh" size={16} />{" "}
            {t(loading ? "tournaments.refreshing" : "tournaments.refresh")}
          </Button>
        </div>
      </header>

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

      {loading && state.events.length === 0 && (
        <div className="surface tournaments-state muted">{t("tournaments.loading")}</div>
      )}

      {state.status.type === "ready" && state.events.length === 0 && (
        <div className="surface tournaments-state muted">{t("tournaments.none")}</div>
      )}

      {state.events.length > 0 && (
        <div className="tournaments-body">
          <ul className="tournaments-list">
            {state.events.map((event) => (
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
                  {/* No "you are entered" badge here, however useful it would
                      be. `GET /api/tournaments` sends no viewer block, so the
                      answer is known only for whichever event happens to be
                      open, and a badge that appears on a row the moment you
                      click it reads as the client having just signed you up.
                      A wrong answer about your own entry is worse than none. */}
                  <span className="tournament-row-name">
                    {event.name || t("tournaments.untitled")}
                  </span>
                  <span className={`tournament-badge is-${event.status}`}>
                    {t(STATUS_LABELS[event.status])}
                  </span>
                  <span className="tournament-row-when muted">
                    {formatDay(event.eventDate, t("tournaments.noDate"))}
                    {event.playerCount > 0 &&
                      ` · ${t("tournaments.list.entrants", { count: event.playerCount })}`}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          {open !== null ? (
            <TournamentDetailPane
              event={open}
              detailLoading={state.detailStatus.type === "loading"}
              profiles={state.entrantProfiles}
              articles={state.articles}
              vault={vault}
              chatRooms={state.chatRooms}
              openRoomId={state.openRoomId}
              chatPosts={state.chatPosts}
              chatStatus={state.chatStatus}
              busy={busy}
              busyMatchId={busyMatch}
              accountSearch={state.accountSearch}
              onSearchAccounts={(query) => act({ type: "searchAccounts", payload: { query } })}
              onSignUp={() => act({ type: "signUp", payload: { tournamentId: open.id } })}
              onWithdraw={() => act({ type: "withdraw", payload: { tournamentId: open.id } })}
              onCheckIn={() => act({ type: "checkIn", payload: { tournamentId: open.id } })}
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
              onPost={(body) => {
                if (state.openRoomId === null) return;
                act({
                  type: "postChat",
                  payload: { tournamentId: open.id, roomId: state.openRoomId, body },
                });
              }}
              onAssignPool={(roundKey, poolId) =>
                act({ type: "assignPool", payload: { tournamentId: open.id, roundKey, poolId } })
              }
              onOpenUrl={(url) => {
                void openHttpsUrl(url);
              }}
              onEdit={() => setEditing("edit")}
              onAdvance={(phase: TourneyPhase) =>
                act({ type: "advance", payload: { tournamentId: open.id, phase } })
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
        />
      )}

      {reporting !== null && open !== null && (
        <MatchReportDialog
          event={open}
          entry={reporting}
          busy={busy}
          onSubmit={(report: MatchReport) => {
            // `report`, the organiser path: it takes a forfeit and an explicit
            // winner and does not demand a replay id per game. `report_submit` is
            // the players' own path and is not used here.
            act({ type: "decideReport", payload: { tournamentId: open.id, report } });
            setReporting(null);
          }}
          onClose={() => setReporting(null)}
        />
      )}
    </div>
  );
}

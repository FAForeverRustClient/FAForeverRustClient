// The organiser's controls for an event that already exists.
//
// Each step is offered only from the status the server takes it from: a button
// that answers "Form teams first" is worse than no button, because it reads as
// broken rather than as not-yet.
//
// Two stages. The first is a board of tiles, each naming one group of controls
// and nothing else; the second is that group, on its own, with everything else
// out of the way. Twenty controls in one column is a scroll in which everything
// looks equally important, and the editors are long enough that reaching the
// sixth means passing five.
//
// Three things are not behind a tile, because they are one button each and are
// the ones an organiser wants without hunting: how far the event has got, the
// link to the website, and the two ways of ending it.
//
// The groups, in the order they are wanted:
//
//   Settings    what the event is: the create form again, plus the format
//   Players     the field: add, approve, invite, remove, seed, divide
//   Teams       who plays with whom, while that is still open
//   Maps        the database, the pools, and which round plays which
//   Organisers  co-organisers and casters
//   Series      this edition's label, and the events that feed it
//   Chat        the silenced list, and the way back in

import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import type {
  AccountSearch,
  BracketConfig,
  FormatDraft,
  MapDraft,
  MapListStatus,
  PoolDraft,
  PlayerSummary,
  QualifierRule,
  SeedOrder,
  SeriesDraft,
  Tourney,
  TourneyDraft,
  TourneyPhase,
  TourneySeries,
  VaultMap,
} from "../../ipc/bindings";
import type { MessageKey } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";
import { useState } from "react";
import { BracketSetupDialog } from "./BracketSetupDialog";
import { EntrantAdmin } from "./EntrantAdmin";
import { FormatPanel } from "./FormatPanel";
import { TournamentForm } from "./TournamentForm";
import { MapDbPanel } from "./MapDbPanel";
import { OrganiserPanel } from "./OrganiserPanel";
import { MapPoolPanel, ManageLink } from "./MapPoolPanel";
import { PoolEditor } from "./PoolEditor";
import { SeriesPanel } from "./SeriesPanel";
import { TeamAdmin } from "./TeamAdmin";
import {
  isLegalFrom,
  mayEditFormat,
  mayPublish,
  mayShuffleTeams,
} from "../../shared/tourneyRules";

const PHASE_LABELS: Record<TourneyPhase, MessageKey> = {
  formTeams: "tournaments.manage.formTeams",
  startBracket: "tournaments.manage.startBracket",
  reopenSignups: "tournaments.manage.reopenSignups",
  setCaptains: "tournaments.manage.setCaptains",
  startDraft: "tournaments.manage.startDraft",
};

/** The groups the board is made of. Everything else on the panel is inline. */
type ManageGroup = "settings" | "players" | "teams" | "maps" | "organisers" | "series" | "chat";

const GROUP_LABELS: Record<ManageGroup, MessageKey> = {
  settings: "tournaments.manage.settings",
  players: "tournaments.manage.entrants",
  teams: "tournaments.manage.teams",
  maps: "tournaments.manage.maps",
  organisers: "tournaments.manage.organisers",
  series: "tournaments.manage.series",
  chat: "tournaments.manage.mutes",
};

const PHASE_HINTS: Record<TourneyPhase, MessageKey> = {
  formTeams: "tournaments.manage.formTeamsHint",
  startBracket: "tournaments.manage.startBracketHint",
  reopenSignups: "tournaments.manage.reopenSignupsHint",
  setCaptains: "tournaments.manage.setCaptainsHint",
  startDraft: "tournaments.manage.startDraftHint",
};

interface ManagePanelProps {
  event: Tourney;
  vault: VaultMap[];
  vaultStatus: MapListStatus;
  /** Every series, for the picker. */
  series: TourneySeries[];
  /** The other events, as candidates for a qualifier link. */
  events: Tourney[];
  /** Forwarded to `EntrantAdmin`, so the organiser's lists show people. */
  profiles: PlayerSummary[];
  /** Forwarded to `EntrantAdmin`'s name pickers. */
  accountSearch: AccountSearch;
  onSearchAccounts: (query: string) => void;
  busy: boolean;
  /** Save the settings. The form is inline here, so there is no dialog. */
  onEditInfo: (draft: TourneyDraft) => void;
  onPublish: () => void;
  onAdvance: (phase: TourneyPhase, config?: BracketConfig) => void;
  onArchive: () => void;
  onAssignPool: (roundKey: string, poolId: string) => void;
  onOpenUrl: (url: string) => void;
  onAddPlayer: (name: string, rating: number | null) => void;
  onSetCaptain: (teamId: string, playerId: string) => void;
  onMovePlayer: (playerId: string, teamId: string | null) => void;
  onEditPlayer: (playerId: string, note: string, rating: number | null) => void;
  onRespondSignup: (playerId: string, accept: boolean) => void;
  onRemovePlayer: (playerId: string) => void;
  onInvitePlayer: (name: string) => void;
  onUninvite: (fafId: number) => void;
  onReseed: (order: SeedOrder) => void;
  onSplitDivisions: (divisions: number) => void;
  onSetDivision: (teamId: string, division: number) => void;
  onSaveMap: (map: MapDraft) => void;
  onPublishMap: (mapId: string, published: boolean) => void;
  onDeleteMap: (mapId: string) => void;
  onMute: (fafId: number, name: string, muted: boolean) => void;
  onAddOrganiser: (fafId: number, name: string) => void;
  onSetOrganiserVisibility: (fafId: number, hidden: boolean) => void;
  onSetCaster: (fafId: number, name: string, casting: boolean) => void;
  onAbandon: (abandoned: boolean) => void;
  onEditFormat: (format: FormatDraft) => void;
  onSetSeries: (seriesId: string | null) => void;
  onSaveSeries: (draft: SeriesDraft) => void;
  onAddQualifier: (qualifierId: string, rule: QualifierRule) => void;
  onRemoveQualifier: (linkId: string) => void;
  onSavePool: (pool: PoolDraft) => void;
  onPublishPool: (poolId: string, published: boolean) => void;
  onDeletePool: (poolId: string) => void;
}

export function ManagePanel({
  event,
  vault,
  profiles,
  accountSearch,
  busy,
  onEditInfo,
  onPublish,
  onAdvance,
  onArchive,
  onAssignPool,
  onOpenUrl,
  ...rest
}: ManagePanelProps) {
  const { t } = useTranslation();
  // Reopening throws the teams away, so it is offered apart from the two steps
  // that move forward rather than beside them.
  // A draft event forms its teams by drafting, so `formTeams` is not offered
  // there and the draft section carries `startDraft` instead.
  const forward: TourneyPhase[] =
    event.formation === "draft" ? ["startBracket"] : ["formTeams", "startBracket"];
  const canReopen = isLegalFrom("reopenSignups", event.status) && event.teamCount > 0;
  /** Whether the bracket-setup dialog is open. */
  const [drawing, setDrawing] = useState(false);
  /** Which group is open, or null while the board is showing. */
  const [open, setOpen] = useState<ManageGroup | null>(null);

  /**
   * A tile on the board.
   *
   * The count is what makes the board worth looking at rather than a menu: an
   * organiser opens Players because there are four signups waiting, and the tile
   * can say so without being opened.
   */
  const tile = (group: ManageGroup, note?: string) => (
    <button
      type="button"
      className="tournament-tile tournament-tile-button"
      key={group}
      onClick={() => setOpen(group)}
    >
      <span className="tournament-tile-title">{t(GROUP_LABELS[group])}</span>
      {note !== undefined && <span className="muted">{note}</span>}
      <Icon name="chevronRight" size={16} />
    </button>
  );

  return (
    <div className="tournament-manage-panel">
      {drawing && (
        <BracketSetupDialog
          event={event}
          busy={busy}
          onClose={() => setDrawing(false)}
          onStart={(config) => {
            onAdvance("startBracket", config);
            setDrawing(false);
          }}
        />
      )}
      {open === null ? (
        <>
          {/* Stage one: what there is to work on, and nothing else. Each tile is
              a name and, where the service knows one, a number worth acting on. */}
          <div className="tournament-tiles">
            {tile("settings")}
            {tile(
              "players",
              t("tournaments.manage.playersNote", { count: event.players.length }),
            )}
            {mayShuffleTeams(event) && event.teams.length > 0 && tile("teams")}
            {tile("maps", t("tournaments.manage.mapsNote", { count: event.mapDb.length }))}
            {tile("organisers")}
            {tile("series")}
            {event.chatMutes.length > 0 &&
              tile("chat", t("tournaments.manage.chatNote", { count: event.chatMutes.length }))}
          </div>

          {/* Inline, not behind a tile: one button each, and the ones an organiser
              reaches for without looking. */}
          <div className="tournament-tiles">
            {/* One tile for the event's own state. Publishing was a section of its
                own and is really the first step of the same sequence: an unpublished
                event cannot be entered, so nothing below it matters yet. It keeps its
                warning colour, because it is the step people forget. */}
            <section
              className={
                mayPublish(event) ? "tournament-tile is-unpublished" : "tournament-tile"
              }
            >
              <h5>{t("tournaments.manage.lifecycle")}</h5>
              {mayPublish(event) && (
                <>
                  <p className="muted">{t("tournaments.manage.unpublishedHint")}</p>
                  <div className="tournament-detail-actions">
                    <Button variant="primary" disabled={busy} onClick={onPublish}>
                      <Icon name="eye" size={16} /> {t("tournaments.manage.publish")}
                    </Button>
                  </div>
                </>
              )}
              <div className="tournament-detail-actions">
                {forward
                  .filter((phase) => isLegalFrom(phase, event.status))
                  .map((phase) => (
                    <Button
                      key={phase}
                      variant="primary"
                      disabled={busy}
                      title={t(PHASE_HINTS[phase])}
                      // Drawing the bracket is the one step that asks a question
                      // first: the best-of per round, which only makes sense once the
                      // team count is known and is therefore never asked earlier.
                      onClick={() =>
                        phase === "startBracket" ? setDrawing(true) : onAdvance(phase)
                      }
                    >
                      {t(PHASE_LABELS[phase])}
                    </Button>
                  ))}
                {canReopen && (
                  <Button
                    disabled={busy}
                    title={t(PHASE_HINTS.reopenSignups)}
                    onClick={() => onAdvance("reopenSignups")}
                  >
                    {t(PHASE_LABELS.reopenSignups)}
                  </Button>
                )}
                {event.status === "running" && (
                  <span className="muted">{t("tournaments.manage.running")}</span>
                )}
                {event.status === "finished" && (
                  <span className="muted">{t("tournaments.manage.finished")}</span>
                )}
              </div>
            </section>

            <section className="tournament-tile">
              <h5>{t("tournaments.manage.website")}</h5>
              <ManageLink event={event} onOpen={onOpenUrl} />
            </section>

            {/* Last, and together: both of these end the event, and one tile is how
                the difference between them gets stated. Abandoning leaves it visible
                and says it was called off, and is reversible here; archiving hides it
                from everyone and only a site admin can undo that. */}
            <section className="tournament-tile is-danger">
              <h5>{t("tournaments.manage.ending")}</h5>
              <div className="tournament-step">
                <h6>{t("tournaments.manage.abandon")}</h6>
                <p className="tournament-step-hint muted">{t("tournaments.manage.abandonHint")}</p>
                <Button
                  disabled={busy}
                  onClick={() => {
                    if (event.abandoned) {
                      rest.onAbandon(false);
                      return;
                    }
                    if (window.confirm(t("tournaments.manage.abandonConfirm", { name: event.name }))) {
                      rest.onAbandon(true);
                    }
                  }}
                >
                  {event.abandoned
                    ? t("tournaments.manage.unabandon")
                    : t("tournaments.manage.abandon")}
                </Button>
              </div>
              <div className="tournament-step">
                <h6>{t("tournaments.manage.archive")}</h6>
                <p className="tournament-step-hint muted">{t("tournaments.manage.archiveHint")}</p>
                <Button
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(t("tournaments.manage.archiveConfirm", { name: event.name }))) {
                      onArchive();
                    }
                  }}
                >
                  {t("tournaments.manage.archive")}
                </Button>
              </div>
            </section>
          </div>
        </>
      ) : (
        <>
          {/* Stage two: one group, with a way back. */}
          <button type="button" className="tournament-back" onClick={() => setOpen(null)}>
            <Icon name="close" size={14} /> {t("tournaments.manage.back")}
          </button>

          {/* What the event *is*, and the form is the section rather than a
              button that opens the same form in a dialog on top of it. The
              format sits under it: both answer "what am I running", and the
              format is the half the service stops accepting at the draw. */}
          {open === "settings" && (
            <section className="tournament-tile is-wide">
              <h5>{t("tournaments.manage.settings")}</h5>
              <TournamentForm
                event={event}
                series={rest.series}
                busy={busy}
                inline
                onSubmit={onEditInfo}
                onClose={() => setOpen(null)}
              />
              {mayEditFormat(event) && (
                <div className="tournament-step">
                  <h6>{t("tournaments.manage.format")}</h6>
                  <FormatPanel event={event} busy={busy} onSave={rest.onEditFormat} />
                </div>
              )}
            </section>
          )}

          {open === "players" && (
          <section className="tournament-tile is-wide">
            <h5>{t("tournaments.manage.entrants")}</h5>
            <EntrantAdmin
              event={event}
              profiles={profiles}
              accountSearch={accountSearch}
              onSearchAccounts={rest.onSearchAccounts}
              busy={busy}
              onAdd={rest.onAddPlayer}
              onRespondSignup={rest.onRespondSignup}
              onRemove={rest.onRemovePlayer}
              onInvite={rest.onInvitePlayer}
              onUninvite={rest.onUninvite}
              onReseed={rest.onReseed}
              onSplit={rest.onSplitDivisions}
            />
          </section>
          )}

          {/* Only while the teams still decide anything: once the bracket is drawn
              the service refuses every one of these, because the draw was made from
              the teams. */}
          {open === "teams" && mayShuffleTeams(event) && event.teams.length > 0 && (
            <section className="tournament-tile is-wide">
              <h5>{t("tournaments.manage.teams")}</h5>
              <TeamAdmin
                event={event}
                profiles={profiles}
                busy={busy}
                onSetCaptain={rest.onSetCaptain}
                onMovePlayer={rest.onMovePlayer}
                onEditPlayer={rest.onEditPlayer}
                onSetDivision={rest.onSetDivision}
              />
            </section>
          )}

          {/* Three steps in a fixed order, and the order is shown rather than
              explained: a pool cannot be built out of maps the event does not
              have, and no round can be bound to a pool that does not exist. So
              the second step is inert until the database holds something and the
              third until a pool exists, the steps are numbered down the left,
              and the one that can be worked on is the one that is lit. Nobody
              has to read a sentence to find out what comes first. */}
          {open === "maps" && (
            <section className="tournament-tile is-wide">
              <h5>{t("tournaments.manage.maps")}</h5>
              <ol className="tournament-flow">
                <li className="tournament-flow-step is-open">
                  <h6>{t("tournaments.manage.mapsStepDb")}</h6>
                  <MapDbPanel
                    event={event}
                    vault={vault}
                    vaultStatus={rest.vaultStatus}
                    busy={busy}
                    onSave={rest.onSaveMap}
                    onPublish={rest.onPublishMap}
                    onDelete={rest.onDeleteMap}
                  />
                </li>
                <li
                  className={
                    event.mapDb.length === 0
                      ? "tournament-flow-step is-locked"
                      : "tournament-flow-step is-open"
                  }
                  aria-disabled={event.mapDb.length === 0}
                >
                  <h6>{t("tournaments.manage.mapsStepPool")}</h6>
                  <PoolEditor
                    event={event}
                    busy={busy}
                    onSave={rest.onSavePool}
                    onPublish={rest.onPublishPool}
                    onDelete={rest.onDeletePool}
                  />
                </li>
                <li
                  className={
                    event.mapPools.length === 0
                      ? "tournament-flow-step is-locked"
                      : "tournament-flow-step is-open"
                  }
                  aria-disabled={event.mapPools.length === 0}
                >
                  <h6>{t("tournaments.manage.mapsStepAssign")}</h6>
                  <MapPoolPanel
                    event={event}
                    vault={vault}
                    busy={busy}
                    onAssign={onAssignPool}
                    onSavePool={rest.onSavePool}
                  />
                </li>
              </ol>
            </section>
          )}

          {open === "organisers" && (
          <section className="tournament-tile">
            <h5>{t("tournaments.manage.organisers")}</h5>
            <OrganiserPanel
              event={event}
              accountSearch={accountSearch}
              busy={busy}
              onSearchAccounts={rest.onSearchAccounts}
              onAdd={rest.onAddOrganiser}
              onSetVisibility={rest.onSetOrganiserVisibility}
              onSetCaster={rest.onSetCaster}
            />
          </section>
          )}

          {open === "series" && (
          <section className="tournament-tile">
            <SeriesPanel
              event={event}
              series={rest.series}
              events={rest.events}
              busy={busy}
              onSetSeries={rest.onSetSeries}
              onSaveSeries={rest.onSaveSeries}
              onAddQualifier={rest.onAddQualifier}
              onRemoveQualifier={rest.onRemoveQualifier}
            />
          </section>
          )}

          {/* Who is silenced, and the way back. Muting happens on the post that
              prompted it; unmuting cannot, because a silenced account has nothing
              on screen to act on. */}
          {open === "chat" && event.chatMutes.length > 0 && (
            <section className="tournament-tile">
              <h5>{t("tournaments.manage.mutes")}</h5>
              <ul className="tournament-mute-list">
                {event.chatMutes.map((mute) => (
                  <li key={mute.fafId} className="tournament-mute">
                    <span>{mute.name}</span>
                    <Button
                      type="button"
                      disabled={busy}
                      onClick={() => rest.onMute(mute.fafId, mute.name, false)}
                    >
                      {t("tournaments.manage.unmute")}
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          )}

        </>
      )}
    </div>
  );
}

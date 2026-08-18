// The organiser's controls for an event that already exists.
//
// Only the steps that move the event along its own lifecycle, plus map pools
// and a door out to the website. Each step is offered only from the status the
// server takes it from: a button that answers "Form teams first" is worse than
// no button, because it reads as broken rather than as not-yet.

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
  onEdit: () => void;
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
  onEdit,
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
      <section>
        <h5>{t("tournaments.manage.settings")}</h5>
        <div className="tournament-detail-actions">
          <Button onClick={onEdit} disabled={busy}>
            <Icon name="settings" size={16} /> {t("tournaments.manage.edit")}
          </Button>
        </div>
      </section>

      {mayPublish(event) && (
        <section className="tournament-unpublished">
          <h5>{t("tournaments.manage.unpublished")}</h5>
          <p className="muted">{t("tournaments.manage.unpublishedHint")}</p>
          <div className="tournament-detail-actions">
            <Button variant="primary" disabled={busy} onClick={onPublish}>
              <Icon name="eye" size={16} /> {t("tournaments.manage.publish")}
            </Button>
          </div>
        </section>
      )}

      <section>
        <h5>{t("tournaments.manage.lifecycle")}</h5>
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

      <section>
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

      {/* Only while the teams still decide anything: once the bracket is drawn
          the service refuses every one of these, because the draw was made from
          the teams. */}
      {mayShuffleTeams(event) && event.teams.length > 0 && (
        <section>
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

      {mayEditFormat(event) && (
        <section>
          <h5>{t("tournaments.manage.format")}</h5>
          <FormatPanel event={event} busy={busy} onSave={rest.onEditFormat} />
        </section>
      )}

      <section>
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

      <section>
        <h5>{t("tournaments.manage.maps")}</h5>
        {/* Three steps, in the order they have to happen: put maps in the
            event's own database, group them into a pool with a ban/pick order,
            then bind that pool to a round of the draw. */}
        <MapDbPanel
          event={event}
          vault={vault}
          vaultStatus={rest.vaultStatus}
          busy={busy}
          onSave={rest.onSaveMap}
          onPublish={rest.onPublishMap}
          onDelete={rest.onDeleteMap}
        />
        <PoolEditor
          event={event}
          busy={busy}
          onSave={rest.onSavePool}
          onPublish={rest.onPublishPool}
          onDelete={rest.onDeletePool}
        />
        <MapPoolPanel event={event} vault={vault} busy={busy} onAssign={onAssignPool} />
      </section>

      {/* Who is silenced, and the way back. Muting happens on the post that
          prompted it; unmuting cannot, because a silenced account has nothing
          on screen to act on. */}
      {event.chatMutes.length > 0 && (
        <section>
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

      <section>
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

      <ManageLink event={event} onOpen={onOpenUrl} />

      {/* Last, and set apart: both of these end the event. Abandoning is the
          milder one and is reversible here, which is why it comes first and
          why the two are not the same button with a flag. */}
      <section className="tournament-danger">
        <h5>{t("tournaments.manage.abandon")}</h5>
        <p className="muted">{t("tournaments.manage.abandonHint")}</p>
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
      </section>

      <section className="tournament-danger">
        <h5>{t("tournaments.manage.archive")}</h5>
        <p className="muted">{t("tournaments.manage.archiveHint")}</p>
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
      </section>
    </div>
  );
}

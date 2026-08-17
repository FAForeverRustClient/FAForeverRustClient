// The organiser's controls for an event that already exists.
//
// Only the steps that move the event along its own lifecycle, plus map pools
// and a door out to the website. Each step is offered only from the status the
// server takes it from: a button that answers "Form teams first" is worse than
// no button, because it reads as broken rather than as not-yet.

import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import type { SeedOrder, Tourney, TourneyPhase, VaultMap } from "../../ipc/bindings";
import type { MessageKey } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";
import { EntrantAdmin } from "./EntrantAdmin";
import { MapPoolPanel, ManageLink } from "./MapPoolPanel";

/** Twin of `TourneyPhase::is_legal_from`. */
export function isLegalFrom(phase: TourneyPhase, status: Tourney["status"]): boolean {
  switch (phase) {
    case "formTeams":
      return status === "signup";
    case "startBracket":
      return status === "drafted";
    case "reopenSignups":
      return status === "signup" || status === "draft" || status === "drafted";
  }
}

const PHASE_LABELS: Record<TourneyPhase, MessageKey> = {
  formTeams: "tournaments.manage.formTeams",
  startBracket: "tournaments.manage.startBracket",
  reopenSignups: "tournaments.manage.reopenSignups",
};

const PHASE_HINTS: Record<TourneyPhase, MessageKey> = {
  formTeams: "tournaments.manage.formTeamsHint",
  startBracket: "tournaments.manage.startBracketHint",
  reopenSignups: "tournaments.manage.reopenSignupsHint",
};

interface ManagePanelProps {
  event: Tourney;
  vault: VaultMap[];
  busy: boolean;
  onEdit: () => void;
  onAdvance: (phase: TourneyPhase) => void;
  onArchive: () => void;
  onAssignPool: (roundKey: string, poolId: string) => void;
  onOpenUrl: (url: string) => void;
  onAddPlayer: (name: string, rating: number | null) => void;
  onRespondSignup: (playerId: string, accept: boolean) => void;
  onRemovePlayer: (playerId: string) => void;
  onInvitePlayer: (name: string) => void;
  onUninvite: (fafId: number) => void;
  onReseed: (order: SeedOrder) => void;
  onSplitDivisions: (divisions: number) => void;
}

export function ManagePanel({
  event,
  vault,
  busy,
  onEdit,
  onAdvance,
  onArchive,
  onAssignPool,
  onOpenUrl,
  ...rest
}: ManagePanelProps) {
  const { t } = useTranslation();
  // Reopening throws the teams away, so it is offered apart from the two steps
  // that move forward rather than beside them.
  const forward: TourneyPhase[] = ["formTeams", "startBracket"];
  const canReopen = isLegalFrom("reopenSignups", event.status) && event.teamCount > 0;

  return (
    <div className="tournament-manage-panel">
      <section>
        <h5>{t("tournaments.manage.settings")}</h5>
        <div className="tournament-detail-actions">
          <Button onClick={onEdit} disabled={busy}>
            <Icon name="settings" size={16} /> {t("tournaments.manage.edit")}
          </Button>
        </div>
      </section>

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
                onClick={() => onAdvance(phase)}
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

      <section>
        <h5>{t("tournaments.manage.maps")}</h5>
        <MapPoolPanel event={event} vault={vault} busy={busy} onAssign={onAssignPool} />
      </section>

      <ManageLink event={event} onOpen={onOpenUrl} />

      {/* Last, and set apart: archiving hides the event from everyone. It is
          reversible only by a site admin, which is exactly why it does not sit
          next to the buttons an organiser presses every day. */}
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

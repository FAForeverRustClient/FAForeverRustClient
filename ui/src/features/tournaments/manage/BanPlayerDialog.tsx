// Banning one entrant from the event, from their own row.
//
// Removing somebody alone was a revolving door: they signed up again. This bans
// them from this event and, where the service still lets an organiser take them
// out, removes them in the same step, which is what "kick" means. Once the
// bracket has started they stay in it; the ban only stops them entering again.

import { useState } from "react";
import { Button } from "../../../design-system/Button";
import { Modal } from "../../../design-system/Modal";
import type { Tourney, TourneyPlayer } from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";

/** Whether the service still lets an organiser take this entrant out. */
export function removableEntrant(event: Tourney, player: TourneyPlayer): boolean {
  return (
    event.status === "signup" ||
    ((event.status === "draft" || event.status === "drafted") && player.teamId === null)
  );
}

interface BanPlayerDialogProps {
  event: Tourney;
  player: TourneyPlayer;
  busy: boolean;
  onBan: (reason: string, expires: number | null, remove: boolean) => void;
  onClose: () => void;
}

export function BanPlayerDialog({ event, player, busy, onBan, onClose }: BanPlayerDialogProps) {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");
  const [expires, setExpires] = useState("");
  const remove = removableEntrant(event, player);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <Modal onClose={onClose} className="tournament-ban-dialog" ariaLabel={player.name}>
      <form
        className="tournament-ban-form"
        onSubmit={(submitted) => {
          submitted.preventDefault();
          const millis = expires === "" ? Number.NaN : Date.parse(`${expires}T00:00:00Z`);
          onBan(reason, Number.isNaN(millis) ? null : Math.floor(millis / 1000), remove);
        }}
      >
        <h3>{t("tournaments.bans.playerTitle", { name: player.name })}</h3>
        <p className="muted">{t("tournaments.bans.playerHint", { event: event.name })}</p>
        <label className="tournament-field">
          <span>{t("tournaments.bans.reason")}</span>
          <input
            value={reason}
            maxLength={300}
            autoFocus
            placeholder={t("tournaments.bans.reasonPlaceholder")}
            onChange={(changed) => setReason(changed.target.value)}
          />
        </label>
        <label className="tournament-field">
          <span>{t("tournaments.bans.expires")}</span>
          <input type="date" min={today} value={expires} onChange={(changed) => setExpires(changed.target.value)} />
          <small className="muted">{t("tournaments.bans.expiresHint")}</small>
        </label>
        <p className="muted">{t(remove ? "tournaments.bans.alsoRemoves" : "tournaments.bans.staysIn")}</p>
        <div className="tournament-form-actions">
          <Button type="button" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {t(remove ? "tournaments.bans.banAndRemove" : "tournaments.bans.banOnly")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// The one question worth asking before somebody enters a tournament.
//
// A Discord handle, and it is genuinely optional: the organiser needs a way to
// reach a player whose match is ready and who is not in the client, and the
// alternative to asking here is asking in the chat of an event that has already
// started. Skipping enters the tournament exactly as pressing Enter used to.
//
// The handle belongs to the account, not to this event: the service stores one
// per FAF id and shows it to the organisers and teammates of every tournament
// that account plays in. So the field is prefilled with whatever is already
// stored, and saving it here is the same write the website's own signup makes.

import { useState } from "react";
import { Button } from "../../design-system/Button";
import { Modal } from "../../design-system/Modal";
import { useTranslation } from "../../i18n/useTranslation";

interface SignUpDialogProps {
  /** The event being entered, for the heading. */
  name: string;
  /** The handle the service already has, or empty. */
  discord: string;
  busy: boolean;
  /** Enter, having saved the handle when it changed. */
  onConfirm: (discord: string | null) => void;
  onClose: () => void;
}

export function SignUpDialog({ name, discord, busy, onConfirm, onClose }: SignUpDialogProps) {
  const { t } = useTranslation();
  const [handle, setHandle] = useState(discord);

  // Only write when it changed. Sending the same value back would be a write
  // nobody asked for, and sending an untouched empty field would clear a handle
  // the player set on the website.
  const changed = handle.trim() !== discord.trim();

  return (
    <Modal onClose={onClose} ariaLabel={t("tournaments.signup.title")}>
      <form
        className="tournament-signup-dialog"
        onSubmit={(submitted) => {
          submitted.preventDefault();
          onConfirm(changed ? handle.trim() : null);
        }}
      >
        <h4>{t("tournaments.signup.title")}</h4>
        <p className="muted">{t("tournaments.signup.intro", { name })}</p>

        <label className="tournament-field">
          <span>{t("tournaments.signup.discord")}</span>
          <input
            value={handle}
            onChange={(changedField) => setHandle(changedField.target.value)}
            placeholder={t("tournaments.signup.discordPlaceholder")}
            maxLength={40}
            autoFocus
          />
        </label>
        {/* The distinction the website spells out too, because it is the one
            people get wrong: the handle, not the display name. A display name
            cannot be searched for in Discord. */}
        <p className="muted tournament-form-hint">{t("tournaments.signup.discordHint")}</p>

        <div className="tournament-match-actions">
          <Button type="submit" variant="primary" disabled={busy}>
            {t(changed ? "tournaments.signup.saveAndEnter" : "tournaments.signup.enter")}
          </Button>
          {/* Skip is not cancel: it enters the tournament without answering.
              Cancel is the modal's own close, which enters nothing. */}
          <Button disabled={busy} onClick={() => onConfirm(null)}>
            {t("tournaments.signup.skip")}
          </Button>
          <Button disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

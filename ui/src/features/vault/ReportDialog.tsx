// Reporting a map or a mod as offensive.
//
// The thread went back and forth on this and the mock-up on the issue settled
// it. Not a report that goes anywhere from here: moderation happens on the FAF
// Discord, and a button that posted into the client's own queue would either
// be ignored or become a second inbox for the same handful of people. What
// this does instead is remove the two things that make reporting from the
// client annoying -- working out where to go, and retyping which item you
// mean.
//
// So: the details, ready to copy in one click, a sentence saying what to do
// with them, and the way there.

import { useState } from "react";

import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { Modal } from "../../design-system/Modal";
import { ipc } from "../../ipc/client";
import { useTranslation } from "../../i18n/useTranslation";
import { openHttpsUrl } from "../../shared/externalLinks";
import "./report-dialog.css";

/**
 * Where reports are handled: the vault-support channel on the FAF Discord.
 *
 * A non-expiring invite, so it stays correct without anyone having to notice
 * that it stopped being. An invite rather than a `discord.com/channels` deep
 * link because it also works for somebody who is not on the server yet, which
 * is exactly the person who does not know where to report things.
 */
const REPORTS_DISCORD = "https://discord.gg/vvMBTncG3p";

/** One line of the copyable block: a label and what it says. */
export type ReportDetail = { label: string; value: string };

/**
 * The block the reporter pastes.
 *
 * Plain `label: value` lines rather than anything formatted: it is going into
 * a Discord message, where a table would arrive as a wall of pipes.
 */
export function reportDetailsText(kind: string, name: string, details: ReportDetail[]): string {
  return [
    `${kind}: ${name}`,
    ...details
      .filter((detail) => detail.value.trim().length > 0)
      .map((detail) => `${detail.label}: ${detail.value}`),
  ].join("\n");
}

export function ReportDialog({
  kind,
  name,
  details,
  onClose,
}: {
  /** "Mod" or "Map", already translated. */
  kind: string;
  name: string;
  details: ReportDetail[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const text = reportDetailsText(kind, name, details);

  return (
    <Modal className="report-dialog" ariaLabel={t("vault.report.title")} onClose={onClose}>
      <h2>{t("vault.report.title")}</h2>

      <div className="report-dialog-details">
        <pre>{text}</pre>
        <button
          type="button"
          className="report-dialog-copy"
          aria-label={t(copied ? "vault.report.copied" : "vault.report.copy")}
          title={t(copied ? "vault.report.copied" : "vault.report.copy")}
          onClick={() =>
            ipc.run(navigator.clipboard.writeText(text).then(() => setCopied(true)))
          }
        >
          <Icon name={copied ? "check" : "copy"} size={15} />
        </button>
      </div>

      {/* The instruction leads, in bold: what to actually do with the block
          above. The rest is the detail behind it, so it takes the muted
          weight the whole line used to have. */}
      <p className="report-dialog-hint muted">
        <strong>{t("vault.report.lead")}</strong> {t("vault.report.instructions")}
      </p>

      <div className="report-dialog-actions">
        <Button onClick={onClose}>{t("vault.report.cancel")}</Button>
        <Button variant="primary" onClick={() => ipc.run(openHttpsUrl(REPORTS_DISCORD))}>
          <Icon name="external" size={14} />
          {t("vault.report.headToDiscord")}
        </Button>
      </div>
    </Modal>
  );
}

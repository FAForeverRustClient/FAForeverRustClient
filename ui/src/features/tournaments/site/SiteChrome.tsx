// The site's chrome around the tournament list: the website's top bar
// (the pages beside the list, the console and the stand-down switch), the
// pending bar, and the three small dialogs those open.

import { useState } from "react";
import { Button } from "../../../design-system/Button";
import { Modal } from "../../../design-system/Modal";
import type { HostingStatus, PendingSummary, SiteWrite, TourneyAccount } from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";
import { pendingText, sectionForTab, type SitePage } from "./sitePages";

interface SiteNavProps {
  page: SitePage;
  account: TourneyAccount;
  busy: boolean;
  onPage: (page: SitePage) => void;
  onWrite: (write: SiteWrite) => void;
}

/**
 * The website's top bar, as buttons over the list: Hall of Fame, Series,
 * FAQ / Rules, Import for those who may, the console under the name of the
 * role that opens it, and a site admin's switch to see the site as a player.
 */
export function SiteNav({ page, account, busy, onPage, onWrite }: SiteNavProps) {
  const { t } = useTranslation();
  const [importing, setImporting] = useState(false);
  const role = account.siteAdmin
    ? "tournaments.site.siteAdmin"
    : account.director
      ? "tournaments.site.director"
      : account.editor
        ? "tournaments.site.editor"
        : null;
  const button = (target: SitePage, label: Parameters<typeof t>[0]) => (
    <Button
      variant={page.kind === target.kind ? "primary" : undefined}
      aria-current={page.kind === target.kind ? "page" : undefined}
      onClick={() => onPage(target)}
    >
      {t(label)}
    </Button>
  );
  return (
    <nav className="tournament-site-nav" aria-label={t("tournaments.site.nav")}>
      {button({ kind: "events" }, "tournaments.site.events")}
      {button({ kind: "hall" }, "tournaments.site.hall")}
      {button({ kind: "series", seriesId: null }, "tournaments.site.series")}
      {button({ kind: "faq", articleId: null }, "tournaments.site.faq")}
      {(account.siteAdmin || account.importer) && (
        <Button title={t("tournaments.site.importTitle")} onClick={() => setImporting(true)}>
          {t("tournaments.site.import")}
        </Button>
      )}
      {role !== null && (
        <Button
          variant={page.kind === "console" ? "primary" : undefined}
          title={t("tournaments.site.consoleTitle")}
          onClick={() => onPage({ kind: "console" })}
        >
          {t(role)}
        </Button>
      )}
      {account.siteAdminAccount && (
        <Button
          disabled={busy}
          className={account.adminStandDown ? "tournament-standdown is-off" : "tournament-standdown"}
          title={t(account.adminStandDown ? "tournaments.site.powersOffTitle" : "tournaments.site.powersOnTitle")}
          onClick={() => onWrite({ type: "standDown", payload: { on: !account.adminStandDown } })}
        >
          {t(account.adminStandDown ? "tournaments.site.powersOff" : "tournaments.site.powersOn")}
        </Button>
      )}
      {/* Editor and importer access are asked for here, as on the website's
          `/editor` and `/importer` pages; only for an account lacking one. */}
      {account.loggedIn && (!account.editor || !(account.importer || account.siteAdmin)) && (
        <Button
          variant={page.kind === "access" ? "primary" : undefined}
          title={t("tournaments.site.accessTitle")}
          onClick={() => onPage({ kind: "access", access: account.editor ? "importer" : "editor" })}
        >
          {t("tournaments.site.access")}
        </Button>
      )}
      {importing && (
        <ImportDialog
          busy={busy}
          onImport={(tournament, apiKey) => {
            onWrite({ type: "importChallonge", payload: { tournament, apiKey } });
            setImporting(false);
          }}
          onClose={() => setImporting(false)}
        />
      )}
    </nav>
  );
}

/** Pulling a finished Challonge tournament in: the website's import window. */
function ImportDialog({
  busy,
  onImport,
  onClose,
}: {
  busy: boolean;
  onImport: (tournament: string, apiKey: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [tournament, setTournament] = useState("");
  // Held only while the dialog is open and sent once; never stored.
  const [apiKey, setApiKey] = useState("");
  return (
    <Modal onClose={onClose} ariaLabel={t("tournaments.import.title")} className="tournament-form">
      <h3>{t("tournaments.import.title")}</h3>
      <p className="muted">{t("tournaments.import.hint")}</p>
      <label className="tournament-field">
        <span>{t("tournaments.import.link")}</span>
        <input value={tournament} placeholder="challonge.com/abc123" onChange={(changed) => setTournament(changed.target.value)} />
      </label>
      <label className="tournament-field">
        <span>{t("tournaments.import.key")}</span>
        <input
          type="password"
          autoComplete="off"
          value={apiKey}
          placeholder={t("tournaments.import.keyPlaceholder")}
          onChange={(changed) => setApiKey(changed.target.value)}
        />
        <small className="muted">{t("tournaments.import.keyNote")}</small>
      </label>
      <div className="tournament-form-actions">
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button
          variant="primary"
          disabled={busy || tournament.trim() === "" || apiKey.trim() === ""}
          onClick={() => onImport(tournament, apiKey)}
        >
          {t(busy ? "tournaments.import.importing" : "tournaments.import.go")}
        </Button>
      </div>
    </Modal>
  );
}

/**
 * Asking for hosting rights, where an account may not host yet: the website's
 * `hostAccessFlow`. A request already in says so and asks nothing.
 */
export function HostRequest({
  hosting,
  busy,
  onWrite,
}: {
  hosting: HostingStatus;
  busy: boolean;
  onWrite: (write: SiteWrite) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  if (!hosting.loggedIn || hosting.allowed) return null;
  return (
    <>
      <Button onClick={() => setOpen(true)}>{t("tournaments.host.request")}</Button>
      {open && (
        <Modal onClose={() => setOpen(false)} ariaLabel={t("tournaments.host.title")} className="tournament-form">
          {hosting.pending ? (
            <>
              <h3>{t("tournaments.host.sentTitle")}</h3>
              <p className="muted">{t("tournaments.host.sentHint")}</p>
              <div className="tournament-form-actions">
                <Button variant="primary" onClick={() => setOpen(false)}>
                  {t("common.close")}
                </Button>
              </div>
            </>
          ) : (
            <>
              <h3>{t("tournaments.host.title")}</h3>
              <p className="muted">{t("tournaments.host.hint")}</p>
              <label className="tournament-field">
                <span>{t("tournaments.host.message")}</span>
                <textarea
                  rows={4}
                  maxLength={300}
                  value={message}
                  placeholder={t("tournaments.host.placeholder")}
                  onChange={(changed) => setMessage(changed.target.value)}
                />
              </label>
              <div className="tournament-form-actions">
                <Button onClick={() => setOpen(false)}>{t("common.cancel")}</Button>
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => {
                    onWrite({ type: "requestAccess", payload: { kind: "host", message } });
                    setOpen(false);
                  }}
                >
                  {t("tournaments.host.send")}
                </Button>
              </div>
            </>
          )}
        </Modal>
      )}
    </>
  );
}

interface PendingBarProps {
  pending: PendingSummary;
  /** The open tournament, whose own items the bar leaves to its banner. */
  openId: string | null;
  onGo: (tournamentId: string, section: string) => void;
  onReview: () => void;
  onDismiss: () => void;
  /** Whether the console is on screen, where the alert would be noise. */
  inConsole: boolean;
}

/**
 * What waits on this account across every tournament: the website's pending
 * bar. The first item and how many more, with a way there; for a site admin
 * or a director, the access requests nobody has answered yet.
 */
export function PendingBar({ pending, openId, onGo, onReview, onDismiss, inConsole }: PendingBarProps) {
  const { t } = useTranslation();
  const items = pending.items.filter((item) => item.tournamentId !== openId);
  const first = items[0];
  const alert = pending.requests !== null && !inConsole;
  if (first === undefined && !alert) return null;
  return (
    <div className="tournament-pending">
      {first !== undefined && (
        <div className="tournament-pending-bar" role="status">
          <span>
            {"⚡"} {pendingText(first, t)} · <strong>{first.tournamentName}</strong>
          </span>
          <Button variant="primary" onClick={() => onGo(first.tournamentId, sectionForTab(first))}>
            {t("tournaments.pending.go")}
          </Button>
          {items.length > 1 && <span className="muted">{t("tournaments.pending.more", { count: items.length - 1 })}</span>}
        </div>
      )}
      {alert && (
        <div className="tournament-pending-bar is-admin" role="status">
          <span>
            {"\u{1F514}"}{" "}
            {t("tournaments.pending.accessRequests", { count: pending.requests ?? 1 })}
            {pending.newRequests !== null && pending.newRequests < (pending.requests ?? 0) && (
              <> {t("tournaments.pending.newRequests", { count: pending.newRequests })}</>
            )}
          </span>
          <Button onClick={onReview}>{t("tournaments.pending.review")}</Button>
          <button
            type="button"
            className="tournament-link-button"
            title={t("tournaments.pending.dismissTitle")}
            aria-label={t("tournaments.pending.dismiss")}
            onClick={onDismiss}
          >
            {"×"}
          </button>
        </div>
      )}
    </div>
  );
}

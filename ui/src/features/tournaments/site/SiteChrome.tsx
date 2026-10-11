// The site's chrome around the tournament list: the website's top bar
// (the pages beside the list, the console and the stand-down switch), the
// pending bar, and the hosting request's dialog.

import { useState, type ReactNode } from "react";
import { Button } from "../../../design-system/Button";
import { Modal } from "../../../design-system/Modal";
import { SectionTabs, type SectionTab } from "../../../design-system/SectionTabs";
import type { HostingStatus, PendingSummary, SiteWrite, TourneyAccount } from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";
import { pendingText, sectionForTab, type SitePage } from "./sitePages";

interface SiteNavProps {
  page: SitePage;
  account: TourneyAccount;
  busy: boolean;
  onPage: (page: SitePage) => void;
  onWrite: (write: SiteWrite) => void;
  /** The tab's own tools, at the far end of the tabs' rule. */
  children?: ReactNode;
}

type PageTab = SitePage["kind"];

/**
 * The website's top bar as the client's section tabs: the pages beside the
 * list (Hall of Fame, Series, FAQ / Rules), the console under the name of the
 * role that opens it, and where an account may ask for more, the access page.
 *
 * The Training tab's top: no page title above the tabs, which are the top of
 * the page, and at the far end of their rule whatever acts on the site rather
 * than opening a page of it (a site admin's stand-down switch, and the tab's
 * own tools passed in as children).
 */
export function SiteNav({ page, account, busy, onPage, onWrite, children }: SiteNavProps) {
  const { t } = useTranslation();
  const role = account.siteAdmin
    ? "tournaments.site.siteAdmin"
    : account.director
      ? "tournaments.site.director"
      : account.editor
        ? "tournaments.site.editor"
        : null;
  // Editor and importer access are asked for here, as on the website's
  // `/editor` and `/importer` pages; only for an account lacking one.
  const mayAsk = account.loggedIn && (!account.editor || !(account.importer || account.siteAdmin));
  const tabs: SectionTab<PageTab>[] = [
    { id: "events", label: t("tournaments.site.events") },
    { id: "hall", label: t("tournaments.site.hall") },
    { id: "series", label: t("tournaments.site.series") },
    { id: "faq", label: t("tournaments.site.faq") },
    ...(role !== null
      ? [{ id: "console" as const, label: <span title={t("tournaments.site.consoleTitle")}>{t(role)}</span> }]
      : []),
    ...(mayAsk
      ? [{
          id: "access" as const,
          label: <span title={t("tournaments.site.accessTitle")}>{t("tournaments.site.access")}</span>,
        }]
      : []),
  ];
  const target = (kind: PageTab): SitePage => {
    switch (kind) {
      case "series":
        return { kind, seriesId: null };
      case "faq":
        return { kind, articleId: null };
      case "access":
        return { kind, access: account.editor ? "importer" : "editor" };
      default:
        return { kind };
    }
  };
  return (
    <div className="tournaments-tabs-row">
      <SectionTabs
        active={page.kind}
        ariaLabel={t("tournaments.site.nav")}
        className="tournaments-site-tabs"
        items={tabs}
        onChange={(kind) => onPage(target(kind))}
      />
      <div className="tournaments-tabs-tools">
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
        {children}
      </div>
    </div>
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

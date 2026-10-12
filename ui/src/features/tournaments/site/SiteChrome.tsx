// The site's chrome around the tournament list: the website's top bar
// (the pages beside the list, the console and the stand-down switch), the
// pending bar, and the access request's dialog.

import { useState, type ReactNode } from "react";
import { Button } from "../../../design-system/Button";
import { Icon, type IconName } from "../../../design-system/Icon";
import { Modal } from "../../../design-system/Modal";
import { SectionTabs, type SectionTab } from "../../../design-system/SectionTabs";
import type { MessageKey } from "../../../i18n";
import type {
  AccessKind,
  AccessStatus,
  HostingStatus,
  PendingSummary,
  SiteWrite,
  TourneyAccount,
} from "../../../ipc/bindings";
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
 * list (Hall of Fame, Series, FAQ / Rules) and the console under the name of
 * the role that opens it. Asking for access is the button at the far end.
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
  const tabs: SectionTab<PageTab>[] = [
    { id: "events", label: t("tournaments.site.events") },
    { id: "hall", label: t("tournaments.site.hall") },
    { id: "series", label: t("tournaments.site.series") },
    { id: "faq", label: t("tournaments.site.faq") },
    ...(role !== null
      ? [{ id: "console" as const, label: <span title={t("tournaments.site.consoleTitle")}>{t(role)}</span> }]
      : []),
  ];
  const target = (kind: PageTab): SitePage => {
    switch (kind) {
      case "series":
        return { kind, seriesId: null };
      case "faq":
        return { kind, articleId: null };
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

type AccessState = "open" | "pending" | "approved";

const ACCESS_KINDS: { kind: AccessKind; icon: IconName; label: MessageKey; hint: MessageKey }[] = [
  { kind: "host", icon: "trophy", label: "tournaments.access.host", hint: "tournaments.access.hostHint" },
  { kind: "editor", icon: "book", label: "tournaments.access.editor", hint: "tournaments.access.editorHint" },
  { kind: "importer", icon: "download", label: "tournaments.access.importer", hint: "tournaments.access.importerHint" },
];

/**
 * Every kind of access an account can ask the site for, in one dialog behind
 * one button: hosting, editing the FAQ / Rules pages, and importing from
 * Challonge. The last two had a tab of their own, as wide in the navigation
 * as the Hall of Fame and shown to nearly every account, for two requests
 * hardly anybody makes; the first had this button. Each kind says whether it
 * is approved, waiting on the site admin, or there to ask for, and a request
 * is one kind and an optional note, as on the website.
 */
export function AccessRequest({
  hosting,
  account,
  editorAccess,
  importerAccess,
  busy,
  onOpen,
  onWrite,
}: {
  hosting: HostingStatus;
  account: TourneyAccount;
  editorAccess: AccessStatus;
  importerAccess: AccessStatus;
  busy: boolean;
  /** Read the editor and importer statuses afresh, as the dialog opens. */
  onOpen: () => void;
  onWrite: (write: SiteWrite) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<AccessKind | null>(null);
  const [message, setMessage] = useState("");
  const states: Record<AccessKind, AccessState> = {
    host: hosting.allowed ? "approved" : hosting.pending ? "pending" : "open",
    editor: account.editor || editorAccess.allowed ? "approved" : editorAccess.pending ? "pending" : "open",
    importer:
      account.importer || account.siteAdmin || importerAccess.allowed
        ? "approved"
        : importerAccess.pending
          ? "pending"
          : "open",
  };
  const askable = ACCESS_KINDS.filter(({ kind }) => states[kind] === "open");
  // Only for an account the site knows, with something left to ask for.
  if (!hosting.loggedIn || (states.host === "approved" && askable.length === 0)) return null;
  // A choice that has since been sent or approved is no choice any more.
  const choice = chosen !== null && states[chosen] === "open" ? chosen : (askable[0]?.kind ?? null);

  const close = () => {
    setOpen(false);
    setMessage("");
    setChosen(null);
  };

  return (
    <>
      <Button
        onClick={() => {
          onOpen();
          setOpen(true);
        }}
      >
        {t("tournaments.access.request")}
      </Button>
      {open && (
        <Modal onClose={close} ariaLabel={t("tournaments.access.request")} className="tournament-form tournament-access-dialog">
          <h3>{t("tournaments.access.request")}</h3>
          <p className="muted">{t("tournaments.access.intro")}</p>
          <div className="tournament-access-options" role="radiogroup" aria-label={t("tournaments.access.request")}>
            {ACCESS_KINDS.map(({ kind, icon, label, hint }) => {
              const state = states[kind];
              return (
                <label
                  key={kind}
                  className={[
                    "tournament-access-option",
                    state === "open" ? "" : "is-settled",
                    kind === choice ? "is-chosen" : "",
                  ].filter((name) => name !== "").join(" ")}
                >
                  <input
                    type="radio"
                    name="tournament-access-kind"
                    value={kind}
                    checked={kind === choice}
                    disabled={state !== "open"}
                    onChange={() => setChosen(kind)}
                  />
                  <span className="tournament-access-icon" aria-hidden>
                    <Icon name={icon} size={18} />
                  </span>
                  <span className="tournament-access-copy">
                    <strong>{t(label)}</strong>
                    <span>{t(hint)}</span>
                  </span>
                  {state !== "open" && (
                    <span className={`tournament-access-state is-${state}`}>
                      {state === "approved" && <Icon name="check" size={12} />}
                      {t(state === "approved" ? "tournaments.access.approved" : "tournaments.access.pending")}
                    </span>
                  )}
                </label>
              );
            })}
          </div>
          {choice !== null && (
            <label className="tournament-field">
              <span>{t("tournaments.access.message")}</span>
              <textarea
                rows={3}
                maxLength={300}
                value={message}
                placeholder={t(choice === "host" ? "tournaments.host.placeholder" : "tournaments.access.messagePlaceholder")}
                onChange={(changed) => setMessage(changed.target.value)}
              />
            </label>
          )}
          <div className="tournament-form-actions">
            <Button onClick={close}>{t(choice === null ? "common.close" : "common.cancel")}</Button>
            {choice !== null && (
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => {
                  onWrite({ type: "requestAccess", payload: { kind: choice, message } });
                  close();
                }}
              >
                {t("tournaments.host.send")}
              </Button>
            )}
          </div>
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

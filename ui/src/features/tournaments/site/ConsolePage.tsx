// The site administration and director console: the website's `/siteadmin`.
//
// What each role sees is what the server will accept from it, read from the
// console document's own `role`: a site admin everything, a director all but
// the site-admin list (and not Restore, which the server refuses a director
// although the website shows it), an editor the articles alone.
//
// Laid out as an admin page rather than the website's row of tabs: the
// sections down the left in three groups (who may do what, keeping order,
// the site's content), each with its count, and the open one beside them as
// cards in the tournament pages' own style. Pending requests are the one count
// that asks for something, so theirs is the only one in colour.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../../../design-system/Button";
import { Icon, type IconName } from "../../../design-system/Icon";
import { StatusNotice } from "../../../design-system/StatusNotice";
import type {
  AccessKind,
  AccessRequest,
  AccountSearch,
  AdminArticle,
  ListedAccount,
  SiteAdminData,
  SiteWrite,
  TourneyAccount,
  TourneyLoadStatus,
} from "../../../ipc/bindings";
import type { MessageKey } from "../../../i18n";
import { useTranslation } from "../../../i18n/useTranslation";
import { plainError } from "../../../shared/plainError";
import { RichText } from "../detail/RichText";
import { formatMoment, STATUS_LABELS } from "../tourneyPresentation";
import { AccountAdder, BanList } from "./BanList";
import { askConfirm } from "../tourneyDialogs";

type Tab = "requests" | "siteAdmins" | "directors" | "bans" | "logs" | "archived" | "articles";

type Tone = "ok" | "warn" | "error" | "muted";

const ACTION_LABELS: Record<string, { label: MessageKey; tone: Tone }> = {
  tournament_created: { label: "tournaments.console.logCreated", tone: "ok" },
  tournament_deleted: { label: "tournaments.console.logDeleted", tone: "error" },
  tournament_archived: { label: "tournaments.console.logArchived", tone: "muted" },
  tournament_restored: { label: "tournaments.console.logRestored", tone: "ok" },
  tournament_published: { label: "tournaments.console.logPublished", tone: "ok" },
  host_access_requested: { label: "tournaments.console.logRequested", tone: "warn" },
  host_access_granted: { label: "tournaments.console.logGranted", tone: "ok" },
  host_access_denied: { label: "tournaments.console.logDenied", tone: "error" },
  host_access_revoked: { label: "tournaments.console.logRevoked", tone: "error" },
};

/** The console's tabs for a role, in the website's order. */
export function consoleTabs(role: SiteAdminData["role"]): Tab[] {
  if (role === "editor") return ["articles"];
  const all: Tab[] = ["requests", "siteAdmins", "directors", "bans", "logs", "archived", "articles"];
  return role === "admin" ? all : all.filter((tab) => tab !== "siteAdmins");
}

/** The sections down the left, grouped; a group a role has nothing in is left out. */
const GROUPS: { label: MessageKey; tabs: Tab[] }[] = [
  { label: "tournaments.console.groupAccess", tabs: ["requests", "siteAdmins", "directors"] },
  { label: "tournaments.console.groupModeration", tabs: ["bans", "logs"] },
  { label: "tournaments.console.groupContent", tabs: ["archived", "articles"] },
];

const TAB_ICONS: Record<Tab, IconName> = {
  requests: "bell",
  siteAdmins: "shield",
  directors: "crown",
  bans: "userX",
  logs: "activity",
  archived: "folder",
  articles: "book",
};

const TAB_LABELS: Record<Tab, MessageKey> = {
  requests: "tournaments.console.tabRequests",
  siteAdmins: "tournaments.console.tabSiteAdmins",
  directors: "tournaments.console.tabDirectors",
  bans: "tournaments.console.tabBans",
  logs: "tournaments.console.tabLogs",
  archived: "tournaments.console.tabArchived",
  articles: "tournaments.console.tabArticles",
};

const ROLE_LABELS: Record<SiteAdminData["role"], MessageKey> = {
  admin: "tournaments.site.siteAdmin",
  director: "tournaments.site.director",
  editor: "tournaments.site.editor",
};

interface ConsoleProps {
  console: SiteAdminData | null;
  status: TourneyLoadStatus;
  account: TourneyAccount;
  assetBase: string;
  articleImage: string | null;
  accountSearch: AccountSearch;
  busy: boolean;
  onSearchAccounts: (query: string) => void;
  onWrite: (write: SiteWrite) => void;
  /** Read the console again, after a read that failed. */
  onRetry: () => void;
}

export function ConsolePage(props: ConsoleProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab | null>(null);
  const data = props.console;
  if (props.account.siteAdminAccount && props.account.adminStandDown) {
    return (
      <div className="tournament-console">
        <section className="tournament-panel tournament-console-off">
          <Icon name="lock" size={22} />
          <div>
            <h3>{t("tournaments.console.offTitle")}</h3>
            <p className="muted">{t("tournaments.console.offHint")}</p>
          </div>
          <Button variant="primary" onClick={() => props.onWrite({ type: "standDown", payload: { on: false } })}>
            {t("tournaments.console.switchOn")}
          </Button>
        </section>
      </div>
    );
  }
  if (props.status.type === "failed") {
    return (
      <StatusNotice
        tone="error"
        action={{ label: t("common.retry"), onClick: props.onRetry }}
        detail={props.status.payload.reason}
      >
        {plainError(props.status.payload.reason)}
      </StatusNotice>
    );
  }
  if (data === null) return <p className="muted">{t("tournaments.loading")}</p>;
  const tabs = consoleTabs(data.role);
  const shown = tab !== null && tabs.includes(tab) ? tab : tabs[0];
  const pending =
    data.hostRequests.filter((held) => held.status === "pending").length +
    data.editorRequests.filter((held) => held.status === "pending").length +
    data.importerRequests.filter((held) => held.status === "pending").length;
  const counts: Partial<Record<Tab, number>> = {
    requests: pending,
    siteAdmins: data.siteAdmins.length,
    directors: data.directors.length,
    bans: data.bans.filter((ban) => !ban.expired).length,
    archived: data.archived.length,
    articles: data.articles.filter((held) => !held.archived).length,
  };

  return (
    <div className="tournament-console">
      <header className="tournament-console-head">
        <span className="tournament-badge">{t(ROLE_LABELS[data.role])}</span>
        <h2>{t("tournaments.console.title")}</h2>
      </header>
      {data.role === "director" && (
        <p className="tournament-console-note">
          <Icon name="info" size={16} />
          <span>{t("tournaments.console.directorNote")}</span>
        </p>
      )}

      <div className={tabs.length > 1 ? "tournament-console-body" : "tournament-console-body is-single"}>
        {/* An editor has the articles and nothing else: no list of one. */}
        {tabs.length > 1 && (
          <nav className="tournament-console-nav" aria-label={t("tournaments.console.title")}>
            {GROUPS.map((group) => {
              const mine = group.tabs.filter((held) => tabs.includes(held));
              if (mine.length === 0) return null;
              return (
                <div className="tournament-console-nav-group" key={group.label}>
                  <span className="tournament-console-nav-label">{t(group.label)}</span>
                  {mine.map((held) => {
                    const count = counts[held];
                    return (
                      <button
                        type="button"
                        key={held}
                        className={held === shown ? "tournament-console-nav-item is-active" : "tournament-console-nav-item"}
                        aria-current={held === shown ? "page" : undefined}
                        onClick={() => setTab(held)}
                      >
                        <Icon name={TAB_ICONS[held]} size={16} />
                        <span className="tournament-console-nav-text">{t(TAB_LABELS[held])}</span>
                        {count !== undefined && (
                          <span
                            className={
                              held === "requests" && count > 0
                                ? "tournaments-group-count is-warn"
                                : "tournaments-group-count"
                            }
                          >
                            {count}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </nav>
        )}

        <div className="tournament-console-main">
          {shown === "requests" && <RequestsTab data={data} {...props} />}
          {shown === "siteAdmins" && (
            <ListTab
              title={t("tournaments.console.tabSiteAdmins")}
              hint={t("tournaments.console.siteAdminsHint")}
              empty={t("tournaments.console.siteAdminsNone")}
              addLabel={t("tournaments.console.makeSiteAdmin")}
              list={data.siteAdmins}
              me={data.me}
              {...props}
              onAdd={(fafId, name) => props.onWrite({ type: "siteAdminGrant", payload: { fafId, name } })}
              onRemove={(held) => {
                const mine = held.fafId === data.me;
                askConfirm(t(mine ? "tournaments.console.removeSelfAdmin" : "tournaments.console.removeAdmin"), () => {
                  props.onWrite({ type: "siteAdminRevoke", payload: { fafId: held.fafId } });
                }, { danger: true });
              }}
            />
          )}
          {shown === "directors" && (
            <ListTab
              title={t("tournaments.console.directorsTitle")}
              hint={`${t("tournaments.console.directorsHint")} ${t("tournaments.console.directorsHint2")}`}
              empty={t("tournaments.console.directorsNone")}
              addLabel={t("tournaments.console.makeDirector")}
              list={data.directors}
              me={data.me}
              {...props}
              onAdd={(fafId, name) => props.onWrite({ type: "directorGrant", payload: { fafId, name } })}
              onRemove={(held) => {
                const mine = held.fafId === data.me;
                askConfirm(
                  t(mine ? "tournaments.console.removeSelfDirector" : "tournaments.console.removeDirector"),
                  () => props.onWrite({ type: "directorRevoke", payload: { fafId: held.fafId } }),
                  { danger: true },
                );
              }}
            />
          )}
          {shown === "bans" && (
            <BanList
              className="tournament-panel tournament-console-section"
              title={t("tournaments.console.bansTitle")}
              hint={t("tournaments.console.bansHint")}
              addLabel={t("tournaments.console.ban")}
              bans={data.bans}
              search={props.accountSearch}
              busy={props.busy}
              onSearch={props.onSearchAccounts}
              onBan={(held, reason, expires) =>
                props.onWrite({ type: "globalBan", payload: { fafId: held.fafId, name: held.name, reason, expires } })
              }
              onLift={(fafId) => props.onWrite({ type: "globalUnban", payload: { fafId } })}
            />
          )}
          {shown === "logs" && <LogsTab data={data} />}
          {shown === "archived" && <ArchivedTab data={data} busy={props.busy} onWrite={props.onWrite} />}
          {shown === "articles" && <ArticlesTab data={data} {...props} />}
        </div>
      </div>
    </div>
  );
}

/**
 * One card of the console: a heading with its count, tools on the right, one
 * muted paragraph of what it is for, and its content.
 */
function ConsoleSection({
  title,
  count,
  tone,
  hint,
  tools,
  className,
  children,
}: {
  title: string;
  count?: number;
  tone?: "warn";
  hint?: ReactNode;
  tools?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <section className={["tournament-panel", "tournament-console-section", className ?? ""].join(" ").trim()}>
      <div className="tournament-console-section-head">
        <h4>
          {title}
          {count !== undefined && (
            <span className={tone === "warn" && count > 0 ? "tournaments-group-count is-warn" : "tournaments-group-count"}>
              {count}
            </span>
          )}
        </h4>
        {tools}
      </div>
      {hint !== undefined && <p className="muted tournament-console-hint">{hint}</p>}
      {children}
    </section>
  );
}

/** A sub-heading inside a card, with its count. */
function SubHead({ label, count }: { label: string; count?: number }) {
  return (
    <h5 className="tournament-console-subhead">
      {label}
      {count !== undefined && <span className="tournaments-group-count">{count}</span>}
    </h5>
  );
}

/**
 * One account on a line: an initial in a square, the name with its FAF id,
 * whatever is worth knowing about it underneath, and the buttons at the end.
 */
function AccountRow({
  name,
  fafId,
  badges,
  meta,
  note,
  children,
}: {
  name: string;
  fafId: number;
  badges?: ReactNode;
  meta?: ReactNode;
  note?: ReactNode;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <li className="tournament-console-row">
      <span className="tournament-console-avatar" aria-hidden>
        {(name.trim()[0] ?? "?").toLocaleUpperCase()}
      </span>
      <span className="tournament-console-who">
        <span className="tournament-console-name">
          <strong>{name}</strong>
          <span className="tournament-team-chip mono">{t("tournaments.console.fafId", { id: fafId })}</span>
          {badges}
        </span>
        {note !== undefined && <span className="tournament-console-quote">{note}</span>}
        {meta !== undefined && <span className="tournament-console-meta">{meta}</span>}
      </span>
      {children !== undefined && <span className="tournament-console-actions">{children}</span>}
    </li>
  );
}

function ListTab(
  props: ConsoleProps & {
    title: string;
    hint: string;
    empty: string;
    addLabel: string;
    list: ListedAccount[];
    me: number | null;
    onAdd: (fafId: number, name: string) => void;
    onRemove: (held: ListedAccount) => void;
  },
) {
  const { t } = useTranslation();
  return (
    <ConsoleSection title={props.title} count={props.list.length} hint={props.hint}>
      {props.list.length === 0 ? (
        <p className="muted">{props.empty}</p>
      ) : (
        <ul className="tournament-console-rows">
          {props.list.map((held) => (
            <AccountRow
              key={held.fafId}
              name={held.name}
              fafId={held.fafId}
              badges={
                <>
                  {held.fafId === props.me && <span className="tournament-badge is-ok">{t("tournaments.console.you")}</span>}
                  {held.standDown && <span className="tournament-badge is-warn">{t("tournaments.site.powersOff")}</span>}
                </>
              }
              meta={t("tournaments.console.added", { when: formatMoment(held.at, ""), by: held.by || "-" })}
            >
              <Button disabled={props.busy} onClick={() => props.onRemove(held)}>
                {t("tournaments.console.remove")}
              </Button>
            </AccountRow>
          ))}
        </ul>
      )}
      <div className="tournament-console-adder">
        <AccountAdder
          label={t("tournaments.organisers.fafName")}
          submitLabel={props.addLabel}
          search={props.accountSearch}
          busy={props.busy}
          onSearch={props.onSearchAccounts}
          onAdd={(account) => props.onAdd(account.id, account.login)}
        />
      </div>
    </ConsoleSection>
  );
}

function RequestsTab(props: ConsoleProps & { data: SiteAdminData }) {
  const { t } = useTranslation();
  const { data } = props;
  const base = props.assetBase.replace(/\/+$/, "");
  const queues: {
    kind: AccessKind;
    requests: AccessRequest[];
    allowed: ListedAccount[];
    heading: MessageKey;
    allowedLabel: MessageKey;
    grantLabel: MessageKey;
    intro: MessageKey | null;
    link: string | null;
  }[] = [
    {
      kind: "host",
      requests: data.hostRequests,
      allowed: data.hostAllowed,
      heading: "tournaments.console.hostingHeading",
      allowedLabel: "tournaments.console.allowedHost",
      grantLabel: "tournaments.console.allowHost",
      intro: null,
      link: null,
    },
    {
      kind: "editor",
      requests: data.editorRequests,
      allowed: data.editorAllowed,
      heading: "tournaments.console.editorsHeading",
      allowedLabel: "tournaments.console.allowedEditor",
      grantLabel: "tournaments.console.makeEditor",
      intro: "tournaments.console.editorsIntro",
      link: base === "" ? null : `${base}/editor`,
    },
    {
      kind: "importer",
      requests: data.importerRequests,
      allowed: data.importerAllowed,
      heading: "tournaments.console.importersHeading",
      allowedLabel: "tournaments.console.allowedImporter",
      grantLabel: "tournaments.console.makeImporter",
      intro: "tournaments.console.importersIntro",
      link: base === "" ? null : `${base}/importer`,
    },
  ];

  return (
    <>
      {!data.oauth && (
        <p className="tournament-console-note">
          <Icon name="info" size={16} />
          <span>{t("tournaments.console.noOauth")}</span>
        </p>
      )}
      {queues.map((queue) => {
        const waiting = queue.requests.filter((held) => held.status === "pending");
        const past = queue.requests.filter((held) => held.status !== "pending");
        return (
          <ConsoleSection
            key={queue.kind}
            className={`is-${queue.kind}`}
            title={t(queue.heading)}
            count={waiting.length}
            tone="warn"
            hint={queue.intro !== null ? t(queue.intro) : undefined}
          >
            {queue.link !== null && (
              <div className="tournament-console-link">
                <Icon name="external" size={14} />
                <input readOnly value={queue.link} onFocus={(focused) => focused.target.select()} />
                <Button onClick={() => void navigator.clipboard.writeText(queue.link ?? "")}>
                  <Icon name="copy" size={14} /> {t("tournaments.publish.copy")}
                </Button>
              </div>
            )}

            <div className="tournament-console-block">
              <SubHead label={t("tournaments.console.pendingRequests")} count={waiting.length} />
              {waiting.length === 0 ? (
                <p className="muted tournament-console-empty">{t("tournaments.console.nothingWaiting")}</p>
              ) : (
                <ul className="tournament-console-rows is-pending">
                  {waiting.map((held) => (
                    <AccountRow
                      key={held.id}
                      name={held.fafName}
                      fafId={held.fafId}
                      note={held.message !== "" ? held.message : undefined}
                      meta={formatMoment(held.at, "")}
                    >
                      <Button
                        variant="primary"
                        disabled={props.busy}
                        onClick={() =>
                          props.onWrite({ type: "decide", payload: { kind: queue.kind, id: held.id, approve: true } })
                        }
                      >
                        <Icon name="check" size={14} /> {t("tournaments.console.approve")}
                      </Button>
                      <Button
                        disabled={props.busy}
                        onClick={() =>
                          props.onWrite({ type: "decide", payload: { kind: queue.kind, id: held.id, approve: false } })
                        }
                      >
                        {t("tournaments.console.deny")}
                      </Button>
                    </AccountRow>
                  ))}
                </ul>
              )}
            </div>

            <div className="tournament-console-block">
              <SubHead label={t(queue.allowedLabel)} count={queue.allowed.length} />
              {queue.allowed.length === 0 ? (
                <p className="muted tournament-console-empty">{t("tournaments.console.nobodyYet")}</p>
              ) : (
                <ul className="tournament-console-rows">
                  {queue.allowed.map((held) => (
                    <AccountRow key={held.fafId} name={held.name} fafId={held.fafId} meta={formatMoment(held.at, "")}>
                      <Button
                        disabled={props.busy}
                        onClick={() => {
                          askConfirm(t("tournaments.console.revokeConfirm"), () => {
                            props.onWrite({ type: "revoke", payload: { kind: queue.kind, fafId: held.fafId } });
                          }, { danger: true });
                        }}
                      >
                        {t("tournaments.console.revoke")}
                      </Button>
                    </AccountRow>
                  ))}
                </ul>
              )}
              <div className="tournament-console-adder">
                <AccountAdder
                  label={t("tournaments.organisers.fafName")}
                  submitLabel={t(queue.grantLabel)}
                  search={props.accountSearch}
                  busy={props.busy}
                  onSearch={props.onSearchAccounts}
                  onAdd={(account) =>
                    props.onWrite({ type: "grant", payload: { kind: queue.kind, fafId: account.id, name: account.login } })
                  }
                />
              </div>
            </div>

            {/* The record, out of the way until it is wanted. */}
            {past.length > 0 && (
              <details className="tournament-console-past">
                <summary>
                  <Icon name="chevronRight" size={14} />
                  {t("tournaments.console.pastDecisions")}
                  <span className="tournaments-group-count">{past.length}</span>
                </summary>
                <table className="tournament-console-table">
                  <thead>
                    <tr>
                      <th>{t("tournaments.console.colAccount")}</th>
                      <th>{t("tournaments.console.colDecision")}</th>
                      <th>{t("tournaments.console.colDecided")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {past.map((held) => (
                      <tr key={held.id}>
                        <td>{held.fafName}</td>
                        <td>
                          <span
                            className={
                              held.status === "approved"
                                ? "tournament-console-tag is-ok"
                                : "tournament-console-tag is-error"
                            }
                          >
                            {t(held.status === "approved" ? "tournaments.console.approved" : "tournaments.console.denied")}
                          </span>
                        </td>
                        <td className="mono muted">
                          {formatMoment(held.decidedAt, "")}
                          {held.decidedBy !== "" && ` · ${held.decidedBy}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            )}
          </ConsoleSection>
        );
      })}
    </>
  );
}

function LogsTab({ data }: { data: SiteAdminData }) {
  const { t } = useTranslation();
  return (
    <ConsoleSection title={t("tournaments.console.logTitle")} count={data.logs.length} hint={t("tournaments.console.logHint")}>
      {data.logs.length === 0 ? (
        <p className="muted">{t("tournaments.console.logNone")}</p>
      ) : (
        <div className="tournament-console-table-wrap">
          <table className="tournament-console-table">
            <thead>
              <tr>
                <th>{t("tournaments.console.when")}</th>
                <th>{t("tournaments.console.action")}</th>
                <th>{t("tournaments.console.tournament")}</th>
                <th>{t("tournaments.console.who")}</th>
                <th>{t("tournaments.console.ipColumn")}</th>
              </tr>
            </thead>
            <tbody>
              {data.logs.map((entry) => {
                const known = ACTION_LABELS[entry.action];
                return (
                  <tr key={entry.id || `${entry.at}-${entry.action}`}>
                    <td className="mono muted tournament-console-nowrap">{formatMoment(entry.at, "")}</td>
                    <td>
                      <span className={`tournament-console-tag is-${known?.tone ?? "muted"}`}>
                        {known !== undefined ? t(known.label) : entry.action}
                      </span>
                    </td>
                    <td>{entry.tournamentName || entry.detail || "-"}</td>
                    <td>
                      {entry.actorName}
                      <span className="muted">
                        {entry.actorFafId !== null ? ` (${entry.actorFafId})` : ` (${entry.actorKind})`}
                      </span>
                    </td>
                    <td className="mono muted">{entry.ip}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </ConsoleSection>
  );
}

function ArchivedTab({
  data,
  busy,
  onWrite,
}: {
  data: SiteAdminData;
  busy: boolean;
  onWrite: (write: SiteWrite) => void;
}) {
  const { t } = useTranslation();
  return (
    <ConsoleSection
      title={t("tournaments.console.archivedTitle")}
      count={data.archived.length}
      hint={t("tournaments.console.archivedHint")}
    >
      {data.archived.length === 0 ? (
        <p className="muted">{t("tournaments.console.archivedNone")}</p>
      ) : (
        <div className="tournament-console-table-wrap">
          <table className="tournament-console-table">
            <thead>
              <tr>
                <th>{t("tournaments.console.tournament")}</th>
                <th>{t("tournaments.console.colStatus")}</th>
                <th>{t("tournaments.console.colPlayers")}</th>
                <th>{t("tournaments.console.colArchivedAt")}</th>
                {data.role === "admin" && <th />}
              </tr>
            </thead>
            <tbody>
              {data.archived.map((held) => (
                <tr key={held.id}>
                  <td>
                    <strong>{held.name}</strong>
                  </td>
                  <td>
                    <span className="tournament-console-tag is-muted">{t(STATUS_LABELS[held.status])}</span>
                  </td>
                  <td className="mono">{held.players}</td>
                  <td className="mono muted tournament-console-nowrap">{formatMoment(held.at, "")}</td>
                  {/* Restoring is a site admin's alone; the server refuses a
                      director, so a director is not offered it. */}
                  {data.role === "admin" && (
                    <td className="tournament-console-cell-actions">
                      <Button
                        disabled={busy}
                        onClick={() => onWrite({ type: "restore", payload: { tournamentId: held.id } })}
                      >
                        <Icon name="refresh" size={14} /> {t("tournaments.console.restore")}
                      </Button>
                      <Button
                        variant="danger"
                        disabled={busy}
                        onClick={() => {
                          askConfirm(t("tournaments.console.deleteConfirm"), () => {
                            onWrite({ type: "deleteTournament", payload: { tournamentId: held.id } });
                          }, { danger: true });
                        }}
                      >
                        <Icon name="trash" size={14} /> {t("tournaments.console.delete")}
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </ConsoleSection>
  );
}

/** One article being written, new or existing. */
interface ArticleDraft {
  id: string | null;
  title: string;
  body: string;
  parentId: string | null;
}

function ArticlesTab(props: ConsoleProps & { data: SiteAdminData }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<ArticleDraft | null>(null);
  const live = props.data.articles.filter((held) => !held.archived);
  const archived = props.data.articles.filter((held) => held.archived);
  const edit = (held: AdminArticle) =>
    setDraft({ id: held.id, title: held.title, body: held.body, parentId: held.parentId });

  // The pages as the FAQ shows them: each top-level page with its sub-pages
  // under it. A sub-page whose parent is archived or gone stands on its own.
  const liveIds = new Set(live.map((held) => held.id));
  const tops = live.filter((held) => held.parentId === null || !liveIds.has(held.parentId));
  const childrenOf = (id: string) => live.filter((held) => held.parentId === id);

  // While one is being written it has the page to itself: the list under an
  // editor this size was out of sight anyway.
  if (draft !== null) {
    return (
      <ArticleEditor
        draft={draft}
        articles={props.data.articles}
        assetBase={props.assetBase}
        articleImage={props.articleImage}
        busy={props.busy}
        onChange={setDraft}
        onSave={() => {
          props.onWrite({ type: "articleSave", payload: { ...draft } });
          setDraft(null);
        }}
        onUpload={(dataUrl) => props.onWrite({ type: "articleImage", payload: { dataUrl } })}
        onCancel={() => setDraft(null)}
      />
    );
  }

  const row = (held: AdminArticle, sub: boolean) => (
    <li key={held.id} className={sub ? "tournament-console-article is-sub" : "tournament-console-article"}>
      <Icon name={sub ? "chevronRight" : "book"} size={14} />
      <span className="tournament-console-who">
        <span className="tournament-console-name">
          <strong>{held.title}</strong>
          {held.parentId !== null && <span className="tournament-badge">{t("tournaments.console.subPage")}</span>}
        </span>
        <span className="tournament-console-meta">
          {t("tournaments.console.updated", { when: formatMoment(held.updatedAt, ""), id: held.id })}
        </span>
      </span>
      <span className="tournament-console-actions">
        <Button onClick={() => edit(held)}>
          <Icon name="edit" size={14} /> {t("tournaments.maps.edit")}
        </Button>
        <Button
          disabled={props.busy}
          onClick={() => {
            askConfirm(t("tournaments.console.archiveArticleConfirm"), () => {
              props.onWrite({ type: "articleArchive", payload: { id: held.id, restore: false } });
            }, { danger: true });
          }}
        >
          {t("tournaments.console.archive")}
        </Button>
      </span>
    </li>
  );

  return (
    <>
      <ConsoleSection
        title={t("tournaments.console.articlesTitle")}
        count={live.length}
        tools={
          <Button variant="primary" onClick={() => setDraft({ id: null, title: "", body: "", parentId: null })}>
            <Icon name="plus" size={14} /> {t("tournaments.console.newArticle")}
          </Button>
        }
      >
        {live.length === 0 ? (
          <p className="muted">{t("tournaments.console.articlesNone")}</p>
        ) : (
          <ul className="tournament-console-rows">
            {tops.flatMap((top) => [row(top, false), ...childrenOf(top.id).map((child) => row(child, true))])}
          </ul>
        )}
      </ConsoleSection>
      {archived.length > 0 && (
        <ConsoleSection
          title={t("tournaments.console.archivedArticles")}
          count={archived.length}
          hint={t("tournaments.console.archivedArticlesHint")}
        >
          <ul className="tournament-console-rows">
            {archived.map((held) => (
              <li key={held.id} className="tournament-console-article is-archived">
                <Icon name="folder" size={14} />
                <span className="tournament-console-who">
                  <span className="tournament-console-name">
                    <strong>{held.title}</strong>
                  </span>
                </span>
                <span className="tournament-console-actions">
                  <Button onClick={() => edit(held)}>
                    <Icon name="edit" size={14} /> {t("tournaments.maps.edit")}
                  </Button>
                  <Button
                    disabled={props.busy}
                    onClick={() => props.onWrite({ type: "articleArchive", payload: { id: held.id, restore: true } })}
                  >
                    <Icon name="refresh" size={14} /> {t("tournaments.console.restore")}
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </ConsoleSection>
      )}
    </>
  );
}

/** The article editor: title, parent page, markdown with a toolbar, preview beside it. */
function ArticleEditor({
  draft,
  articles,
  assetBase,
  articleImage,
  busy,
  onChange,
  onSave,
  onUpload,
  onCancel,
}: {
  draft: ArticleDraft;
  articles: AdminArticle[];
  assetBase: string;
  articleImage: string | null;
  busy: boolean;
  onChange: (draft: ArticleDraft) => void;
  onSave: () => void;
  onUpload: (dataUrl: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [waiting, setWaiting] = useState(false);
  // A page with sub-pages cannot become one itself, and pages nest one deep.
  const hasChildren = draft.id !== null && articles.some((held) => held.parentId === draft.id);
  const parents = articles.filter((held) => held.parentId === null && held.id !== draft.id && !held.archived);

  // An uploaded picture goes in where the cursor was, as the website inserts it.
  const latest = useRef(articleImage);
  useEffect(() => {
    if (!waiting || articleImage === null || articleImage === latest.current) return;
    latest.current = articleImage;
    setWaiting(false);
    const at = area.current?.selectionStart ?? draft.body.length;
    onChange({ ...draft, body: `${draft.body.slice(0, at)}\n![image](${articleImage})\n${draft.body.slice(at)}` });
  }, [articleImage, waiting, draft, onChange]);

  const wrap = (before: string, after = before) => {
    const field = area.current;
    const start = field?.selectionStart ?? draft.body.length;
    const end = field?.selectionEnd ?? start;
    const body = draft.body;
    onChange({ ...draft, body: `${body.slice(0, start)}${before}${body.slice(start, end)}${after}${body.slice(end)}` });
  };
  const upload = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setWaiting(true);
        onUpload(reader.result);
      }
    };
    reader.readAsDataURL(file);
  };
  const tool = (label: ReactNode, onClick: () => void, title?: string) => (
    <button type="button" title={title} onClick={onClick}>
      {label}
    </button>
  );
  return (
    <ConsoleSection
      className="tournament-console-editor"
      title={t(draft.id === null ? "tournaments.console.newArticle" : "tournaments.console.editArticle")}
      tools={
        <div className="tournament-console-section-tools">
          <Button onClick={onCancel}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={busy || draft.title.trim() === ""} onClick={onSave}>
            {t("tournaments.ffa.save")}
          </Button>
        </div>
      }
    >
      <div className="tournament-console-fields">
        <label className="tournament-field">
          <span>{t("tournaments.console.articleTitle")}</span>
          <input value={draft.title} maxLength={120} onChange={(changed) => onChange({ ...draft, title: changed.target.value })} />
        </label>
        <label className="tournament-field">
          <span>{t("tournaments.console.parent")}</span>
          <select
            value={draft.parentId ?? ""}
            disabled={hasChildren}
            onChange={(changed) => onChange({ ...draft, parentId: changed.target.value === "" ? null : changed.target.value })}
          >
            <option value="">{t("tournaments.console.topLevel")}</option>
            {parents.map((held) => (
              <option key={held.id} value={held.id}>
                {held.title}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="tournament-console-split">
        <div className="tournament-console-pane">
          <div className="tournament-console-pane-head">
            <span>{t("tournaments.console.body")}</span>
            <div className="tournament-round-nav tournament-console-toolbar">
              {tool(<strong>B</strong>, () => wrap("**"))}
              {tool(<em>I</em>, () => wrap("*"))}
              {tool(<u>U</u>, () => wrap("__"))}
              {tool("H1", () => wrap("# ", ""))}
              {tool("H2", () => wrap("## ", ""))}
              {tool(<Icon name="list" size={14} />, () => wrap("- ", ""), t("tournaments.console.list"))}
              {tool(t("tournaments.console.link"), () => wrap("[", "](https://)"))}
              <button type="button" disabled={busy} onClick={() => picker.current?.click()}>
                {t("tournaments.console.image")}
              </button>
            </div>
            <input
              ref={picker}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp,image/bmp"
              hidden
              onChange={(changed) => {
                const file = changed.target.files?.[0];
                changed.target.value = "";
                if (file !== undefined) upload(file);
              }}
            />
          </div>
          <textarea
            ref={area}
            rows={18}
            maxLength={20000}
            value={draft.body}
            aria-label={t("tournaments.console.body")}
            placeholder={t("tournaments.console.bodyPlaceholder")}
            onChange={(changed) => onChange({ ...draft, body: changed.target.value })}
            onPaste={(pasted) => {
              const file = [...pasted.clipboardData.files].find((held) => held.type.startsWith("image/"));
              if (file !== undefined) {
                pasted.preventDefault();
                upload(file);
              }
            }}
          />
          <small className="muted">{t("tournaments.console.bodyHint")}</small>
        </div>
        <div className="tournament-console-pane">
          <div className="tournament-console-pane-head">
            <span>{t("tournaments.console.preview")}</span>
          </div>
          <div className="tournament-article-preview tournament-console-preview">
            <RichText source={draft.body} assetBase={assetBase} />
          </div>
        </div>
      </div>
    </ConsoleSection>
  );
}

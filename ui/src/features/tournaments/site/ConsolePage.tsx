// The site administration and director console: the website's `/siteadmin`.
//
// What each role sees is what the server will accept from it, read from the
// console document's own `role`: a site admin everything, a director all but
// the site-admin list (and not Restore, which the server refuses a director
// although the website shows it), an editor the articles alone.

import { useEffect, useRef, useState } from "react";
import { Button } from "../../../design-system/Button";
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
import { RichText } from "../detail/RichText";
import { formatMoment, STATUS_LABELS } from "../tourneyPresentation";
import { AccountAdder, BanList } from "./BanList";

type Tab = "requests" | "siteAdmins" | "directors" | "bans" | "logs" | "archived" | "articles";

const ACTION_LABELS: Record<string, MessageKey> = {
  tournament_created: "tournaments.console.logCreated",
  tournament_deleted: "tournaments.console.logDeleted",
  tournament_archived: "tournaments.console.logArchived",
  tournament_restored: "tournaments.console.logRestored",
  tournament_published: "tournaments.console.logPublished",
  host_access_requested: "tournaments.console.logRequested",
  host_access_granted: "tournaments.console.logGranted",
  host_access_denied: "tournaments.console.logDenied",
  host_access_revoked: "tournaments.console.logRevoked",
};

/** The console's tabs for a role, in the website's order. */
export function consoleTabs(role: SiteAdminData["role"]): Tab[] {
  if (role === "editor") return ["articles"];
  const all: Tab[] = ["requests", "siteAdmins", "directors", "bans", "logs", "archived", "articles"];
  return role === "admin" ? all : all.filter((tab) => tab !== "siteAdmins");
}

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
}

export function ConsolePage(props: ConsoleProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab | null>(null);
  const data = props.console;
  if (props.account.siteAdminAccount && props.account.adminStandDown) {
    return (
      <div className="tournament-site-page">
        <section className="surface tournament-site-panel">
          <h3>{t("tournaments.console.offTitle")}</h3>
          <p className="muted">{t("tournaments.console.offHint")}</p>
          <Button variant="primary" onClick={() => props.onWrite({ type: "standDown", payload: { on: false } })}>
            {t("tournaments.console.switchOn")}
          </Button>
        </section>
      </div>
    );
  }
  if (props.status.type === "failed") return <p className="surface-error">{props.status.payload.reason}</p>;
  if (data === null) return <p className="muted">{t("tournaments.loading")}</p>;
  const tabs = consoleTabs(data.role);
  const shown = tab !== null && tabs.includes(tab) ? tab : tabs[0];
  const pending =
    data.hostRequests.filter((held) => held.status === "pending").length +
    data.editorRequests.filter((held) => held.status === "pending").length +
    data.importerRequests.filter((held) => held.status === "pending").length;
  const label: Record<Tab, string> = {
    requests: t("tournaments.console.tabRequests", { count: pending }),
    siteAdmins: t("tournaments.console.tabSiteAdmins", { count: data.siteAdmins.length }),
    directors: t("tournaments.console.tabDirectors", { count: data.directors.length }),
    bans: t("tournaments.console.tabBans", { count: data.bans.length }),
    logs: t("tournaments.console.tabLogs"),
    archived: t("tournaments.console.tabArchived", { count: data.archived.length }),
    articles: t("tournaments.console.tabArticles"),
  };
  return (
    <div className="tournament-site-page">
      <h2>
        {t("tournaments.console.title")}
        {data.role === "director" && <span className="muted"> {t("tournaments.console.asDirector")}</span>}
      </h2>
      {data.role === "director" && <p className="muted">{t("tournaments.console.directorNote")}</p>}
      <nav className="tournament-sections" aria-label={t("tournaments.console.title")}>
        {tabs.map((held) => (
          <button
            type="button"
            key={held}
            className={held === shown ? "tournament-section is-active" : "tournament-section"}
            aria-current={held === shown ? "page" : undefined}
            onClick={() => setTab(held)}
          >
            {label[held]}
          </button>
        ))}
      </nav>
      {shown === "requests" && <RequestsTab data={data} {...props} />}
      {shown === "siteAdmins" && (
        <ListTab
          title={t("tournaments.console.tabSiteAdmins", { count: data.siteAdmins.length })}
          hint={t("tournaments.console.siteAdminsHint")}
          empty={t("tournaments.console.siteAdminsNone")}
          addLabel={t("tournaments.console.makeSiteAdmin")}
          list={data.siteAdmins}
          me={data.me}
          {...props}
          onAdd={(fafId, name) => props.onWrite({ type: "siteAdminGrant", payload: { fafId, name } })}
          onRemove={(held) => {
            const mine = held.fafId === data.me;
            if (window.confirm(t(mine ? "tournaments.console.removeSelfAdmin" : "tournaments.console.removeAdmin"))) {
              props.onWrite({ type: "siteAdminRevoke", payload: { fafId: held.fafId } });
            }
          }}
        />
      )}
      {shown === "directors" && (
        <ListTab
          title={t("tournaments.console.directorsTitle", { count: data.directors.length })}
          hint={`${t("tournaments.console.directorsHint")} ${t("tournaments.console.directorsHint2")}`}
          empty={t("tournaments.console.directorsNone")}
          addLabel={t("tournaments.console.makeDirector")}
          list={data.directors}
          me={data.me}
          {...props}
          onAdd={(fafId, name) => props.onWrite({ type: "directorGrant", payload: { fafId, name } })}
          onRemove={(held) => {
            const mine = held.fafId === data.me;
            if (window.confirm(t(mine ? "tournaments.console.removeSelfDirector" : "tournaments.console.removeDirector"))) {
              props.onWrite({ type: "directorRevoke", payload: { fafId: held.fafId } });
            }
          }}
        />
      )}
      {shown === "bans" && (
        <BanList
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
      {shown === "logs" && (
        <section className="surface tournament-site-panel">
          <h3>{t("tournaments.console.logTitle")}</h3>
          <p className="muted">{t("tournaments.console.logHint")}</p>
          {data.logs.length === 0 ? (
            <p className="muted">{t("tournaments.console.logNone")}</p>
          ) : (
            <table className="tournament-standings">
              <thead>
                <tr>
                  <th>{t("tournaments.console.when")}</th>
                  <th>{t("tournaments.console.action")}</th>
                  <th>{t("tournaments.console.tournament")}</th>
                  <th>{t("tournaments.console.who")}</th>
                  <th>IP</th>
                </tr>
              </thead>
              <tbody>
                {data.logs.map((entry) => (
                  <tr key={entry.id || `${entry.at}-${entry.action}`}>
                    <td className="mono">{formatMoment(entry.at, "")}</td>
                    <td>{ACTION_LABELS[entry.action] !== undefined ? t(ACTION_LABELS[entry.action]) : entry.action}</td>
                    <td>{entry.tournamentName || entry.detail || "-"}</td>
                    <td>
                      {entry.actorName}
                      {entry.actorFafId !== null ? ` (${entry.actorFafId})` : ` (${entry.actorKind})`}
                    </td>
                    <td className="mono muted">{entry.ip}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
      {shown === "archived" && (
        <section className="surface tournament-site-panel">
          <h3>{t("tournaments.console.archivedTitle", { count: data.archived.length })}</h3>
          <p className="muted">{t("tournaments.console.archivedHint")}</p>
          {data.archived.length === 0 ? (
            <p className="muted">{t("tournaments.console.archivedNone")}</p>
          ) : (
            <table className="tournament-standings">
              <tbody>
                {data.archived.map((held) => (
                  <tr key={held.id}>
                    <td>{held.name}</td>
                    <td>{t(STATUS_LABELS[held.status])}</td>
                    <td className="mono">{held.players}</td>
                    <td className="mono">{formatMoment(held.at, "")}</td>
                    <td>
                      {/* Restoring is a site admin's alone; the server refuses a
                          director, so a director is not offered it. */}
                      {data.role === "admin" && (
                        <Button
                          disabled={props.busy}
                          onClick={() => props.onWrite({ type: "restore", payload: { tournamentId: held.id } })}
                        >
                          {t("tournaments.console.restore")}
                        </Button>
                      )}
                      {data.role === "admin" && (
                        <Button
                          variant="danger"
                          disabled={props.busy}
                          onClick={() => {
                            if (window.confirm(t("tournaments.console.deleteConfirm"))) {
                              props.onWrite({ type: "deleteTournament", payload: { tournamentId: held.id } });
                            }
                          }}
                        >
                          {t("tournaments.console.delete")}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
      {shown === "articles" && <ArticlesTab data={data} {...props} />}
    </div>
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
    <section className="surface tournament-site-panel">
      <h3>{props.title}</h3>
      <p className="muted">{props.hint}</p>
      {props.list.length === 0 ? (
        <p className="muted">{props.empty}</p>
      ) : (
        <ul className="tournament-organiser-list">
          {props.list.map((held) => (
            <li key={held.fafId} className="tournament-organiser">
              <span>
                {held.name} <span className="muted">{t("tournaments.console.fafId", { id: held.fafId })}</span>
                {held.fafId === props.me && <span className="tournament-badge">{t("tournaments.console.you")}</span>}
                {held.standDown && <span className="tournament-badge">{t("tournaments.site.powersOff")}</span>}
              </span>
              <span className="muted">
                {t("tournaments.console.added", { when: formatMoment(held.at, ""), by: held.by || "-" })}
              </span>
              <Button disabled={props.busy} onClick={() => props.onRemove(held)}>
                {t("tournaments.console.remove")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <AccountAdder
        label={t("tournaments.organisers.fafName")}
        submitLabel={props.addLabel}
        search={props.accountSearch}
        busy={props.busy}
        onSearch={props.onSearchAccounts}
        onAdd={(account) => props.onAdd(account.id, account.login)}
      />
    </section>
  );
}

function RequestsTab(props: ConsoleProps & { data: SiteAdminData }) {
  const { t } = useTranslation();
  const { data } = props;
  const queue = (
    kind: AccessKind,
    requests: AccessRequest[],
    allowed: ListedAccount[],
    heading: MessageKey,
    intro: MessageKey | null,
    link: string | null,
  ) => {
    const waiting = requests.filter((held) => held.status === "pending");
    const past = requests.filter((held) => held.status !== "pending");
    return (
      <section className={`surface tournament-site-panel is-${kind}`}>
        <h3>{t(heading)}</h3>
        {intro !== null && <p className="muted">{t(intro)}</p>}
        {link !== null && (
          <div className="tournament-detail-actions">
            <input className="tournament-share-link" readOnly value={link} onFocus={(focused) => focused.target.select()} />
            <Button onClick={() => void navigator.clipboard.writeText(link)}>{t("tournaments.publish.copy")}</Button>
          </div>
        )}
        <h4>{t("tournaments.console.pendingRequests", { count: waiting.length })}</h4>
        {waiting.length === 0 ? (
          <p className="muted">{t("tournaments.console.nothingWaiting")}</p>
        ) : (
          <ul className="tournament-organiser-list">
            {waiting.map((held) => (
              <li key={held.id} className="tournament-organiser">
                <span>
                  {held.fafName} <span className="muted">{t("tournaments.console.fafId", { id: held.fafId })}</span>
                </span>
                {held.message !== "" && <span className="muted">{held.message}</span>}
                <span className="muted">{formatMoment(held.at, "")}</span>
                <Button
                  variant="primary"
                  disabled={props.busy}
                  onClick={() => props.onWrite({ type: "decide", payload: { kind, id: held.id, approve: true } })}
                >
                  {t("tournaments.console.approve")}
                </Button>
                <Button
                  disabled={props.busy}
                  onClick={() => props.onWrite({ type: "decide", payload: { kind, id: held.id, approve: false } })}
                >
                  {t("tournaments.console.deny")}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <h4>
          {t(
            kind === "host"
              ? "tournaments.console.allowedHost"
              : kind === "editor"
                ? "tournaments.console.allowedEditor"
                : "tournaments.console.allowedImporter",
            { count: allowed.length },
          )}
        </h4>
        {allowed.length === 0 ? (
          <p className="muted">{t("tournaments.console.nobodyYet")}</p>
        ) : (
          <ul className="tournament-organiser-list">
            {allowed.map((held) => (
              <li key={held.fafId} className="tournament-organiser">
                <span>
                  {held.name} <span className="muted">{t("tournaments.console.fafId", { id: held.fafId })}</span>
                </span>
                <span className="muted">{formatMoment(held.at, "")}</span>
                <Button
                  disabled={props.busy}
                  onClick={() => {
                    if (window.confirm(t("tournaments.console.revokeConfirm"))) {
                      props.onWrite({ type: "revoke", payload: { kind, fafId: held.fafId } });
                    }
                  }}
                >
                  {t("tournaments.console.revoke")}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <AccountAdder
          label={t("tournaments.organisers.fafName")}
          submitLabel={t(
            kind === "host"
              ? "tournaments.console.allowHost"
              : kind === "editor"
                ? "tournaments.console.makeEditor"
                : "tournaments.console.makeImporter",
          )}
          search={props.accountSearch}
          busy={props.busy}
          onSearch={props.onSearchAccounts}
          onAdd={(account) => props.onWrite({ type: "grant", payload: { kind, fafId: account.id, name: account.login } })}
        />
        {past.length > 0 && (
          <>
            <h4>{t("tournaments.console.pastDecisions")}</h4>
            <table className="tournament-standings">
              <tbody>
                {past.map((held) => (
                  <tr key={held.id}>
                    <td>{held.fafName}</td>
                    <td>{t(held.status === "approved" ? "tournaments.console.approved" : "tournaments.console.denied")}</td>
                    <td className="mono">{formatMoment(held.decidedAt, "")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>
    );
  };
  const base = props.assetBase.replace(/\/+$/, "");
  return (
    <>
      {!data.oauth && <p className="muted">{t("tournaments.console.noOauth")}</p>}
      {queue("host", data.hostRequests, data.hostAllowed, "tournaments.console.hostingHeading", null, null)}
      {queue(
        "editor",
        data.editorRequests,
        data.editorAllowed,
        "tournaments.console.editorsHeading",
        "tournaments.console.editorsIntro",
        base === "" ? null : `${base}/editor`,
      )}
      {queue(
        "importer",
        data.importerRequests,
        data.importerAllowed,
        "tournaments.console.importersHeading",
        "tournaments.console.importersIntro",
        base === "" ? null : `${base}/importer`,
      )}
    </>
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
  return (
    <>
      <section className="surface tournament-site-panel">
        <h3>
          {t("tournaments.console.articlesTitle", { count: live.length })}{" "}
          <Button onClick={() => setDraft({ id: null, title: "", body: "", parentId: null })}>
            {t("tournaments.console.newArticle")}
          </Button>
        </h3>
        {live.length === 0 ? (
          <p className="muted">{t("tournaments.console.articlesNone")}</p>
        ) : (
          <ul className="tournament-organiser-list">
            {live.map((held) => (
              <li key={held.id} className="tournament-organiser">
                <span>
                  {held.parentId !== null && "↳ "}
                  {held.title}{" "}
                  {held.parentId !== null && <span className="tournament-badge">{t("tournaments.console.subPage")}</span>}
                </span>
                <span className="muted">
                  {t("tournaments.console.updated", { when: formatMoment(held.updatedAt, ""), id: held.id })}
                </span>
                <Button onClick={() => edit(held)}>{t("tournaments.maps.edit")}</Button>
                <Button
                  disabled={props.busy}
                  onClick={() => {
                    if (window.confirm(t("tournaments.console.archiveArticleConfirm"))) {
                      props.onWrite({ type: "articleArchive", payload: { id: held.id, restore: false } });
                    }
                  }}
                >
                  {t("tournaments.console.archive")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {archived.length > 0 && (
        <section className="surface tournament-site-panel">
          <h3>{t("tournaments.console.archivedArticles", { count: archived.length })}</h3>
          <p className="muted">{t("tournaments.console.archivedArticlesHint")}</p>
          <ul className="tournament-organiser-list">
            {archived.map((held) => (
              <li key={held.id} className="tournament-organiser">
                <span>{held.title}</span>
                <Button onClick={() => edit(held)}>{t("tournaments.maps.edit")}</Button>
                <Button
                  disabled={props.busy}
                  onClick={() => props.onWrite({ type: "articleArchive", payload: { id: held.id, restore: true } })}
                >
                  {t("tournaments.console.restore")}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {draft !== null && (
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
      )}
    </>
  );
}

/** The article editor: title, parent page, markdown with a toolbar, preview. */
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
  return (
    <section className="surface tournament-site-panel">
      <h3>{t(draft.id === null ? "tournaments.console.newArticle" : "tournaments.console.editArticle")}</h3>
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
      <div className="tournament-detail-actions">
        <Button onClick={() => wrap("**")}>B</Button>
        <Button onClick={() => wrap("*")}>I</Button>
        <Button onClick={() => wrap("__")}>U</Button>
        <Button onClick={() => wrap("# ", "")}>H1</Button>
        <Button onClick={() => wrap("## ", "")}>H2</Button>
        <Button onClick={() => wrap("- ", "")}>{t("tournaments.console.list")}</Button>
        <Button onClick={() => wrap("[", "](https://)")}>{t("tournaments.console.link")}</Button>
        <Button disabled={busy} onClick={() => picker.current?.click()}>
          {t("tournaments.console.image")}
        </Button>
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
      <label className="tournament-field">
        <span>{t("tournaments.console.body")}</span>
        <textarea
          ref={area}
          rows={14}
          maxLength={20000}
          value={draft.body}
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
      </label>
      <h4>{t("tournaments.console.preview")}</h4>
      <div className="surface tournament-article-preview">
        <RichText source={draft.body} assetBase={assetBase} />
      </div>
      <div className="tournament-detail-actions">
        <Button onClick={onCancel}>{t("common.cancel")}</Button>
        <Button variant="primary" disabled={busy || draft.title.trim() === ""} onClick={onSave}>
          {t("tournaments.ffa.save")}
        </Button>
      </div>
    </section>
  );
}

// The Hall of Fame, the FAQ / Rules pages and the access request screens:
// the website's `renderHall`, `renderFaq`, `renderEditor` and
// `renderImporter`, as pages of the Tournaments tab.

import { useState } from "react";
import { Button } from "../../../design-system/Button";
import type { AccessStatus, Article, HallOfFame, SiteWrite, TourneyLoadStatus } from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";
import { RichText } from "../detail/RichText";

/**
 * The Hall of Fame: players by championships, with a search over the names,
 * as on the website. There is no teams board (#444): a team is named and
 * formed anew for every tournament, so no team ever won twice and the board
 * only listed every winner once. The rank stays the player's place on the
 * whole board when the search narrows it.
 */
export function HallOfFamePage({ hall, status }: { hall: HallOfFame | null; status: TourneyLoadStatus }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  if (status.type === "failed") return <p className="surface-error">{status.payload.reason}</p>;
  if (hall === null) return <p className="muted">{t("tournaments.loading")}</p>;
  const needle = query.trim().toLocaleLowerCase();
  const ranked = hall.players.map((player, index) => ({ player, rank: index + 1 }));
  const shown = needle === "" ? ranked : ranked.filter(({ player }) => player.name.toLocaleLowerCase().includes(needle));
  return (
    <div className="tournament-site-page">
      <h2>{t("tournaments.site.hall")}</h2>
      <section className="surface tournament-site-panel">
        <h3>
          {t("tournaments.hall.players")} <span className="muted">{t("tournaments.hall.byTitles")}</span>
        </h3>
        {hall.players.length > 0 && (
          <label className="tournament-field">
            <span>{t("tournaments.hall.search")}</span>
            <input
              type="search"
              value={query}
              placeholder={t("tournaments.hall.searchPlaceholder")}
              onChange={(changed) => setQuery(changed.target.value)}
            />
          </label>
        )}
        {hall.players.length === 0 ? (
          <p className="muted">{t("tournaments.hall.noPlayers")}</p>
        ) : shown.length === 0 ? (
          <p className="muted">{t("tournaments.hall.noMatch")}</p>
        ) : (
          <table className="tournament-standings">
            <thead>
              <tr>
                <th>#</th>
                <th>{t("tournaments.hall.player")}</th>
                <th>{t("tournaments.hall.wins")}</th>
                <th>{t("tournaments.hall.entered")}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(({ player, rank }) => (
                <tr key={player.fafId}>
                  <td className="mono">{rank}</td>
                  <td>{player.name}</td>
                  <td className="mono">{player.wins}</td>
                  <td className="mono">{player.entered}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

/**
 * FAQ / Rules: every top-level article with its body and its sub-pages, or
 * one article on its own with a way back. One level of sub-pages, which is
 * all the service allows.
 */
export function FaqPage({
  articles,
  articleId,
  assetBase,
  siteAdmin,
  onOpen,
}: {
  articles: Article[];
  articleId: string | null;
  assetBase: string;
  siteAdmin: boolean;
  onOpen: (articleId: string | null) => void;
}) {
  const { t } = useTranslation();
  const children = (parent: string) => articles.filter((article) => article.parentId === parent);
  const subPages = (parent: string) => {
    const kids = children(parent);
    if (kids.length === 0) return null;
    return (
      <ul className="tournament-faq-sub">
        {kids.map((kid) => (
          <li key={kid.id}>
            <button type="button" className="tournament-link-button" onClick={() => onOpen(kid.id)}>
              {kid.title} {"→"}
            </button>
          </li>
        ))}
      </ul>
    );
  };
  const one = articleId === null ? undefined : articles.find((article) => article.id === articleId);
  if (one !== undefined) {
    return (
      <div className="tournament-site-page">
        <button type="button" className="tournament-link-button" onClick={() => onOpen(null)}>
          {"←"} {t("tournaments.faq.back")}
        </button>
        <section className="surface tournament-site-panel">
          <h2>{one.title}</h2>
          <RichText source={one.body} assetBase={assetBase} />
        </section>
        {children(one.id).length > 0 && (
          <section className="surface tournament-site-panel">
            <h3>{t("tournaments.faq.subPages")}</h3>
            {subPages(one.id)}
          </section>
        )}
      </div>
    );
  }
  const top = articles.filter((article) => article.parentId === null);
  return (
    <div className="tournament-site-page">
      <h2>{t("tournaments.site.faq")}</h2>
      {top.length === 0 && (
        <p className="muted">
          {t("tournaments.faq.empty")} {siteAdmin && t("tournaments.faq.emptyAdmin")}
        </p>
      )}
      {top.map((article) => (
        <section className="surface tournament-site-panel" key={article.id}>
          <h3>{article.title}</h3>
          <RichText source={article.body} assetBase={assetBase} />
          {subPages(article.id)}
        </section>
      ))}
    </div>
  );
}

/**
 * Asking for editor or importer access: the website's `/editor` and
 * `/importer` screens, for an account that does not have it yet.
 */
export function AccessPage({
  access,
  status,
  name,
  busy,
  onWrite,
  onSwitch,
}: {
  access: "editor" | "importer";
  status: AccessStatus;
  name: string;
  busy: boolean;
  onWrite: (write: SiteWrite) => void;
  /** Show the other kind of access. */
  onSwitch: (access: "editor" | "importer") => void;
}) {
  const { t } = useTranslation();
  const [message, setMessage] = useState("");
  const editor = access === "editor";
  const body = () => {
    if (!status.oauth) return <p className="muted">{t(editor ? "tournaments.access.noOauthEditor" : "tournaments.access.noOauthImporter")}</p>;
    if (!status.loggedIn) {
      return (
        <>
          <h3>{t("tournaments.access.loginTitle")}</h3>
          <p className="muted">{t(editor ? "tournaments.access.loginEditor" : "tournaments.access.loginImporter")}</p>
        </>
      );
    }
    if (status.allowed) {
      return (
        <>
          <h3>{t(editor ? "tournaments.access.haveEditor" : "tournaments.access.haveImporter")}</h3>
          <p className="muted">
            {t(editor ? "tournaments.access.whereEditor" : "tournaments.access.whereImporter")}
          </p>
        </>
      );
    }
    if (status.pending) {
      return (
        <>
          <h3>{t("tournaments.access.sentTitle")}</h3>
          <p className="muted">{t(editor ? "tournaments.access.sentEditor" : "tournaments.access.sentImporter")}</p>
        </>
      );
    }
    return (
      <>
        <h3>{t(editor ? "tournaments.access.askEditor" : "tournaments.access.askImporter")}</h3>
        <p className="muted">
          {t(editor ? "tournaments.access.askEditorHint" : "tournaments.access.askImporterHint", { name })}
        </p>
        <label className="tournament-field">
          <span>{t("tournaments.access.message")}</span>
          <textarea
            rows={3}
            maxLength={300}
            value={message}
            placeholder={t("tournaments.access.messagePlaceholder")}
            onChange={(changed) => setMessage(changed.target.value)}
          />
        </label>
        <Button
          variant="primary"
          disabled={busy}
          onClick={() => onWrite({ type: "requestAccess", payload: { kind: access, message } })}
        >
          {t("tournaments.access.request")}
        </Button>
      </>
    );
  };
  return (
    <div className="tournament-site-page">
      <nav className="tournament-sections" aria-label={t("tournaments.site.access")}>
        {(["editor", "importer"] as const).map((kind) => (
          <button
            type="button"
            key={kind}
            className={kind === access ? "tournament-section is-active" : "tournament-section"}
            aria-current={kind === access ? "page" : undefined}
            onClick={() => onSwitch(kind)}
          >
            {t(kind === "editor" ? "tournaments.access.tabEditor" : "tournaments.access.tabImporter")}
          </button>
        ))}
      </nav>
      <section className="surface tournament-site-panel">{body()}</section>
    </div>
  );
}

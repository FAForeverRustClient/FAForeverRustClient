// The Hall of Fame and the FAQ / Rules pages: the website's `renderHall` and
// `renderFaq`, as pages of the Tournaments tab. Its `renderEditor` and
// `renderImporter` screens are the access dialog behind the tab's Request
// access button (`SiteChrome`).

import { Icon } from "../../../design-system/Icon";
import { StatusNotice } from "../../../design-system/StatusNotice";
import type { Article, HallOfFame, HallPlayer, TourneyLoadStatus } from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";
import { PlayerName } from "../../../shared/components/nameColors";
import { useRememberedFilter } from "../../../shared/filterMemory";
import { usePlayerMenu } from "../../../shared/hooks/usePlayerMenu";
import { plainError } from "../../../shared/plainError";
import { leaderboardLabel } from "../../../shared/playerRatings";
import { RichText } from "../detail/RichText";

/**
 * The Hall of Fame: players by championships, with a search over the names,
 * as on the website, each row drawn as the leaderboard draws a player. There is no teams board (#444): a team is named and
 * formed anew for every tournament, so no team ever won twice and the board
 * only listed every winner once. The rank stays the player's place on the
 * whole board when the search narrows it.
 */
export function HallOfFamePage({
  hall,
  status,
  onRetry,
}: {
  hall: HallOfFame | null;
  status: TourneyLoadStatus;
  /** Read the board again, after a read that failed. */
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  // Remembered as the filter setting says (#447).
  const [query, setQuery] = useRememberedFilter("tournaments.hall", "", (value) => typeof value === "string");
  if (status.type === "failed") {
    return (
      <StatusNotice
        tone="error"
        action={{ label: t("common.retry"), onClick: onRetry }}
        detail={status.payload.reason}
      >
        {plainError(status.payload.reason)}
      </StatusNotice>
    );
  }
  if (hall === null) return <p className="muted">{t("tournaments.loading")}</p>;
  const needle = query.trim().toLocaleLowerCase();
  const ranked = hall.players.map((player, index) => ({ player, rank: index + 1 }));
  // Either name finds the row: the one the board recorded, and the one the
  // account goes by now.
  const shown = needle === ""
    ? ranked
    : ranked.filter(({ player }) =>
        [player.name, player.profile?.login ?? ""].some((name) => name.toLocaleLowerCase().includes(needle)));
  return (
    <div className="tournament-site-page">
      <h2>{t("tournaments.site.hall")}</h2>
      <section className="surface tournament-site-panel">
        <div className="tournament-hall-head">
          <h3>
            {t("tournaments.hall.players")} <span className="muted">{t("tournaments.hall.byTitles")}</span>
          </h3>
          {hall.players.length > 0 && (
            <label className="search-field tournament-hall-search">
              <Icon name="search" size={13} />
              <input
                type="search"
                value={query}
                placeholder={t("tournaments.hall.searchPlaceholder")}
                aria-label={t("tournaments.hall.search")}
                onChange={(changed) => setQuery(changed.target.value)}
              />
            </label>
          )}
        </div>
        {hall.players.length === 0 ? (
          <p className="muted">{t("tournaments.hall.noPlayers")}</p>
        ) : shown.length === 0 ? (
          <p className="muted">{t("tournaments.hall.noMatch")}</p>
        ) : (
          <HallTable rows={shown} />
        )}
      </section>
    </div>
  );
}

/**
 * The board's rows the way the leaderboard draws a player: the avatar, then
 * the name, which opens the player menu the chat's names open. The account is
 * FAF's and arrives a moment after the board, so a row draws without it first
 * and keeps the avatar's room either way. The name is the account's current
 * login, the one the menu and everybody else know; the name the board recorded
 * is the tooltip where the two differ.
 */
function HallTable({ rows }: { rows: { player: HallPlayer; rank: number }[] }) {
  const { t } = useTranslation();
  const { openPlayerMenu, playerMenu, playerMenuTarget } = usePlayerMenu();
  return (
    <>
      <table className="tournament-standings tournament-hall-table">
        <thead>
          <tr>
            <th className="tournament-hall-rank">#</th>
            <th>{t("tournaments.hall.player")}</th>
            <th className="is-number">{leaderboardLabel("global")}</th>
            <th className="is-number">{t("tournaments.hall.wins")}</th>
            <th className="is-number">{t("tournaments.hall.entered")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ player, rank }) => {
            const profile = player.profile;
            const login = profile?.login || player.name;
            const rating = profile === null ? "" : (profile.globalRating ?? t("common.notAvailable"));
            const open = playerMenuTarget !== null && playerMenuTarget === login;
            return (
              // The podium's hairline, for the champions at the top only: a
              // board searched down to one name keeps its rank, not its medal.
              <tr key={player.fafId} className={player.wins > 0 && rank <= 3 ? `rank-${rank}` : undefined}>
                <td className="tournament-hall-rank">{rank}</td>
                <td>
                  <span className="tournament-hall-player">
                    {profile?.avatarUrl ? (
                      <img
                        className="tournament-hall-avatar"
                        src={profile.avatarUrl}
                        alt=""
                        width={40}
                        height={20}
                        loading="lazy"
                        decoding="async"
                        draggable={false}
                      />
                    ) : (
                      <span className="tournament-hall-avatar" aria-hidden />
                    )}
                    <button
                      type="button"
                      className={open ? "tournament-hall-name is-menu-open" : "tournament-hall-name"}
                      aria-haspopup="menu"
                      aria-expanded={open}
                      title={login !== player.name ? t("tournaments.hall.playedAs", { name: player.name }) : undefined}
                      onClick={(event) => openPlayerMenu(login, event)}
                      onContextMenu={(event) => openPlayerMenu(login, event)}
                    >
                      <PlayerName name={login} />
                    </button>
                  </span>
                </td>
                <td className="is-number muted">{rating}</td>
                <td className="is-number">
                  <span className={player.wins > 0 ? "tournament-hall-wins is-champion" : "tournament-hall-wins"}>
                    {player.wins > 0 && <Icon name="trophy" size={13} />}
                    {player.wins}
                  </span>
                </td>
                <td className="is-number">{player.entered}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {playerMenu}
    </>
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

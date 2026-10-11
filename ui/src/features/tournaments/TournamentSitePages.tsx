// The tournament site's own pages, everything but the event list and detail:
// hall of fame, rules, access requests, the admin console, and the series.

import type { SiteWrite } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";
import { useAppStore } from "../../store/store";
import { AccessPage, FaqPage, HallOfFamePage } from "./site/SitePageViews";
import { SeriesIndex, SeriesPage } from "./site/SeriesPages";
import { ConsolePage } from "./site/ConsolePage";
import type { SitePage } from "./site/sitePages";
import { sitePageReads } from "./sitePageReads";
import { send } from "./tourneyCommands";

interface Props {
  page: SitePage;
  busy: boolean;
  setPage: (page: SitePage) => void;
  openPage: (page: SitePage) => void;
  openEventPage: (tournamentId: string) => void;
  siteWrite: (write: SiteWrite) => void;
}

export function TournamentSitePages({ page, busy, setPage, openPage, openEventPage, siteWrite }: Props) {
  const { t } = useTranslation();
  const site = useAppStore((store) => store.state.tourney.site);
  const articles = useAppStore((store) => store.state.tourney.articles);
  const assetBase = useAppStore((store) => store.state.tourney.assetBase);
  const accountSearch = useAppStore((store) => store.state.tourney.accountSearch);
  const openSeries = useAppStore((store) => store.state.tourney.openSeries);
  const series = useAppStore((store) => store.state.tourney.series);
  // A page's Retry is the reads that opening it sent, sent again.
  const reread = () => {
    for (const read of sitePageReads(page)) send(read);
  };

  return (
    <>
      {page.kind === "hall" && <HallOfFamePage hall={site.hall} status={site.hallStatus} onRetry={reread} />}
      {page.kind === "faq" && (
        <FaqPage
          articles={articles}
          articleId={page.articleId}
          assetBase={assetBase}
          siteAdmin={site.account.siteAdmin}
          onOpen={(articleId) => setPage({ kind: "faq", articleId })}
        />
      )}
      {page.kind === "access" && (
        <AccessPage
          access={page.access}
          status={page.access === "editor" ? site.editorAccess : site.importerAccess}
          name={site.account.fafName}
          busy={busy}
          onWrite={siteWrite}
          onSwitch={(access) => openPage({ kind: "access", access })}
        />
      )}
      {page.kind === "console" && (
        <ConsolePage
          console={site.console}
          status={site.consoleStatus}
          account={site.account}
          assetBase={assetBase}
          articleImage={site.articleImage}
          accountSearch={accountSearch}
          busy={busy}
          onSearchAccounts={(query) => send({ type: "searchAccounts", payload: { query } })}
          onWrite={siteWrite}
          onRetry={reread}
        />
      )}
      {page.kind === "series" &&
        (page.seriesId !== null && openSeries !== null && openSeries.id === page.seriesId ? (
          <SeriesPage
            key={openSeries.id}
            series={openSeries}
            assetBase={assetBase}
            busy={busy}
            accountSearch={accountSearch}
            onSearchAccounts={(query) => send({ type: "searchAccounts", payload: { query } })}
            onBack={() => openPage({ kind: "series", seriesId: null })}
            onOpenEvent={(tournamentId) => openEventPage(tournamentId)}
            onWrite={siteWrite}
            onSave={(draft) =>
              send({ type: "saveSeries", payload: { draft: { id: page.seriesId ?? "", ...draft } } })
            }
            onDelete={() => {
              send({ type: "deleteSeries", payload: { seriesId: page.seriesId ?? "" } });
              openPage({ kind: "series", seriesId: null });
            }}
          />
        ) : page.seriesId !== null ? (
          <p className="muted">{t("tournaments.loading")}</p>
        ) : (
          <SeriesIndex
            series={series}
            mayCreate={site.account.allowed || site.account.siteAdmin || site.account.director}
            busy={busy}
            onOpen={(seriesId) => openPage({ kind: "series", seriesId })}
            onCreate={(name) =>
              send({
                type: "saveSeries",
                payload: { draft: { id: "", name, description: "", colour: "plain", category: null } },
              })
            }
          />
        ))}
    </>
  );
}

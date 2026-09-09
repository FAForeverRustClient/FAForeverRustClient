import { useEffect, useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { ipc } from "../../ipc/client";
import type { LeaderboardMode } from "../../ipc/bindings";
import { useAppStore } from "../../store/store";
import { LeagueLeaderboardPanel, LeagueSeasonToolbar } from "./LeagueLeaderboardPanel";
import { RatingLeaderboardPanel } from "./RatingLeaderboardPanel";
import { RatingExplainerPanel } from "./RatingExplainer";
import "./leaderboard.css";
import { useTranslation } from "../../i18n/useTranslation";

const setMode = (mode: LeaderboardMode) => ipc.send({
  kind: "Leaderboard",
  command: { type: "setMode", payload: { mode } },
});
const selectSeason = (seasonId: number) => ipc.send({
  kind: "Leaderboard",
  command: { type: "selectSeason", payload: { seasonId } },
});
const loadCatalog = () => ipc.send({ kind: "Leaderboard", command: { type: "loadCatalog" } });

export function LeaderboardView() {
  const { t } = useTranslation();
  const state = useAppStore((store) => store.state.leaderboard);
  // A third tab beside Ratings and Leagues, held here rather than in
  // `LeaderboardMode`. That enum is a domain type mirrored into the store and
  // the conformance fixture, and a page of prose is not a thing the backend
  // has an opinion about: nothing is fetched for it and nothing about it can
  // be stale.
  const [explaining, setExplaining] = useState(false);
  const showTable = !explaining;
  const currentSeason = state.seasons.find((season) => season.id === state.selectedSeasonId) ?? null;

  useEffect(() => {
    if (useAppStore.getState().state.leaderboard.catalogStatus.type === "idle") void loadCatalog();
  }, []);

  return (
    <div className="leaderboard-view">
      <header className="leaderboard-header">
        <div className="leaderboard-header-actions">
          <div className="leaderboard-mode" role="group" aria-label={t("leaderboard.view.leaderboardMode")}>
            <Button
              variant={showTable && state.mode === "ratings" ? "primary" : "ghost"}
              onClick={() => { setExplaining(false); void setMode("ratings"); }}
            >
              <Icon name="activity" size={16} /> {t("leaderboard.view.ratings")}
            </Button>
            <Button
              variant={showTable && state.mode === "leagues" ? "primary" : "ghost"}
              onClick={() => { setExplaining(false); void setMode("leagues"); }}
            >
              <Icon name="leaderboard" size={16} /> {t("leaderboard.view.leagues")}
            </Button>
            <Button
              variant={explaining ? "primary" : "ghost"}
              onClick={() => setExplaining(true)}
            >
              <Icon name="info" size={16} /> {t("leaderboard.rating.explainShort")}
            </Button>
          </div>
        </div>
        {showTable && state.mode === "leagues" && currentSeason && (
          <LeagueSeasonToolbar
            currentSeason={currentSeason}
            seasons={state.seasons}
            selectedSeasonId={state.selectedSeasonId}
            disabled={state.seasonsStatus.type === "loading"}
            onChange={(seasonId) => void selectSeason(seasonId)}
          />
        )}
      </header>

      {showTable && state.catalogStatus.type === "loading" && <div className="leaderboard-state muted">Loading leaderboard catalog…</div>}
      {showTable && state.catalogStatus.type === "failed" && (
        <div className="leaderboard-catalog-error surface-error">
          <span>{state.catalogStatus.payload.reason}</span>
          <Button onClick={() => void loadCatalog()}><Icon name="refresh" size={16} /> {t("leaderboard.view.retry")}</Button>
        </div>
      )}
      {explaining && <RatingExplainerPanel />}
      {showTable && state.catalogStatus.type === "ready" && state.mode === "ratings" && <RatingLeaderboardPanel />}
      {showTable && state.catalogStatus.type === "ready" && state.mode === "leagues" && <LeagueLeaderboardPanel />}
    </div>
  );
}

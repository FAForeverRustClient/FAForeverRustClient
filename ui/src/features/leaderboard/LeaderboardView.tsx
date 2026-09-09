import { useEffect, useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { ipc } from "../../ipc/client";
import type { LeaderboardMode } from "../../ipc/bindings";
import { useAppStore } from "../../store/store";
import { LeagueLeaderboardPanel, LeagueSeasonToolbar } from "./LeagueLeaderboardPanel";
import { RatingLeaderboardPanel } from "./RatingLeaderboardPanel";
import { RatingExplainerButton, RatingExplainerDialog } from "./RatingExplainer";
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
  const [explaining, setExplaining] = useState(false);
  const currentSeason = state.seasons.find((season) => season.id === state.selectedSeasonId) ?? null;

  useEffect(() => {
    if (useAppStore.getState().state.leaderboard.catalogStatus.type === "idle") void loadCatalog();
  }, []);

  return (
    <div className="leaderboard-view">
      <header className="leaderboard-header">
        <div className="leaderboard-header-actions">
          <div className="leaderboard-mode" role="group" aria-label={t("leaderboard.view.leaderboardMode")}>
            <Button variant={state.mode === "ratings" ? "primary" : "ghost"} onClick={() => void setMode("ratings")}>
              <Icon name="activity" size={16} /> {t("leaderboard.view.ratings")}
            </Button>
            <Button variant={state.mode === "leagues" ? "primary" : "ghost"} onClick={() => void setMode("leagues")}>
              <Icon name="leaderboard" size={16} /> {t("leaderboard.view.leagues")}
            </Button>
          </div>
          {/* Beside the two modes rather than as a third one: what a rating is
              made of is the same answer on both of these tables, and it is
              prose rather than something the backend has an opinion about. */}
          <RatingExplainerButton onOpen={() => setExplaining(true)} />
        </div>
        {state.mode === "leagues" && currentSeason && (
          <LeagueSeasonToolbar
            currentSeason={currentSeason}
            seasons={state.seasons}
            selectedSeasonId={state.selectedSeasonId}
            disabled={state.seasonsStatus.type === "loading"}
            onChange={(seasonId) => void selectSeason(seasonId)}
          />
        )}
      </header>

      {state.catalogStatus.type === "loading" && <div className="leaderboard-state muted">Loading leaderboard catalog…</div>}
      {state.catalogStatus.type === "failed" && (
        <div className="leaderboard-catalog-error surface-error">
          <span>{state.catalogStatus.payload.reason}</span>
          <Button onClick={() => void loadCatalog()}><Icon name="refresh" size={16} /> {t("leaderboard.view.retry")}</Button>
        </div>
      )}
      {state.catalogStatus.type === "ready" && state.mode === "ratings" && <RatingLeaderboardPanel />}
      {state.catalogStatus.type === "ready" && state.mode === "leagues" && <LeagueLeaderboardPanel />}
      {explaining && <RatingExplainerDialog onClose={() => setExplaining(false)} />}
    </div>
  );
}

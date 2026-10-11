import { useEffect, useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { Modal } from "../../design-system/Modal";
import { SectionTabs } from "../../design-system/SectionTabs";
import { StatusNotice } from "../../design-system/StatusNotice";
import { ipc } from "../../ipc/client";
import type { LeaderboardMode } from "../../ipc/bindings";
import { useAppStore } from "../../store/store";
import { LeagueLeaderboardPanel } from "./LeagueLeaderboardPanel";
import { RatingLeaderboardPanel } from "./RatingLeaderboardPanel";
import { RatingExplainerPanel } from "./RatingExplainer";
import "./leaderboard.css";
import { useTranslation } from "../../i18n/useTranslation";
import { plainError } from "../../shared/plainError";

const setMode = (mode: LeaderboardMode) => ipc.send({
  kind: "Leaderboard",
  command: { type: "setMode", payload: { mode } },
});
const loadCatalog = () => ipc.send({ kind: "Leaderboard", command: { type: "loadCatalog" } });

export function LeaderboardView() {
  const { t } = useTranslation();
  const state = useAppStore((store) => store.state.leaderboard);
  // Held here rather than in `LeaderboardMode`: a page of prose is not a
  // thing the backend has an opinion about, and nothing is fetched for it.
  const [explaining, setExplaining] = useState(false);

  // The service ignores this once the catalogue is loaded or being loaded.
  useEffect(() => {
    void loadCatalog();
  }, []);

  return (
    <div className="leaderboard-view">
      <header className="leaderboard-header">
        <SectionTabs
          className="leaderboard-mode-tabs"
          ariaLabel={t("leaderboard.view.leaderboardMode")}
          active={state.mode}
          onChange={(mode) => void setMode(mode)}
          items={[
            { id: "ratings", label: <><Icon name="activity" size={15} /> {t("leaderboard.view.ratings")}</> },
            { id: "leagues", label: <><Icon name="leaderboard" size={15} /> {t("leaderboard.view.leagues")}</> },
          ]}
        />
        {/* Not a third view beside the two boards but a page of reading that
            opens over them, so whoever asks how the numbers work comes back
            to the row they were looking at. */}
        <Button variant="ghost" className="leaderboard-explain-trigger" onClick={() => setExplaining(true)}>
          <Icon name="info" size={15} /> {t("leaderboard.rating.explainShort")}
        </Button>
      </header>
      {explaining && (
        <Modal
          className="rating-explainer-modal"
          ariaLabel={t("leaderboard.rating.explainTitle")}
          onClose={() => setExplaining(false)}
        >
          <RatingExplainerPanel />
        </Modal>
      )}

      {/* Loading is said in the status bar, the one place for it; a failure
          is said here, with the way to try again. */}
      {state.catalogStatus.type === "failed" && (
        <StatusNotice
          tone="error"
          action={{ label: t("leaderboard.view.retry"), onClick: () => void loadCatalog() }}
          detail={state.catalogStatus.payload.reason}
        >
          {t("leaderboard.view.catalogFailed", { reason: plainError(state.catalogStatus.payload.reason) })}
        </StatusNotice>
      )}
      {state.catalogStatus.type === "ready" && state.mode === "ratings" && <RatingLeaderboardPanel />}
      {state.catalogStatus.type === "ready" && state.mode === "leagues" && <LeagueLeaderboardPanel />}
    </div>
  );
}

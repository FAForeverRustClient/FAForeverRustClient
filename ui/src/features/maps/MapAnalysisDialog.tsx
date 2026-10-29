// An installed map's pathing and reclaim, over its own preview.
//
// Pathing is the game's AI pathing mesh (faf-domain's `protocol::navigation`):
// per kind of unit, the regions it can move within, each in its own colour,
// and dark where it cannot go. Two spawns in one colour can reach each other
// by land; a plateau in a colour of its own is reachable only by air or, on
// a map with water, perhaps by hover. Reclaim is every prop's mass and energy
// from its blueprint, added up, with the mass drawn where it lies.
//
// The backend reads the map's files when the dialog opens and answers with
// finished pictures, so this only lays them over each other.

import { useEffect, useState } from "react";
import { Modal } from "../../design-system/Modal";
import { StatusNotice } from "../../design-system/StatusNotice";
import { Icon } from "../../design-system/Icon";
import { native, type MapAnalysis, type MapLayerPicture } from "../../ipc/native";
import { useTranslation } from "../../i18n/useTranslation";
import type { MessageKey } from "../../i18n";
import { formatNumber } from "../../i18n";
import { plainError } from "../../shared/plainError";
import { ZoomableImage } from "../../shared/components/MapPreviewZoom";
import "./map-analysis.css";

type View = MapLayerPicture["layer"] | "reclaim";

const VIEW_LABELS: Record<View, MessageKey> = {
  land: "maps.analysis.land",
  hover: "maps.analysis.hover",
  amphibious: "maps.analysis.amphibious",
  naval: "maps.analysis.naval",
  reclaim: "maps.analysis.reclaim",
};

type Status = { type: "loading" } | { type: "ready"; analysis: MapAnalysis } | { type: "failed"; reason: string };

export function MapAnalysisDialog({ folderName, title, onClose }: { folderName: string; title: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<Status>({ type: "loading" });
  const [view, setView] = useState<View>("land");

  useEffect(() => {
    let current = true;
    setStatus({ type: "loading" });
    native
      .readMapAnalysis(folderName)
      .then((analysis) => current && setStatus({ type: "ready", analysis }))
      .catch((error: unknown) => current && setStatus({ type: "failed", reason: String(error) }));
    return () => {
      current = false;
    };
  }, [folderName]);

  const analysis = status.type === "ready" ? status.analysis : null;
  const layer = analysis?.layers.find((one) => one.layer === view) ?? null;
  const views: View[] = analysis ? [...analysis.layers.map((one) => one.layer), "reclaim"] : [];
  const overlay = view === "reclaim" ? analysis?.reclaim.image : layer?.image;

  return (
    <Modal onClose={onClose} className="map-preview-modal">
      <div className="map-preview-dialog has-footer map-analysis">
        <header className="map-preview-dialog-header">
          <div className="map-preview-title-row">
            <h2 title={title}>{title}</h2>
          </div>
          <p>{t("maps.analysis.kicker")}</p>
        </header>

        {status.type === "loading" && (
          <p className="map-analysis-loading muted">
            <Icon name="refresh" size={15} className="spin" />
            <span>{t("maps.analysis.reading")}</span>
          </p>
        )}
        {status.type === "failed" && (
          <StatusNotice tone="error" detail={status.reason}>
            {plainError(status.reason)}
          </StatusNotice>
        )}

        {analysis && (
          <>
            <div className="settings-segmented map-analysis-views" role="group" aria-label={t("maps.analysis.viewsAria")}>
              {views.map((id) => (
                <button
                  key={id}
                  type="button"
                  className={id === view ? "is-active" : undefined}
                  aria-pressed={id === view}
                  onClick={() => setView(id)}
                >
                  {t(VIEW_LABELS[id])}
                </button>
              ))}
            </div>
            <ZoomableImage label={`${title}: ${t(VIEW_LABELS[view])}`}>
              <span className="map-analysis-stack">
                <img src={analysis.preview} alt="" draggable={false} />
                {overlay && (
                  <img
                    className={view === "reclaim" ? "map-analysis-overlay is-heat" : "map-analysis-overlay"}
                    src={overlay}
                    alt=""
                    draggable={false}
                  />
                )}
              </span>
            </ZoomableImage>
            <footer className="map-analysis-facts">
              {view === "reclaim" ? (
                <>
                  <p>
                    {t("maps.analysis.reclaimTotals", {
                      mass: formatNumber(Math.round(analysis.reclaim.mass)),
                      energy: formatNumber(Math.round(analysis.reclaim.energy)),
                    })}
                  </p>
                  <p className="muted">
                    {analysis.reclaim.valued === analysis.reclaim.props
                      ? t("maps.analysis.reclaimProps", { count: formatNumber(analysis.reclaim.props) })
                      : t("maps.analysis.reclaimPropsUnknown", {
                          count: formatNumber(analysis.reclaim.props),
                          unknown: formatNumber(analysis.reclaim.props - analysis.reclaim.valued),
                        })}
                  </p>
                </>
              ) : (
                layer && (
                  <>
                    <p>
                      {t("maps.analysis.regions", {
                        count: layer.regions,
                        share: Math.round(layer.reachable * 100),
                      })}
                    </p>
                    <p className="muted">
                      {t(analysis.hasWater ? "maps.analysis.explainer" : "maps.analysis.explainerDry")}
                    </p>
                  </>
                )
              )}
            </footer>
          </>
        )}
      </div>
    </Modal>
  );
}

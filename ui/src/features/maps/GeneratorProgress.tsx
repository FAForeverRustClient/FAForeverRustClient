// The generator's progress, shown wherever a generation can be waited on.

import type { GeneratorStatus } from "../../ipc/bindings";
import { useAppStore } from "../../store/store";
import { useTranslation } from "../../i18n/useTranslation";
import "./generator-progress.css";

/** Whether a run is in flight. Mirrors `GeneratorStatus::is_busy` in faf-domain. */
export function stillRunning(status: GeneratorStatus): boolean {
  return (
    status.type === "preparing" ||
    status.type === "resolvingVersion" ||
    status.type === "downloading" ||
    status.type === "generating"
  );
}

/** The slow stages, narrated. Generation routinely takes 30-120 seconds. */
export function GeneratorProgress() {
  const { t } = useTranslation();
  const status = useAppStore((s) => s.state.mapGenerator.status);

  switch (status.type) {
    case "idle":
      return null;
    case "preparing":
      // The `--parse` preflight costs a JVM start; without this the dialog
      // sits silent for a second or two after the button is pressed.
      return <p className="muted generate-map-progress">{t("maps.generate.preparing")}</p>;
    case "resolvingVersion":
      return <p className="muted generate-map-progress">{t("maps.generate.lookingUp")}</p>;
    case "downloading": {
      const { downloadedBytes, totalBytes, version } = status.payload;
      const percent = totalBytes ? Math.round((downloadedBytes / totalBytes) * 100) : null;
      return (
        <p className="muted generate-map-progress">
          {percent === null
            ? t("maps.generate.downloading", { version })
            : t("maps.generate.downloadingPercent", { version, percent })}
        </p>
      );
    }
    case "generating":
      return (
        <p className="muted generate-map-progress">
          {t("maps.generate.generatingWith", {
            version: status.payload.version,
            detail: status.payload.detail,
          })}
        </p>
      );
    case "generated":
      return (
        <p className="generate-map-progress is-ok">
          {t("maps.generate.ready", { maps: status.payload.maps.join(", ") })}
        </p>
      );
    case "cancelled":
      return <p className="muted generate-map-progress">{t("maps.generate.cancelled")}</p>;
    case "failed":
      return <p className="generate-map-progress is-error">{status.payload.reason}</p>;
  }
}

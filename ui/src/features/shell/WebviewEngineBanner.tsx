// Outdated-webview banner: appears when the engine the client is rendering in
// cannot do what its stylesheets ask of it.
//
// In practice this is a Linux banner. See shared/webviewEngine.ts for why the
// check probes features rather than comparing version numbers.
//
// Dismissal is remembered per engine version, not forever: the user who hides
// it today has been told, and the user who upgrades their distribution
// tomorrow gets a fresh verdict rather than permanent silence about a system
// that may still be broken.

import { useEffect, useState } from "react";
import { Icon } from "../../design-system/Icon";
import { loadStoredSet, saveStoredSet } from "../../shared/storage";
import {
  assessRunningWebview,
  RECOMMENDED_WEBKITGTK,
  type WebviewAssessment,
} from "../../shared/webviewEngine";
import { useTranslation } from "../../i18n/useTranslation";

const DISMISSED_KEY = "faf.webview.dismissedEngineWarnings";
const UNVERSIONED = "unknown";

const isString = (value: unknown): value is string => typeof value === "string";

export function WebviewEngineBanner() {
  const { t } = useTranslation();
  const [assessment, setAssessment] = useState<WebviewAssessment | null>(null);
  const [dismissed, setDismissed] = useState(() => loadStoredSet(DISMISSED_KEY, isString));

  useEffect(() => {
    let cancelled = false;
    void assessRunningWebview().then((result) => {
      if (!cancelled) setAssessment(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!assessment) return null;

  const version = assessment.version ?? UNVERSIONED;
  if (dismissed.has(version)) return null;

  const dismiss = () => {
    const next = new Set(dismissed).add(version);
    saveStoredSet(DISMISSED_KEY, next);
    setDismissed(next);
  };

  const features = assessment.missing.join(", ");

  return (
    <div className="install-banner" role="status">
      <span className="install-banner-icon" aria-hidden="true">
        <Icon name="info" size={16} />
      </span>
      <div className="install-banner-copy">
        <strong>{t("shell.webview.outdated")}</strong>
        <span className="muted">
          {assessment.version
            ? t("shell.webview.outdatedHintVersion", {
                version: assessment.version,
                features,
                recommended: RECOMMENDED_WEBKITGTK,
              })
            : t("shell.webview.outdatedHint", { features })}
        </span>
      </div>
      <div className="install-banner-actions">
        <button
          type="button"
          className="install-banner-close"
          aria-label={t("shell.webview.dismiss")}
          title={t("shell.webview.dismissTitle")}
          onClick={dismiss}
        >
          <Icon name="close" size={14} />
        </button>
      </div>
    </div>
  );
}

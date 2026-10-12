// A map generator run that failed, said the same way wherever a run can be
// started from: the Generate Map dialog, a replay's details and a live game's.

import { StatusNotice } from "../../design-system/StatusNotice";
import { useTranslation } from "../../i18n/useTranslation";
import { plainError } from "../plainError";

/**
 * The reason in a sentence, the generator's own words on hover, Retry where
 * the caller knows what to run again, and Dismiss where the failure would
 * otherwise stay on screen until the next run.
 *
 * The raw reason is whatever the generator printed, or the HTTP client's
 * English when the generator itself could not be fetched ("error sending
 * request for url (...)"): what a bug report wants, and not something a
 * player can act on.
 */
export function GeneratorFailure({
  reason,
  onRetry,
  onDismiss,
  className,
}: {
  reason: string;
  onRetry?: () => void;
  onDismiss?: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <StatusNotice
      tone="error"
      className={className}
      action={onRetry ? { label: t("common.retry"), onClick: onRetry } : undefined}
      secondary={onDismiss ? { label: t("common.dismiss"), onClick: onDismiss } : undefined}
      detail={reason}
    >
      {t("replays.detail.generationFailed", { error: plainError(reason) })}
    </StatusNotice>
  );
}

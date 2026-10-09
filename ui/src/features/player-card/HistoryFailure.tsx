// A game-history scan that failed, said the same way on both tabs that read
// it: the Maps record and the Results list.
//
// The reason used to be shown as it arrived, which for a scan that walks
// dozens of API pages was usually the HTTP client's English ("error sending
// request for url (...)"). It is said in a plain sentence now, with the
// original on hover for a bug report, and Retry beside it.

import { StatusNotice } from "../../design-system/StatusNotice";
import { useTranslation } from "../../i18n/useTranslation";
import { plainError } from "../../shared/plainError";

export function HistoryFailure({ error, onRetry }: { error: string; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <StatusNotice
      tone="error"
      action={{ label: t("common.retry"), onClick: onRetry }}
      detail={error || undefined}
    >
      {/* An empty reason is a failure the backend did not explain; the tab's
          own sentence says what failed better than "something went wrong". */}
      {error ? plainError(error) : t("playerCard.maps.failed")}
    </StatusNotice>
  );
}

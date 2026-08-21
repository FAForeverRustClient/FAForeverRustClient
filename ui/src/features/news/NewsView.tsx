// News tab: embeds the FAF news hub (https://www.faforever.com/newshub)
// directly, mirroring how the Java client's NewsController just points a
// WebView at the same URL. No custom parsing/state on our side: this tab is
// presentation-only, a frame and the way out of it.

import { EmbeddedSite } from "../../shared/EmbeddedSite";
import { useTranslation } from "../../i18n/useTranslation";

const NEWS_HUB_URL = "https://www.faforever.com/newshub";

export function NewsView() {
  const { t } = useTranslation();
  return <EmbeddedSite url={NEWS_HUB_URL} title={t("news.frameTitle")} />;
}

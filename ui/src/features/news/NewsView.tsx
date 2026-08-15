// News tab: embeds the FAF news hub (https://www.faforever.com/newshub)
// directly, mirroring how the Java client's NewsController just points a
// WebView at the same URL. No custom parsing/state on our side: this tab
// is presentation-only, an `<iframe>` and nothing else.

import { TRUSTED_EMBED_SANDBOX } from "../../shared/embedSecurity";

const NEWS_HUB_URL = "https://www.faforever.com/newshub";

export function NewsView() {
  return (
    <div className="news-embed">
      <iframe
        className="news-embed-frame"
        src={NEWS_HUB_URL}
        title="FAF News Hub"
        referrerPolicy="no-referrer"
        sandbox={TRUSTED_EMBED_SANDBOX}
      />
    </div>
  );
}

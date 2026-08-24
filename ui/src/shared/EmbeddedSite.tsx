// One embedded reference page: the frame, plus the way out of it.
//
// The Units and News tabs both point a frame at a site we do not own, rendered
// by whatever engine the operating system provides. On Linux that engine can be
// old enough to lay a modern page out wrongly (see shared/webviewEngine.ts), and
// no amount of care on our side fixes someone else's stylesheet in someone
// else's browser engine. The system browser is the user's own, is current, and
// can always show the page, so it stays one click away on every embed.

import { Button } from "../design-system/Button";
import { Icon } from "../design-system/Icon";
import { useEffect, useRef } from "react";
import {
  externalUrlFromEmbedMessage,
  TRUSTED_EMBED_SANDBOX,
} from "./embedSecurity";
import { openHttpsUrl } from "./externalLinks";
import { useTranslation } from "../i18n/useTranslation";

interface EmbeddedSiteProps {
  /** Fixed HTTPS origin outside the application origin; never client content. */
  url: string;
  /** Accessible name for the frame, already translated. */
  title: string;
}

export function EmbeddedSite({ url, title }: EmbeddedSiteProps) {
  const { t } = useTranslation();
  const frameRef = useRef<HTMLIFrameElement>(null);
  // Naming the origin is the honest version of a browser's address bar: the
  // page is not ours, and the button below hands it to a real browser.
  const host = new URL(url).host;

  useEffect(() => {
    const trustedOrigin = new URL(url).origin;
    const receiveExternalLink = (event: MessageEvent<unknown>) => {
      if (
        event.origin !== trustedOrigin ||
        event.source !== frameRef.current?.contentWindow
      ) {
        return;
      }

      const externalUrl = externalUrlFromEmbedMessage(event.data);
      if (externalUrl) void openHttpsUrl(externalUrl).catch(() => undefined);
    };

    window.addEventListener("message", receiveExternalLink);
    return () => window.removeEventListener("message", receiveExternalLink);
  }, [url]);

  return (
    <div className="embed-view">
      <div className="embed-toolbar">
        <span className="embed-toolbar-source muted">{host}</span>
        <Button
          className="embed-open-external"
          title={t("embed.openExternalTitle")}
          onClick={() => void openHttpsUrl(url)}
        >
          <Icon name="external" size={14} />
          {t("embed.openExternal")}
        </Button>
      </div>
      <iframe
        ref={frameRef}
        className="embed-frame"
        src={url}
        title={title}
        referrerPolicy="no-referrer"
        sandbox={TRUSTED_EMBED_SANDBOX}
      />
    </div>
  );
}

// One embedded reference page: the frame, plus the way out of it.
//
// The Units and News tabs both point a frame at a site we do not own, rendered
// by whatever engine the operating system provides. On Linux that engine can be
// old enough to lay a modern page out wrongly (see shared/webviewEngine.ts), and
// no amount of care on our side fixes someone else's stylesheet in someone
// else's browser engine. The system browser is the user's own, is current, and
// can always show the page, so it stays one click away on every embed.
//
// The frame also says how its load is going. A blank pane gave no sign of
// whether the page was on its way, slow, or never coming, and the only thing
// to press was "Open in browser". Now the toolbar says it is loading, a load
// that runs long says so with a Retry, and Reload is there at any time.

import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { StatusNotice } from "../../design-system/StatusNotice";
import { useEffect, useRef, useState } from "react";
import {
  externalUrlFromEmbedMessage,
  TRUSTED_EMBED_SANDBOX,
} from "../embedSecurity";
import { openHttpsUrl } from "../externalLinks";
import { useTranslation } from "../../i18n/useTranslation";
import "./embedded-site.css";

/**
 * How long a load may take before the page says it is taking long.
 *
 * Both sites are heavy enough to need several seconds on a slow line, so this
 * is well past an ordinary load: the notice is for a load that is stuck, not
 * one that is merely not instant.
 */
export const SLOW_LOAD_MS = 15_000;

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

  // Each load is one attempt, named by the address and a counter, so a Reload
  // or a new address starts a new one without resetting anything by hand: the
  // load event and the slow timer each record which attempt they were about,
  // and a record for an older attempt simply stops matching.
  const [attempt, setAttempt] = useState(0);
  const current = `${attempt}:${url}`;
  const [loaded, setLoaded] = useState<string | null>(null);
  const [slow, setSlow] = useState<string | null>(null);
  const loading = loaded !== current;

  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(current), SLOW_LOAD_MS);
    return () => window.clearTimeout(timer);
  }, [current]);

  // A new element rather than a new `src`: the address does not change on a
  // reload, so assigning it again would do nothing.
  const reload = () => setAttempt((count) => count + 1);

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
        <div className="embed-toolbar-actions">
          {loading && (
            <span className="embed-toolbar-status muted" role="status">
              {t("embed.loading")}
            </span>
          )}
          <Button
            className="embed-toolbar-button"
            title={t("embed.reloadTitle")}
            onClick={reload}
          >
            <Icon name="refresh" size={14} />
            {t("embed.reload")}
          </Button>
          <Button
            className="embed-open-external"
            title={t("embed.openExternalTitle")}
            onClick={() => void openHttpsUrl(url)}
          >
            <Icon name="external" size={14} />
            {t("embed.openExternal")}
          </Button>
        </div>
      </div>
      {loading && slow === current && (
        <StatusNotice
          tone="info"
          className="embed-slow"
          action={{ label: t("common.retry"), onClick: reload }}
        >
          {t("embed.slow")}
        </StatusNotice>
      )}
      <iframe
        key={current}
        ref={frameRef}
        className="embed-frame"
        src={url}
        title={title}
        referrerPolicy="no-referrer"
        sandbox={TRUSTED_EMBED_SANDBOX}
        onLoad={() => setLoaded(current)}
      />
    </div>
  );
}

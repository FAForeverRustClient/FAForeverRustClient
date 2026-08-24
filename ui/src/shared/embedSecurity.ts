import { optionalHttpsUrl } from "./externalLinks";

/**
 * Capabilities needed by the two read-only, cross-origin reference pages.
 * `allow-scripts` plus `allow-same-origin` would nullify the sandbox for a
 * same-origin frame that can remove its own attribute. Never reuse this policy
 * for local/client-owned content; both current consumers are fixed HTTPS
 * origins outside the Tauri application origin.
 *
 * `allow-popups-to-escape-sandbox` and `allow-top-navigation-by-user-activation`
 * allow user-clicked links (such as news item links, forum posts, and external
 * resources) to open and redirect cleanly in the browser.
 */
export const TRUSTED_EMBED_SANDBOX =
  "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation allow-forms";

export const EMBED_EXTERNAL_LINK_MESSAGE = "faf:open-external-link";

/** Accept only the small message shape emitted by the desktop frame bridge. */
export function externalUrlFromEmbedMessage(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;

  const message = value as Record<string, unknown>;
  if (
    message.type !== EMBED_EXTERNAL_LINK_MESSAGE ||
    typeof message.url !== "string"
  ) {
    return null;
  }

  return optionalHttpsUrl(message.url);
}

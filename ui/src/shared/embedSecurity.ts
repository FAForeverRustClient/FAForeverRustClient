/**
 * Capabilities needed by the two read-only, cross-origin reference pages.
 * `allow-scripts` plus `allow-same-origin` would nullify the sandbox for a
 * same-origin frame that can remove its own attribute. Never reuse this policy
 * for local/client-owned content; both current consumers are fixed HTTPS
 * origins outside the Tauri application origin.
 */
export const TRUSTED_EMBED_SANDBOX = "allow-scripts allow-same-origin allow-popups";

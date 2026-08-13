import { native } from "../ipc/native";

const FAF_HOSTS = ["faforever.com", "www.faforever.com"];
const FORUM_HOSTS = ["forum.faforever.com"];
const EXTERNAL_HOSTS = [...FAF_HOSTS, ...FORUM_HOSTS];

/** Accept an ordinary HTTPS URL without credentials or a non-standard port. */
export function validateHttpsUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== ""
  ) {
    throw new Error("external link must use ordinary HTTPS without credentials");
  }
  return url.toString();
}

/** Validate optional API content without letting a bad URL break rendering. */
export function optionalHttpsUrl(value: string): string | null {
  if (!value.trim()) return null;
  try {
    return validateHttpsUrl(value);
  } catch {
    return null;
  }
}

/** Reject lookalike hosts before an account URL reaches an anchor. */
export function validateExternalUrl(value: string, allowedHosts: readonly string[]): string {
  const safeUrl = validateHttpsUrl(value);
  const url = new URL(safeUrl);
  if (!allowedHosts.includes(url.hostname.toLowerCase())) {
    throw new Error("external link must use an approved FAF host");
  }
  return safeUrl;
}

async function openValidatedUrl(safeUrl: string): Promise<void> {
  if ("__TAURI_INTERNALS__" in window) {
    // Never fall back to webview navigation in the desktop shell. If the OS
    // opener capability fails, propagating that failure is safer than replacing
    // the application with an attacker-controlled remote document.
    await native.openUrl(safeUrl);
    return;
  }

  // Keep the standalone Vite preview useful without weakening the desktop path.
  window.open(safeUrl, "_blank", "noopener,noreferrer");
}

/** Open a validated HTTPS URL in the OS browser. */
export async function openHttpsUrl(value: string): Promise<void> {
  await openValidatedUrl(validateHttpsUrl(value));
}

/** Open only a validated FAF account/support URL. */
export async function openExternalUrl(value: string): Promise<void> {
  await openValidatedUrl(validateExternalUrl(value, EXTERNAL_HOSTS));
}

function configuredLink(envKey: string, fallback: string, allowedHosts: readonly string[]): string {
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
  const configured = env?.[envKey]?.trim();
  if (configured) {
    try {
      return validateExternalUrl(configured, allowedHosts);
    } catch {
      // A broken or unsafe deployment override must not remove account recovery.
    }
  }
  return validateExternalUrl(fallback, allowedHosts);
}

export const ACCOUNT_LINKS = {
  create: configuredLink("VITE_FAF_CREATE_ACCOUNT_URL", "https://faforever.com/account/register", FAF_HOSTS),
  recover: configuredLink("VITE_FAF_PASSWORD_RECOVERY_URL", "https://faforever.com/account/password/reset", FAF_HOSTS),
  rename: configuredLink("VITE_FAF_NAME_CHANGE_URL", "https://faforever.com/account/username/change", FAF_HOSTS),
  steam: configuredLink("VITE_FAF_STEAM_LINK_URL", "https://faforever.com/account/link", FAF_HOSTS),
  support: configuredLink(
    "VITE_FAF_SUPPORT_URL",
    "https://forum.faforever.com/category/9/faf-support-client-and-account-issues",
    FORUM_HOSTS,
  ),
  help: configuredLink("VITE_FAF_HELP_URL", "https://forum.faforever.com/category/4/i-need-help", FORUM_HOSTS),
  rules: configuredLink("VITE_FAF_RULES_URL", "https://faforever.com/rules", FAF_HOSTS),
} as const;

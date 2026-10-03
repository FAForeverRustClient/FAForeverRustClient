// Failure reasons as a person reads them.
//
// Most reasons reach the screen as they left the operating system or the HTTP
// stack: "could not finish installing C:\ProgramData\...\mods\X: Zugriff
// verweigert (os error 5)". That is the right thing to log and the wrong thing
// to show. It names a path nobody asked about, it is half in the system's
// language and half in English, and it says what broke without saying what to
// do. This recognises the common causes from the parts of the text that do not
// change with the system language (the `os error` number, an HTTP status, the
// HTTP client's own wording) and says each in one plain sentence with a way
// out, in the client's language.
//
// The original text is not thrown away: callers show it as the tooltip, so a
// bug report can still quote it.

import { t, type MessageKey } from "../i18n";

/** A recognised cause, and what gives it away. Checked in order. */
const CAUSES: { key: MessageKey; pattern: RegExp }[] = [
  // Windows 5 (access denied), POSIX 13 (permission) and 30 (read-only).
  { key: "errors.cause.locked", pattern: /os error (5|13|30)\b|permission denied|access is denied|read-only file system/i },
  // Windows 32 and 33 (sharing and lock violations), POSIX 16 (busy).
  { key: "errors.cause.inUse", pattern: /os error (32|33|16)\b|used by another process|resource busy/i },
  // Windows 112, POSIX 28.
  { key: "errors.cause.diskFull", pattern: /os error (112|28)\b|no space left|not enough space on the disk/i },
  // Windows 2 and 3, POSIX 2.
  { key: "errors.cause.missing", pattern: /os error (2|3)\b|cannot find the (file|path)|no such file or directory/i },
  { key: "errors.cause.signIn", pattern: /not logged in|not signed in|no (access )?token/i },
  { key: "errors.cause.timeout", pattern: /timed? ?out|os error (10060|110)\b/i },
  {
    key: "errors.cause.offline",
    pattern: /error sending request|connection refused|connection reset|dns error|failed to lookup|network is unreachable|os error (10061|10065|11001|111|113)\b/i,
  },
];

/** The HTTP status in a reason, when it carries one. */
function httpStatus(reason: string): number | null {
  const match = reason.match(/\b(?:status|http)\D{0,4}([1-5]\d\d)\b/i);
  return match ? Number(match[1]) : null;
}

function statusCause(status: number): MessageKey | null {
  if (status === 404 || status === 410) return "errors.cause.notFound";
  if (status === 401 || status === 403) return "errors.cause.refused";
  if (status === 429) return "errors.cause.busy";
  if (status >= 500) return "errors.cause.server";
  return null;
}

/**
 * A reason the client did not recognise, made presentable: absolute paths cut
 * to their last part, `snake_case` codes spelled out, a capital at the start
 * and a full stop at the end.
 */
function tidy(reason: string): string {
  const text = reason
    .replace(/(?:[A-Za-z]:)?[\\/](?:[^\\/:*?"<>|\r\n]+[\\/])+([^\\/:*?"<>|\r\n]+)/g, "$1")
    .replace(/\b([a-z]+(?:_[a-z]+)+)\b/g, (code) => code.replace(/_/g, " "))
    .trim();
  if (!text) return text;
  const sentence = text.charAt(0).toLocaleUpperCase() + text.slice(1);
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

/**
 * One plain sentence for a failure `reason`, in the client's language.
 *
 * Reasons the client wrote itself as sentences ("The avatar could not be sent
 * because the lobby is disconnected.") pass through untouched.
 */
export function plainError(reason: string): string {
  const raw = reason.trim();
  if (!raw) return t("errors.cause.unknown");
  for (const cause of CAUSES) {
    if (cause.pattern.test(raw)) return t(cause.key);
  }
  const status = httpStatus(raw);
  const byStatus = status === null ? null : statusCause(status);
  if (byStatus) return t(byStatus);
  return tidy(raw);
}

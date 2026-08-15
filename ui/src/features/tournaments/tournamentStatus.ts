// Frontend twin of `faf_domain::state::tournaments`' status derivation.
//
// Mirrored rather than sent down as state because it depends on the wall clock:
// a tournament starts on its own schedule, and a status stored at load time
// would still read "open for registration" an hour after the brackets went up.
// The Rust side derives the same thing for sorting; this one keeps the rendered
// badge honest while the tab sits open.

import type { Tournament } from "../../ipc/bindings";
import type { MessageKey } from "../../i18n";

export type TournamentStatus =
  | "closedForRegistration"
  | "openForRegistration"
  | "running"
  | "finished";

export const STATUS_LABELS: Record<TournamentStatus, MessageKey> = {
  closedForRegistration: "tournaments.status.closedForRegistration",
  openForRegistration: "tournaments.status.openForRegistration",
  running: "tournaments.status.running",
  finished: "tournaments.status.finished",
};

/** Decision order matches the Rust twin exactly: completed, then started, then the signup flag. */
export function statusOf(tournament: Tournament, nowSeconds: number): TournamentStatus {
  if (tournament.completedAt !== null) return "finished";
  if (tournament.startingAt !== null && tournament.startingAt < nowSeconds) return "running";
  return tournament.openForSignup ? "openForRegistration" : "closedForRegistration";
}

/** A Unix-seconds timestamp as a readable local date and time, or a fallback. */
export function formatMoment(seconds: number | null, fallback: string): string {
  if (seconds === null) return fallback;
  return new Date(seconds * 1000).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

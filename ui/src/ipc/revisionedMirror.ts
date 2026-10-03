import type { AppEvent, AppState } from "./bindings";
import type { FrontendMessage, VersionedSnapshot } from "./client";

/**
 * How long a recovery snapshot has to settle before another one is asked for.
 *
 * A gap means the client is already behind, and the answer to a gap is a whole
 * `AppState`: megabytes of JSON, requested at exactly the worst moment. Two
 * gaps in a row used to mean two of them. A short floor turns a burst of gaps
 * into one refetch, and the events that arrive meanwhile are buffered by
 * revision anyway, so nothing is lost by waiting.
 */
export const RECOVERY_COOLDOWN_MS = 750;

/**
 * The wait before retrying a snapshot that failed, doubled per failure.
 *
 * A failed recovery used to be retried only if more traffic happened to find
 * the gap again, so a quiet client could sit behind indefinitely. Retrying on
 * its own fixes that; backing off keeps a backend that is struggling from
 * being asked for megabytes of state every cooldown.
 */
export const RECOVERY_RETRY_BASE_MS = 1_000;
const RECOVERY_RETRY_MAX_MS = 15_000;

/**
 * Failed snapshots in a row before the mirror stops retrying and reports.
 *
 * Reporting each failure would flash an error over a hiccup that the next
 * attempt fixes; never giving up would hide a backend that cannot answer.
 * After the last one the error is surfaced, and a later gap starts afresh.
 */
export const RECOVERY_MAX_ATTEMPTS = 4;

/** The retry delay after `failures` failed snapshots in a row (1-based). */
export function recoveryRetryDelay(failures: number): number {
  const backoff = RECOVERY_RETRY_BASE_MS * 2 ** Math.max(0, failures - 1);
  return Math.max(RECOVERY_COOLDOWN_MS, Math.min(backoff, RECOVERY_RETRY_MAX_MS));
}

/**
 * Keeps the frontend mirror on one monotonic backend revision.
 *
 * Events arriving before the initial IPC snapshot are buffered. Events the
 * snapshot already contains are discarded, later events are replayed once,
 * and a lag-recovery snapshot replaces the mirror before subsequent messages
 * from the same ordered channel are applied.
 *
 * Recovery is driven by the gap itself rather than by whoever noticed it: each
 * attempt, and each retry, first checks that a gap is still there, so a
 * snapshot that resolved every gap is not followed by another one, and one
 * that failed is retried without waiting for more traffic.
 */
export class RevisionedMirror {
  private revision: number | null = null;
  private pending = new Map<number, AppEvent>();
  private recoveryInFlight = false;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRecoveryAt = 0;
  private failedAttempts = 0;
  private disposed = false;

  constructor(
    private readonly hydrate: (state: AppState) => void,
    private readonly apply: (event: AppEvent) => void,
    private readonly resnapshot?: () => Promise<VersionedSnapshot>,
    private readonly onRecoveryError?: (error: unknown) => void,
  ) {}

  receive(message: FrontendMessage): void {
    if (this.disposed) return;
    if (message.kind === "snapshot") {
      this.replace(message);
      return;
    }
    if (this.revision === null) {
      this.pending.set(message.revision, message.event);
      return;
    }
    if (message.revision <= this.revision) return;
    if (message.revision !== this.revision + 1) {
      this.pending.set(message.revision, message.event);
      this.requestRecovery();
      return;
    }
    this.apply(message.event);
    this.revision = message.revision;
    this.drainPending();
  }

  replace(snapshot: VersionedSnapshot): void {
    if (this.disposed) return;
    // A separately requested snapshot may complete after a newer ordered
    // snapshot or delta has already landed. Never roll the mirror backward.
    if (this.revision !== null && snapshot.revision < this.revision) {
      if (this.hasRevisionGap()) this.requestRecovery();
      return;
    }
    this.hydrate(snapshot.state);
    this.revision = snapshot.revision;

    for (const revision of this.pending.keys()) {
      if (revision <= snapshot.revision) this.pending.delete(revision);
    }
    this.drainPending();
  }

  /**
   * The mirror is being thrown away: stop a scheduled retry, and make a
   * recovery already in flight land nowhere. Clearing the timer alone left
   * that one free to hydrate the store, which the next mirror now owns, and
   * to schedule a retry of its own.
   */
  dispose(): void {
    this.disposed = true;
    if (this.recoveryTimer !== null) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
  }

  private drainPending(): void {
    let revision = this.revision;
    if (revision === null) return;
    while (true) {
      const nextRevision: number = revision + 1;
      const event = this.pending.get(nextRevision);
      if (!event) break;
      this.pending.delete(nextRevision);
      this.apply(event);
      revision = nextRevision;
    }
    this.revision = revision;
    if (this.hasRevisionGap()) {
      this.requestRecovery();
    }
  }

  private hasRevisionGap(): boolean {
    if (this.revision === null) return false;
    for (const revision of this.pending.keys()) {
      if (revision > this.revision + 1) return true;
    }
    return false;
  }

  /**
   * A gap was seen. Fetch now, or once the cooldown allows.
   *
   * While a snapshot is in flight or an attempt is already scheduled this
   * does nothing: both of those recheck the gap when they settle, so a burst
   * of gaps cannot queue a burst of snapshots behind them.
   */
  private requestRecovery(): void {
    if (!this.resnapshot) return;
    if (this.recoveryInFlight || this.recoveryTimer !== null) return;
    const since = Date.now() - this.lastRecoveryAt;
    this.scheduleRecovery(RECOVERY_COOLDOWN_MS - since);
  }

  private scheduleRecovery(delay: number): void {
    if (delay <= 0) {
      this.startRecovery();
      return;
    }
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      this.startRecovery();
    }, delay);
  }

  private startRecovery(): void {
    const resnapshot = this.resnapshot;
    if (!resnapshot || this.recoveryInFlight || this.disposed) return;
    // The gap that asked for this may have been closed since, by an ordered
    // snapshot or by the events in between finally arriving.
    if (!this.hasRevisionGap()) {
      this.failedAttempts = 0;
      return;
    }
    this.recoveryInFlight = true;
    this.lastRecoveryAt = Date.now();
    let failure: { error: unknown } | null = null;
    void resnapshot()
      .then((snapshot) => {
        this.failedAttempts = 0;
        this.replace(snapshot);
      })
      .catch((error: unknown) => {
        failure = { error };
      })
      .finally(() => {
        this.recoveryInFlight = false;
        this.lastRecoveryAt = Date.now();
        // Disposed while it was in flight: no retry, and no error for a page
        // that has already moved on.
        if (this.disposed) return;
        if (failure === null) {
          // `replace` may have left a newer gap behind, one that arrived while
          // this snapshot was being built.
          if (this.hasRevisionGap()) this.scheduleRecovery(RECOVERY_COOLDOWN_MS);
          return;
        }
        this.failedAttempts += 1;
        if (this.failedAttempts >= RECOVERY_MAX_ATTEMPTS) {
          // Out of retries: say so, and leave the next gap to start afresh.
          this.failedAttempts = 0;
          this.onRecoveryError?.(failure.error);
          return;
        }
        if (this.hasRevisionGap()) this.scheduleRecovery(recoveryRetryDelay(this.failedAttempts));
      });
  }
}

import type { AppEvent, AppState } from "./bindings";
import type { FrontendMessage, VersionedSnapshot } from "./client";

/**
 * Keeps the frontend mirror on one monotonic backend revision.
 *
 * Events arriving before the initial IPC snapshot are buffered. Events the
 * snapshot already contains are discarded, later events are replayed once,
 * and a lag-recovery snapshot replaces the mirror before subsequent messages
 * from the same ordered channel are applied.
 */
export class RevisionedMirror {
  private revision: number | null = null;
  private pending = new Map<number, AppEvent>();
  private recoveryInFlight = false;
  private recoveryRequested = false;

  constructor(
    private readonly hydrate: (state: AppState) => void,
    private readonly apply: (event: AppEvent) => void,
    private readonly resnapshot?: () => Promise<VersionedSnapshot>,
    private readonly onRecoveryError?: (error: unknown) => void,
  ) {}

  receive(message: FrontendMessage): void {
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

  private requestRecovery(): void {
    if (!this.resnapshot) return;
    if (this.recoveryInFlight) {
      this.recoveryRequested = true;
      return;
    }
    this.recoveryInFlight = true;
    this.recoveryRequested = false;
    void this.resnapshot()
      .then((snapshot) => this.replace(snapshot))
      .catch((error: unknown) => this.onRecoveryError?.(error))
      .finally(() => {
        this.recoveryInFlight = false;
        if (this.recoveryRequested) this.requestRecovery();
      });
  }
}

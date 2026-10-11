import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEvent, AppState } from "./bindings";
import { RECOVERY_MAX_ATTEMPTS, RevisionedMirror, recoveryRetryDelay } from "./revisionedMirror";

const connecting: AppEvent = { kind: "Session", event: { type: "connecting" } };
const disconnected: AppEvent = { kind: "Session", event: { type: "disconnected" } };
const snapshotState = {} as AppState;

describe("RevisionedMirror", () => {
  it("does not replay an event already represented by the initial snapshot", () => {
    const hydrate = vi.fn();
    const apply = vi.fn();
    const mirror = new RevisionedMirror(hydrate, apply);

    mirror.receive({ kind: "event", revision: 4, event: connecting });
    mirror.replace({ revision: 4, state: snapshotState });

    expect(hydrate).toHaveBeenCalledOnce();
    expect(apply).not.toHaveBeenCalled();
  });

  it("replays later buffered events in revision order exactly once", () => {
    const apply = vi.fn();
    const mirror = new RevisionedMirror(vi.fn(), apply);

    mirror.receive({ kind: "event", revision: 7, event: disconnected });
    mirror.receive({ kind: "event", revision: 6, event: connecting });
    mirror.replace({ revision: 5, state: snapshotState });
    mirror.receive({ kind: "event", revision: 7, event: disconnected });

    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenNthCalledWith(1, connecting);
    expect(apply).toHaveBeenNthCalledWith(2, disconnected);
  });

  it("replaces state at a lag-recovery boundary before applying later deltas", () => {
    const hydrate = vi.fn();
    const apply = vi.fn();
    const mirror = new RevisionedMirror(hydrate, apply);

    mirror.replace({ revision: 2, state: snapshotState });
    mirror.receive({ kind: "snapshot", revision: 9, state: snapshotState });
    mirror.receive({ kind: "event", revision: 10, event: disconnected });

    expect(hydrate).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenCalledWith(disconnected);
  });

  it("does not roll state backward when an older snapshot completes late", () => {
    const hydrate = vi.fn();
    const apply = vi.fn();
    const mirror = new RevisionedMirror(hydrate, apply);

    mirror.replace({ revision: 5, state: snapshotState });
    mirror.replace({ revision: 4, state: {} as AppState });
    mirror.receive({ kind: "event", revision: 6, event: disconnected });

    expect(hydrate).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith(disconnected);
  });

  it("does not apply an event across a revision gap and recovers from a snapshot", async () => {
    const hydrate = vi.fn();
    const apply = vi.fn();
    const resnapshot = vi.fn().mockResolvedValue({ revision: 4, state: snapshotState });
    const mirror = new RevisionedMirror(hydrate, apply, resnapshot);

    mirror.replace({ revision: 2, state: snapshotState });
    mirror.receive({ kind: "event", revision: 5, event: disconnected });

    expect(apply).not.toHaveBeenCalled();
    expect(resnapshot).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(apply).toHaveBeenCalledWith(disconnected));
    expect(hydrate).toHaveBeenCalledTimes(2);
  });

  it("coalesces several gaps into one recovery request", async () => {
    let finishRecovery!: (snapshot: { revision: number; state: AppState }) => void;
    const resnapshot = vi.fn(() => new Promise<{ revision: number; state: AppState }>((resolve) => {
      finishRecovery = resolve;
    }));
    const mirror = new RevisionedMirror(vi.fn(), vi.fn(), resnapshot);

    mirror.replace({ revision: 1, state: snapshotState });
    mirror.receive({ kind: "event", revision: 3, event: connecting });
    mirror.receive({ kind: "event", revision: 4, event: disconnected });
    expect(resnapshot).toHaveBeenCalledOnce();

    finishRecovery({ revision: 4, state: snapshotState });
    await vi.waitFor(() => expect(resnapshot).toHaveBeenCalledOnce());
  });

  it("does not ask for a second snapshot straight after the first", async () => {
    // A gap means the client is already behind, and a snapshot is megabytes.
    // Two gaps in quick succession used to mean two of them, which is the
    // lag cascade the cooldown exists to break.
    const resnapshot = vi.fn().mockResolvedValue({ revision: 2, state: snapshotState });
    const mirror = new RevisionedMirror(vi.fn(), vi.fn(), resnapshot);

    mirror.replace({ revision: 1, state: snapshotState });
    mirror.receive({ kind: "event", revision: 3, event: connecting });
    await vi.waitFor(() => expect(resnapshot).toHaveBeenCalledOnce());

    mirror.receive({ kind: "event", revision: 9, event: disconnected });
    // Still one: the second gap is remembered, not refetched immediately.
    expect(resnapshot).toHaveBeenCalledOnce();
  });

});

/**
 * Recovery on a fake clock, so retries and cooldowns are stepped through
 * rather than waited for. The backend side is a queue of scripted answers.
 */
describe("RevisionedMirror recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  type Answer = { revision: number } | Error;

  function harness(answers: Answer[]) {
    const applied: AppEvent[] = [];
    const errors: unknown[] = [];
    const resnapshot = vi.fn(() => {
      const answer = answers.shift() ?? new Error("no scripted answer");
      return answer instanceof Error
        ? Promise.reject(answer)
        : Promise.resolve({ revision: answer.revision, state: snapshotState });
    });
    const mirror = new RevisionedMirror(
      vi.fn(),
      (event) => applied.push(event),
      resnapshot,
      (error) => errors.push(error),
    );
    return { mirror, resnapshot, applied, errors };
  }

  it("retries a failed snapshot on its own, with no further traffic", async () => {
    const { mirror, resnapshot, applied, errors } = harness([new Error("busy"), { revision: 2 }]);
    mirror.replace({ revision: 1, state: snapshotState });
    mirror.receive({ kind: "event", revision: 3, event: disconnected });
    expect(resnapshot).toHaveBeenCalledTimes(1);

    // The first answer fails. Nothing else arrives, yet the gap is retried
    // once the backoff has passed, and the buffered event lands after it.
    await vi.advanceTimersByTimeAsync(recoveryRetryDelay(1) - 1);
    expect(resnapshot).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(resnapshot).toHaveBeenCalledTimes(2);
    await vi.runAllTimersAsync();

    expect(applied).toEqual([disconnected]);
    expect(errors).toEqual([]);
  });

  it("backs off between retries and reports once the attempts run out", async () => {
    const failures = Array.from({ length: RECOVERY_MAX_ATTEMPTS }, () => new Error("offline"));
    const { mirror, resnapshot, applied, errors } = harness(failures);
    mirror.replace({ revision: 1, state: snapshotState });
    mirror.receive({ kind: "event", revision: 3, event: disconnected });

    const calledAt: number[] = [0];
    let seen = 1;
    for (let elapsed = 50; elapsed <= 20_000; elapsed += 50) {
      await vi.advanceTimersByTimeAsync(50);
      if (resnapshot.mock.calls.length !== seen) {
        seen = resnapshot.mock.calls.length;
        calledAt.push(elapsed);
      }
    }

    expect(resnapshot).toHaveBeenCalledTimes(RECOVERY_MAX_ATTEMPTS);
    // Each wait is longer than the one before it.
    const waits = calledAt.slice(1).map((at, index) => at - calledAt[index]);
    for (let index = 1; index < waits.length; index += 1) {
      expect(waits[index]).toBeGreaterThan(waits[index - 1]);
    }
    // Reported once, after the last attempt, and the stale event is held back.
    expect(errors).toHaveLength(1);
    expect(applied).toEqual([]);
  });

  it("does not fetch again when the snapshot resolved every gap seen during it", async () => {
    let finish!: (snapshot: { revision: number; state: AppState }) => void;
    const resnapshot = vi.fn(
      () =>
        new Promise<{ revision: number; state: AppState }>((resolve) => {
          finish = resolve;
        }),
    );
    const apply = vi.fn();
    const mirror = new RevisionedMirror(vi.fn(), apply, resnapshot);
    mirror.replace({ revision: 1, state: snapshotState });

    // Three separate gaps while the one snapshot is being built.
    mirror.receive({ kind: "event", revision: 3, event: connecting });
    mirror.receive({ kind: "event", revision: 6, event: connecting });
    mirror.receive({ kind: "event", revision: 9, event: disconnected });
    expect(resnapshot).toHaveBeenCalledTimes(1);

    // The snapshot is newer than all of them.
    finish({ revision: 9, state: snapshotState });
    await vi.runAllTimersAsync();

    expect(resnapshot).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();
  });

  it("fetches once more when a gap is still open after the snapshot", async () => {
    const { mirror, resnapshot, applied } = harness([{ revision: 4 }, { revision: 8 }]);
    mirror.replace({ revision: 1, state: snapshotState });
    mirror.receive({ kind: "event", revision: 3, event: connecting });
    // Arrives before the first answer, and is past what that answer covers.
    mirror.receive({ kind: "event", revision: 9, event: disconnected });
    await vi.runAllTimersAsync();

    expect(resnapshot).toHaveBeenCalledTimes(2);
    expect(applied).toEqual([disconnected]);
  });

  it("drops a scheduled retry when ordered traffic closes the gap first", async () => {
    const { mirror, resnapshot, errors } = harness([new Error("busy")]);
    mirror.replace({ revision: 1, state: snapshotState });
    mirror.receive({ kind: "event", revision: 3, event: disconnected });
    await vi.advanceTimersByTimeAsync(0);
    expect(resnapshot).toHaveBeenCalledTimes(1);

    // The missing event turns up on the ordered channel during the backoff.
    mirror.receive({ kind: "event", revision: 2, event: connecting });
    await vi.runAllTimersAsync();

    expect(resnapshot).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([]);
  });

  it("lets a recovery in flight at dispose land nowhere", async () => {
    let finish!: (snapshot: { revision: number; state: AppState }) => void;
    const resnapshot = vi.fn(
      () =>
        new Promise<{ revision: number; state: AppState }>((resolve) => {
          finish = resolve;
        }),
    );
    const hydrate = vi.fn();
    const mirror = new RevisionedMirror(hydrate, vi.fn(), resnapshot);
    mirror.replace({ revision: 1, state: snapshotState });
    hydrate.mockClear();
    mirror.receive({ kind: "event", revision: 3, event: disconnected });
    expect(resnapshot).toHaveBeenCalledTimes(1);

    // The page moves on while the snapshot is still being built.
    mirror.dispose();
    finish({ revision: 2, state: snapshotState });
    await vi.runAllTimersAsync();

    expect(hydrate).not.toHaveBeenCalled();
    // Revision 2 left the gap to 3 open, which would normally ask again.
    expect(resnapshot).toHaveBeenCalledTimes(1);
  });

  it("neither reports nor retries a failure that settles after dispose", async () => {
    const { mirror, resnapshot, errors } = harness(
      Array.from({ length: RECOVERY_MAX_ATTEMPTS }, () => new Error("offline")),
    );
    mirror.replace({ revision: 1, state: snapshotState });
    mirror.receive({ kind: "event", revision: 3, event: disconnected });
    mirror.dispose();
    await vi.runAllTimersAsync();

    expect(resnapshot).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([]);
  });
});

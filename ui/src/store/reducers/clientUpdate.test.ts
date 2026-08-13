// Conformance tests for the frontend client-update helpers.
//
// `reduceClientUpdate` is already replayed against the Rust reducer by
// `reducer.conformance.test.ts`. What that harness cannot cover is the three
// *derived* helpers in this module: `updateBannerRelease`, `updatePercent`
// and `isUpdateBusy`, which are hand-written twins of `banner_release`,
// `ClientUpdateStatus::percent` and `is_busy` in
// `crates/faf-domain/src/state/client_update.rs`. Nothing generates them and
// nothing reconciles them, so they get the same treatment `reduceChat` got.
//
// Each case names the Rust behaviour it mirrors. When you change one, change
// both.

import { describe, expect, it } from "vitest";
import type { ClientRelease, ClientUpdateState } from "../../ipc/bindings";
import { isUpdateBusy, updateBannerRelease, updatePercent } from "./clientUpdate";

function release(version: string, overrides: Partial<ClientRelease> = {}): ClientRelease {
  return {
    version,
    notesUrl: `https://example.invalid/releases/${version}`,
    downloadUrl: "https://example.invalid/installer",
    assetName: "installer",
    sizeBytes: 4096,
    preRelease: false,
    publishedAt: "2026-02-01T00:00:00Z",
    ...overrides,
  };
}

function state(overrides: Partial<ClientUpdateState> = {}): ClientUpdateState {
  return {
    status: { type: "idle" },
    currentVersion: "0.2.0",
    release: null,
    dismissedVersion: "",
    ...overrides,
  };
}

describe("updateBannerRelease: twin of ClientUpdateState::banner_release", () => {
  it("shows the offer through download, ready and install", () => {
    for (const status of [
      { type: "available" } as const,
      { type: "downloading", payload: { receivedBytes: 1, totalBytes: 2 } } as const,
      { type: "ready", payload: { path: "/tmp/x" } } as const,
      { type: "installing" } as const,
    ]) {
      const current = state({ status, release: release("0.3.0") });
      expect(updateBannerRelease(current)?.version, status.type).toBe("0.3.0");
    }
  });

  it("stays hidden while nothing has been offered", () => {
    for (const status of [
      { type: "idle" } as const,
      { type: "checking" } as const,
      { type: "upToDate" } as const,
    ]) {
      expect(updateBannerRelease(state({ status, release: release("0.3.0") }))).toBeNull();
    }
  });

  it("hides the dismissed version and only that version", () => {
    const dismissed = state({
      status: { type: "available" },
      release: release("0.3.0"),
      dismissedVersion: "0.3.0",
    });
    expect(updateBannerRelease(dismissed)).toBeNull();
    expect(
      updateBannerRelease({ ...dismissed, release: release("0.4.0") })?.version,
    ).toBe("0.4.0");
  });

  it("does not raise a banner for a failed background check", () => {
    // A check that fails leaves `release` null, so nobody is greeted with an
    // error box because GitHub was briefly unreachable.
    const failed = state({ status: { type: "failed", payload: { reason: "unreachable" } } });
    expect(updateBannerRelease(failed)).toBeNull();
  });

  it("keeps a failure visible once an update was actually offered", () => {
    const failed = state({
      status: { type: "failed", payload: { reason: "download failed" } },
      release: release("0.3.0"),
    });
    expect(updateBannerRelease(failed)?.version).toBe("0.3.0");
  });
});

describe("updatePercent: twin of ClientUpdateStatus::percent", () => {
  it("is a percentage only while downloading a known size", () => {
    expect(updatePercent({ type: "idle" })).toBeNull();
    expect(updatePercent({ type: "downloading", payload: { receivedBytes: 25, totalBytes: 100 } })).toBe(25);
  });

  it("reports nothing rather than dividing by an unknown size", () => {
    // A server with no `Content-Length` sends zero, not a total.
    expect(updatePercent({ type: "downloading", payload: { receivedBytes: 25, totalBytes: 0 } })).toBeNull();
  });

  it("floors instead of rounding, so it never shows 100% mid-download", () => {
    expect(updatePercent({ type: "downloading", payload: { receivedBytes: 999, totalBytes: 1000 } })).toBe(99);
  });
});

describe("isUpdateBusy: twin of ClientUpdateStatus::is_busy", () => {
  it("covers exactly the in-flight stages", () => {
    expect(isUpdateBusy({ type: "checking" })).toBe(true);
    expect(isUpdateBusy({ type: "downloading", payload: { receivedBytes: 1, totalBytes: 2 } })).toBe(true);
    for (const status of [
      { type: "idle" } as const,
      { type: "upToDate" } as const,
      { type: "available" } as const,
      { type: "ready", payload: { path: "/tmp/x" } } as const,
      { type: "installing" } as const,
      { type: "failed", payload: { reason: "x" } } as const,
    ]) {
      expect(isUpdateBusy(status), status.type).toBe(false);
    }
  });
});

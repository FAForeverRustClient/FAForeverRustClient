// Twin of the derived methods on `GalacticWarState` in
// crates/faf-domain/src/state/galactic_war.rs. Pinned against the Rust
// originals by the conformance fixture, like the reducer twins.
//
// Note what is *not* here: whether the installed build is below the gateway's
// minimum. That is the one answer needing version ordering, so the backend
// computes it and publishes `belowMinimum`; reimplementing thirty lines of
// version parsing here is exactly the drift this file exists to avoid.

import type { GalacticWarState } from "../ipc/bindings";

/** The version the gateway points at: newest if it says, else the minimum. */
export function installTarget(state: GalacticWarState): string {
  const versions = state.versions;
  if (!versions) return "";
  // Both fields carry `#[serde(default)]` in Rust, so both can be absent from
  // a document the gateway shortened.
  const latest = versions.latestVersion ?? "";
  if (latest !== "") return latest;
  return versions.requiredVersion ?? "";
}

/**
 * Whether the installed build differs from the one the gateway points at.
 * Inequality, not ordering: the pointer moved, so follow it.
 */
export function updateAvailable(state: GalacticWarState): boolean {
  const target = installTarget(state);
  return state.installedVersion !== null && target !== "" && state.installedVersion !== target;
}

/** Whether an operation is in flight. */
export function isBusy(state: GalacticWarState): boolean {
  const type = state.status.type;
  return type === "checkingVersion" || type === "downloading" || type === "installing" || type === "launching";
}

export function canLaunch(state: GalacticWarState): boolean {
  return (
    state.installedVersion !== null &&
    !isBusy(state) &&
    state.status.type !== "running" &&
    !state.belowMinimum
  );
}

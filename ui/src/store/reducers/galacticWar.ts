// Mirrors crates/faf-domain/src/state/galactic_war.rs.

import type { GalacticWarEvent, GalacticWarState } from "../../ipc/bindings";

export function reduceGalacticWar(
  state: GalacticWarState,
  event: GalacticWarEvent,
): GalacticWarState {
  switch (event.type) {
    case "statusChanged":
      return { ...state, status: event.payload.status };
    case "installationChanged":
      return { ...state, installedVersion: event.payload.version };
    case "versionsLoaded":
      return { ...state, versions: event.payload.versions };
    case "minimumCheckChanged":
      return { ...state, belowMinimum: event.payload.belowMinimum };
    case "statisticsStatusChanged":
      return { ...state, statisticsStatus: event.payload.status };
    case "statisticsLoaded":
      // Carries the data *and* the status: a loaded document is the only way
      // to reach `loaded`, so the two cannot drift apart.
      return {
        ...state,
        statistics: event.payload.statistics,
        statisticsStatus: { type: "loaded" },
      };
  }
}

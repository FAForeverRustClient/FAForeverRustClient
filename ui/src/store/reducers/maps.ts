import type { MapsEvent, MapsState } from "../../ipc/bindings";

export function reduceMaps(state: MapsState, event: MapsEvent): MapsState {
  switch (event.type) {
    case "vaultLoading":
      return { ...state, vaultStatus: { type: "loading" } };
    case "vaultLoaded":
      return { ...state, vault: event.payload.maps, vaultStatus: { type: "ready" } };
    case "vaultLoadFailed":
      return { ...state, vaultStatus: { type: "failed", payload: { reason: event.payload.reason } } };
    // `browse` is one page of a server-side search and is separate from
    // `vault`, which stays the whole catalogue used as a folder-name index.
    case "vaultSearching":
      return { ...state, browseStatus: { type: "loading" } };
    case "vaultSearched":
      return {
        ...state,
        browse: event.payload.maps,
        browseQuery: event.payload.query,
        browseTotalPages: event.payload.totalPages,
        browseTotalRecords: event.payload.totalRecords,
        browseStatus: { type: "ready" },
      };
    case "vaultSearchFailed":
      return {
        ...state,
        browseStatus: { type: "failed", payload: { reason: event.payload.reason } },
      };
    case "installedLoading":
      return { ...state, installedStatus: { type: "loading" } };
    case "installedLoaded":
      return { ...state, installed: event.payload.maps, installedStatus: { type: "ready" } };
    case "installedLoadFailed":
      return {
        ...state,
        installedStatus: { type: "failed", payload: { reason: event.payload.reason } },
      };
    case "matchmakerPoolsLoading":
      return { ...state, matchmakerPoolsStatus: { type: "loading" } };
    case "matchmakerPoolsLoaded":
      return {
        ...state,
        matchmakerPools: { ...state.matchmakerPools, [event.payload.queueName]: event.payload.pools },
        matchmakerPoolsStatus: { type: "ready" },
      };
    case "matchmakerPoolsLoadFailed":
      return {
        ...state,
        matchmakerPoolsStatus: { type: "failed", payload: { reason: event.payload.reason } },
      };
    case "installing":
      return {
        ...state,
        installStatus: { type: "installing", payload: { folderName: event.payload.folderName } },
      };
    case "installed":
      return {
        ...state,
        installed: event.payload.installed,
        installedStatus: { type: "ready" },
        installStatus: { type: "idle" },
      };
    case "installFailed":
      return { ...state, installStatus: { type: "failed", payload: { reason: event.payload.reason } } };
    case "uninstalled":
      return {
        ...state,
        installed: event.payload.installed,
        installedStatus: { type: "ready" },
        installStatus: { type: "idle" },
      };
    case "uninstallFailed":
      return { ...state, installStatus: { type: "failed", payload: { reason: event.payload.reason } } };
  }
}

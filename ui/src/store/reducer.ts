// The window assigns authoritative Rust values for small slices. Only the
// explicitly enumerated data-heavy slices still interpret compact deltas.
import type { AppEvent, AppState, FrontendUpdate } from "../ipc/bindings";
import { DELTA_EVENT_KINDS } from "../ipc/bindings";
import { reduceChat } from "./reducers/chat";
import { reduceLobby } from "./reducers/lobby";
import { reduceReplays } from "./reducers/replays";
import { reduceMaps } from "./reducers/maps";
import { reduceMods } from "./reducers/mods";
import { reduceSocial } from "./reducers/social";
import { reduceTourney } from "./reducers/tourney";
import { reduceChangelog } from "./reducers/changelog";
import { reduceUnitHistory } from "./reducers/unitHistory";
import { reduceClientUpdate } from "./reducers/clientUpdate";
import { reduceGuides } from "./reducers/guides";
import { reduceUploads } from "./reducers/uploads";
import { reduceTraining } from "./reducers/training";
import { reducePlayerCard } from "./reducers/playerCard";
import { reduceLeaderboard } from "./reducers/leaderboard";
import { reduceMapGenerator } from "./reducers/mapGenerator";
import { reduceEvents } from "./reducers/events";
import { reduceCoop } from "./reducers/coop";

export { isModerator, isPrivateChannel, mentions } from "./reducers/chat";
export { findPlayer, playersByNickname } from "./reducers/social";

/** The remaining replica reducers, named by Rust's projection policy. */
export function isDeltaEvent(event: AppEvent): event is AppEvent & FrontendUpdate {
  return (DELTA_EVENT_KINDS as readonly string[]).includes(event.kind);
}

export function applyEvent(state: AppState, update: FrontendUpdate): AppState {
  switch (update.kind) {
    case "Session": return { ...state, session: update.event };
    case "Auth": return { ...state, auth: update.event };
    case "AccountSession": return { ...state, ...update.event };
    case "Nav": return { ...state, nav: update.event };
    case "Notifications": return { ...state, notifications: update.event };
    case "Clan": return { ...state, clan: update.event };
    case "Reporting": return { ...state, reporting: update.event };
    case "Reviews": return { ...state, reviews: update.event };
    case "Streams": return { ...state, streams: update.event };
    case "Tutorials": return { ...state, tutorials: update.event };
    case "GalacticWar": return { ...state, galacticWar: update.event };
    case "LinuxRuntime": return { ...state, linuxRuntime: update.event };
    case "Install": return { ...state, install: update.event };
    case "Connectivity": return { ...state, connectivity: update.event };
    case "Settings": return { ...state, settings: update.event.field === "all"
      ? update.event.value : { ...state.settings, [update.event.field]: update.event.value } };
    case "Chat": return { ...state, chat: reduceChat(state.chat, update.event) };
    case "Lobby": return { ...state, lobby: reduceLobby(state.lobby, update.event) };
    case "Replays": return { ...state, replays: reduceReplays(state.replays, update.event) };
    case "Maps": return { ...state, maps: reduceMaps(state.maps, update.event) };
    case "Mods": return { ...state, mods: reduceMods(state.mods, update.event) };
    case "Social": return { ...state, social: reduceSocial(state.social, update.event) };
    case "Tourney": return { ...state, tourney: reduceTourney(state.tourney, update.event) };
    case "Changelog": return { ...state, changelog: reduceChangelog(state.changelog, update.event) };
    case "UnitHistory": return { ...state, unitHistory: reduceUnitHistory(state.unitHistory, update.event) };
    case "ClientUpdate": return { ...state, clientUpdate: reduceClientUpdate(state.clientUpdate, update.event) };
    case "Guides": return { ...state, guides: reduceGuides(state.guides, update.event) };
    case "Uploads": return { ...state, uploads: reduceUploads(state.uploads, update.event) };
    case "Training": return { ...state, training: reduceTraining(state.training, update.event) };
    case "PlayerCard": return { ...state, playerCard: reducePlayerCard(state.playerCard, update.event) };
    case "Leaderboard": return { ...state, leaderboard: reduceLeaderboard(state.leaderboard, update.event) };
    case "MapGenerator": return { ...state, mapGenerator: reduceMapGenerator(state.mapGenerator, update.event) };
    case "Events": return { ...state, events: reduceEvents(state.events, update.event) };
    case "Coop": return { ...state, coop: reduceCoop(state.coop, update.event) };
  }
}

// What the open event's sections can ask for, grouped by what it acts on.
//
// The detail pane used to take every command as a prop of its own, close to a
// hundred of them, and hand each one down again by name. Grouped, a section
// takes the one or two groups it works through, and the groups are built once
// per open event rather than once per render, so a section that is memoised
// is not redrawn just because its callbacks were made again.
//
// Everything here closes over the tournament id alone. What a command needs
// besides that (the room that is open, the event as it now stands) is read
// from the store when the command is sent, which is the value the render that
// drew the button would have closed over anyway.

import type {
  BracketConfig,
  FactionVetoConfig,
  FfaReport,
  FormatDraft,
  MapDraft,
  PoolDraft,
  QualifierRule,
  SeedOrder,
  SeriesDraft,
  TourneyAdmin,
  TourneyDraft,
  TourneyMatch,
  TourneyPhase,
  TourneyPlayer,
} from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { openEvent } from "../../shared/rules/tourneyRules";
import { useAppStore } from "../../store/store";
import type { VetoHandlers } from "./bracket/VetoPanel";
import { matchTitle } from "./matchTitle";
import { send } from "./tourneyCommands";

/** Entering the event, from a player's side of it. */
export interface EntryActions {
  /** Open the signup dialog for this event. */
  signUp: () => void;
  withdraw: () => void;
  /** Check this account's team in, or take the check-in back. */
  checkIn: (checkedIn: boolean) => void;
  declineInvite: () => void;
  /** Ask whether this account's rating would get it in. */
  checkRating: () => void;
}

/** Forming a team and getting onto one, and the captains' draft. */
export interface TeamActions {
  create: (name: string) => void;
  requestJoin: (teamId: string) => void;
  cancelJoin: (teamId: string) => void;
  respondJoin: (teamId: string, playerId: string, accept: boolean) => void;
  invite: (teamId: string, playerId: string) => void;
  respondInvite: (teamId: string, accept: boolean) => void;
  leave: () => void;
  disband: (teamId: string) => void;
  rename: (teamId: string, name: string) => void;
  setCaptain: (teamId: string, playerId: string) => void;
  draftPick: (playerId: string) => void;
  draftUndo: () => void;
  setCaptains: (playerIds: string[]) => void;
}

/** Playing the matches: results, hosting, replays and the vetoes. */
export interface MatchActions {
  /** Open the score dialog for this match. */
  report: (entry: TourneyMatch) => void;
  answer: (entry: TourneyMatch, accept: boolean) => void;
  /** Open the host dialog on the Play tab with the match's title filled in. */
  host: (entry: TourneyMatch) => void;
  reportFfa: (report: FfaReport) => void;
  /** Play a FAF replay by its vault id, in the client. */
  watchReplay: (uid: number) => void;
  /** Read the open event again without a loading state: the pick phase's poll. */
  refresh: () => void;
  veto: VetoHandlers;
}

/** The event's chat rooms, and the one pinned beside the sections. */
export interface ChatActions {
  /** Load the room list, which carries the unread counts. */
  load: () => void;
  openRoom: (roomId: string) => void;
  /** Post to the room that is open. */
  post: (body: string, replyTo: string | null) => void;
  /** Post to a named room: the pinned one is not always the open one. */
  postTo: (roomId: string, body: string, replyTo: string | null) => void;
  deletePost: (roomId: string, postId: string) => void;
  mute: (fafId: number, name: string, muted: boolean) => void;
  refresh: (roomId: string) => void;
  pin: (roomId: string | null) => void;
}

/** The map database, the pools, which round plays which, and the faction veto. */
export interface MapActions {
  /** Ask for FAF's map catalogue, if it has not been loaded yet. */
  needVault: () => void;
  saveMap: (map: MapDraft) => void;
  publishMap: (mapId: string, published: boolean) => void;
  deleteMap: (mapId: string) => void;
  savePool: (pool: PoolDraft) => void;
  publishPool: (poolId: string, published: boolean) => void;
  deletePool: (poolId: string) => void;
  /** Bind a pool to a round or a match by its key, or clear it with an empty id. */
  assignPool: (key: string, poolId: string) => void;
  setFactionVeto: (config: FactionVetoConfig) => void;
  /** Importing maps from another event: the candidates, then one of them. */
  loadImportSources: () => void;
  loadImportSource: (tournamentId: string) => void;
}

/** The organiser's hand on the field: who is in, at what rating, and where. */
export interface EntrantActions {
  searchAccounts: (query: string) => void;
  add: (name: string, rating: number | null) => void;
  respondSignup: (playerId: string, accept: boolean) => void;
  remove: (playerId: string) => void;
  invite: (name: string) => void;
  uninvite: (fafId: number) => void;
  reseed: (order: SeedOrder) => void;
  splitDivisions: (divisions: number) => void;
  movePlayer: (playerId: string, teamId: string | null) => void;
  editPlayer: (playerId: string, note: string, rating: number | null) => void;
  setDivision: (teamId: string, division: number) => void;
  /** Check the entrants' names against FAF's. */
  checkRenames: () => void;
  /** One entrant's every rating. */
  loadRatings: (playerId: string, refresh: boolean) => void;
  ban: (player: TourneyPlayer, reason: string, expires: number | null, remove: boolean) => void;
}

/** The organiser's own controls: the lifecycle, the settings and the staff. */
export interface OrganiserActions {
  /** One of the organiser's single-call changes. */
  admin: (change: TourneyAdmin) => void;
  editInfo: (draft: TourneyDraft) => void;
  /** Store a picture pasted into the event's text. */
  uploadImage: (dataUrl: string, requestId: number) => void;
  publish: () => void;
  advance: (phase: TourneyPhase, config?: BracketConfig) => void;
  archive: () => void;
  abandon: (abandoned: boolean) => void;
  editFormat: (format: FormatDraft) => void;
  addOrganiser: (fafId: number, name: string) => void;
  setOrganiserVisibility: (fafId: number, hidden: boolean) => void;
  setCaster: (fafId: number, name: string, casting: boolean) => void;
}

/** The series this edition belongs to, and the events that qualify into it. */
export interface SeriesActions {
  /** Every series, for the picker: a second endpoint, read when Manage opens. */
  load: () => void;
  set: (seriesId: string | null) => void;
  save: (draft: SeriesDraft) => void;
  addQualifier: (qualifierId: string, rule: QualifierRule) => void;
  removeQualifier: (linkId: string) => void;
}

/** The organiser's announcements, and reading them. */
export interface NewsActions {
  post: (body: string, important: boolean) => void;
  edit: (newsId: string, body: string, important: boolean) => void;
  remove: (newsId: string) => void;
  markRead: () => void;
}

export interface TourneyActions {
  entry: EntryActions;
  teams: TeamActions;
  matches: MatchActions;
  chat: ChatActions;
  maps: MapActions;
  entrants: EntrantActions;
  organiser: OrganiserActions;
  series: SeriesActions;
  news: NewsActions;
}

/** What the tab around the detail opens on the detail's behalf. */
export interface TourneyDialogs {
  /** Open the signup dialog for this event. */
  signUp: (tournamentId: string) => void;
  /** Open the score dialog for this match. */
  report: (entry: TourneyMatch) => void;
}

/**
 * Ask for FAF's map catalogue, once, and only when something needs it.
 *
 * This tab does read it: the map database, the pools, the veto grids and the
 * bracket's map previews all resolve a tournament's own map names against the
 * vault, and without it an organiser sees "not in the vault" beside every one.
 *
 * It used to be asked for when the tab mounted, and that was too eager by a
 * long way. The vault is the largest thing the client holds: up to twenty
 * thousand maps, which measures at about twelve megabytes of heap and
 * seventeen as JSON, and a full state snapshot carries all of it. A player
 * opening the tab to see whether their match is up was paying that price for
 * nothing. It is now asked for by the two sections that show a preview.
 */
function needVault() {
  // Idle or failed, not just idle: one lost request must not leave every map
  // in the event marked "not in the vault" for the rest of the session.
  const status = useAppStore.getState().state.maps.vaultStatus.type;
  if (status === "idle" || status === "failed") {
    ipc.send({ kind: "Maps", command: { type: "loadVault" } });
  }
}

/** Every command the open event's sections can send, for one tournament. */
export function createTourneyActions(tournamentId: string, dialogs: TourneyDialogs): TourneyActions {
  // Open the host dialog on the Play tab with the match's title filled in.
  // Not "host it outright": the map and the featured mod are still the host's
  // call, and the existing dialog already asks for them properly.
  const host = (entry: TourneyMatch) => {
    const { detail, selectedId } = useAppStore.getState().state.tourney;
    const open = openEvent(detail, selectedId);
    if (open === null) return;
    ipc.send({
      kind: "Lobby",
      command: { type: "prepareHost", payload: { title: matchTitle(open, entry) } },
    });
    ipc.send({ kind: "Nav", command: { type: "select", payload: { tab: "play" } } });
  };

  return {
    entry: {
      signUp: () => dialogs.signUp(tournamentId),
      withdraw: () => send({ type: "withdraw", payload: { tournamentId } }),
      checkIn: (checkedIn) => send({ type: "checkIn", payload: { tournamentId, checkedIn } }),
      declineInvite: () => send({ type: "declineInvite", payload: { tournamentId } }),
      checkRating: () => send({ type: "checkRating", payload: { tournamentId } }),
    },
    teams: {
      create: (name) => send({ type: "createTeam", payload: { tournamentId, name } }),
      requestJoin: (teamId) => send({ type: "requestJoin", payload: { tournamentId, teamId } }),
      cancelJoin: (teamId) => send({ type: "cancelJoin", payload: { tournamentId, teamId } }),
      respondJoin: (teamId, playerId, accept) =>
        send({ type: "respondJoin", payload: { tournamentId, teamId, playerId, accept } }),
      invite: (teamId, playerId) => send({ type: "inviteToTeam", payload: { tournamentId, teamId, playerId } }),
      respondInvite: (teamId, accept) => send({ type: "respondInvite", payload: { tournamentId, teamId, accept } }),
      leave: () => send({ type: "leaveTeam", payload: { tournamentId } }),
      disband: (teamId) => send({ type: "disbandTeam", payload: { tournamentId, teamId } }),
      rename: (teamId, name) => send({ type: "renameTeam", payload: { tournamentId, teamId, name } }),
      setCaptain: (teamId, playerId) => send({ type: "setCaptain", payload: { tournamentId, teamId, playerId } }),
      draftPick: (playerId) => send({ type: "draftPickPlayer", payload: { tournamentId, playerId } }),
      draftUndo: () => send({ type: "draftUndo", payload: { tournamentId } }),
      setCaptains: (playerIds) => send({ type: "setCaptains", payload: { tournamentId, playerIds } }),
    },
    matches: {
      report: dialogs.report,
      answer: (entry, accept) =>
        send({ type: "answerReport", payload: { tournamentId, matchId: entry.id, accept } }),
      host,
      reportFfa: (report) => send({ type: "reportFfa", payload: { tournamentId, report } }),
      watchReplay: (uid) => ipc.send({ kind: "Replays", command: { type: "watchVault", payload: { uid } } }),
      refresh: () => send({ type: "refreshDetail", payload: { tournamentId } }),
      veto: {
        onAct: (matchId, mapId) => send({ type: "vetoAct", payload: { tournamentId, matchId, mapId } }),
        onSetSides: (matchId, teamA) => send({ type: "vetoSetSides", payload: { tournamentId, matchId, teamA } }),
        onUndo: (matchId) => send({ type: "vetoUndo", payload: { tournamentId, matchId } }),
        onFaction: (matchId, game, faction) =>
          send({ type: "factionVeto", payload: { tournamentId, matchId, game, faction } }),
        onFactionReset: (matchId, game, slot) =>
          send({
            type: "administer",
            payload: { tournamentId, change: { type: "factionReset", payload: { matchId, game, slot } } },
          }),
      },
    },
    chat: {
      load: () => send({ type: "loadChat", payload: { tournamentId } }),
      openRoom: (roomId) => send({ type: "openRoom", payload: { tournamentId, roomId } }),
      post: (body, replyTo) => {
        const roomId = useAppStore.getState().state.tourney.openRoomId;
        if (roomId === null) return;
        send({ type: "postChat", payload: { tournamentId, roomId, body, replyTo } });
      },
      postTo: (roomId, body, replyTo) => send({ type: "postChat", payload: { tournamentId, roomId, body, replyTo } }),
      deletePost: (roomId, postId) => send({ type: "deleteChatPost", payload: { tournamentId, roomId, postId } }),
      mute: (fafId, name, muted) => send({ type: "muteChat", payload: { tournamentId, fafId, name, muted } }),
      refresh: (roomId) => send({ type: "refreshChat", payload: { tournamentId, roomId } }),
      pin: (roomId) => send({ type: "pinRoom", payload: { tournamentId, roomId } }),
    },
    maps: {
      needVault,
      saveMap: (map) => send({ type: "saveMap", payload: { tournamentId, map } }),
      publishMap: (mapId, published) => send({ type: "publishMap", payload: { tournamentId, mapId, published } }),
      deleteMap: (mapId) => send({ type: "deleteMap", payload: { tournamentId, mapId } }),
      savePool: (pool) => send({ type: "savePool", payload: { tournamentId, pool } }),
      publishPool: (poolId, published) => send({ type: "publishPool", payload: { tournamentId, poolId, published } }),
      deletePool: (poolId) => send({ type: "deletePool", payload: { tournamentId, poolId } }),
      assignPool: (roundKey, poolId) => send({ type: "assignPool", payload: { tournamentId, roundKey, poolId } }),
      setFactionVeto: (config) => send({ type: "setFactionVeto", payload: { tournamentId, config } }),
      loadImportSources: () => send({ type: "loadCopySources" }),
      loadImportSource: (sourceId) => send({ type: "loadCopySource", payload: { tournamentId: sourceId } }),
    },
    entrants: {
      searchAccounts: (query) => send({ type: "searchAccounts", payload: { query } }),
      // Picking somebody ends the search: the field closed, and leaving a
      // clickable list behind would invite adding the same person twice.
      add: (name, rating) => {
        send({ type: "addPlayer", payload: { tournamentId, name, rating } });
        send({ type: "clearAccountSearch" });
      },
      respondSignup: (playerId, accept) => send({ type: "respondSignup", payload: { tournamentId, playerId, accept } }),
      remove: (playerId) => send({ type: "removePlayer", payload: { tournamentId, playerId } }),
      invite: (name) => {
        send({ type: "invitePlayer", payload: { tournamentId, name } });
        send({ type: "clearAccountSearch" });
      },
      uninvite: (fafId) => send({ type: "uninvite", payload: { tournamentId, fafId } }),
      reseed: (order) => send({ type: "reseed", payload: { tournamentId, order } }),
      splitDivisions: (divisions) => send({ type: "splitDivisions", payload: { tournamentId, divisions } }),
      movePlayer: (playerId, teamId) => send({ type: "movePlayer", payload: { tournamentId, playerId, teamId } }),
      editPlayer: (playerId, note, rating) =>
        send({ type: "editPlayer", payload: { tournamentId, playerId, note, rating } }),
      setDivision: (teamId, division) => send({ type: "setDivision", payload: { tournamentId, teamId, division } }),
      checkRenames: () => send({ type: "checkRenames", payload: { tournamentId } }),
      loadRatings: (playerId, refresh) =>
        send({ type: "loadPlayerRatings", payload: { tournamentId, playerId, refresh } }),
      ban: (player, reason, expires, remove) => {
        if (player.fafId === null) return;
        send({
          type: "banPlayer",
          payload: {
            tournamentId,
            playerId: player.id,
            fafId: player.fafId,
            name: player.name,
            reason,
            expires,
            remove,
          },
        });
      },
    },
    organiser: {
      admin: (change) => send({ type: "administer", payload: { tournamentId, change } }),
      editInfo: (draft) => send({ type: "editInfo", payload: { tournamentId, draft } }),
      uploadImage: (dataUrl, requestId) =>
        send({ type: "uploadDescImage", payload: { tournamentId, dataUrl, requestId } }),
      publish: () => send({ type: "publish", payload: { tournamentId } }),
      advance: (phase, config) =>
        send({
          type: "advance",
          // Null rather than absent: the config is only ever set on
          // `start_bracket`, and the service defaults every value from the
          // event's own plan when it is not there.
          payload: { tournamentId, phase, config: config ?? null },
        }),
      archive: () => send({ type: "archive", payload: { tournamentId } }),
      abandon: (abandoned) => send({ type: "abandon", payload: { tournamentId, abandoned } }),
      editFormat: (format) => send({ type: "editFormat", payload: { tournamentId, format } }),
      addOrganiser: (fafId, name) => send({ type: "addOrganiser", payload: { tournamentId, fafId, name } }),
      setOrganiserVisibility: (fafId, hidden) =>
        send({ type: "setOrganiserVisibility", payload: { tournamentId, fafId, hidden } }),
      setCaster: (fafId, name, casting) => send({ type: "setCaster", payload: { tournamentId, fafId, name, casting } }),
    },
    series: {
      load: () => send({ type: "loadSeries" }),
      set: (seriesId) => send({ type: "setSeries", payload: { tournamentId, seriesId } }),
      save: (draft) => send({ type: "saveSeries", payload: { draft } }),
      addQualifier: (qualifierId, rule) =>
        send({ type: "addQualifier", payload: { tournamentId, qualifierId, rule } }),
      removeQualifier: (linkId) => send({ type: "removeQualifier", payload: { tournamentId, linkId } }),
    },
    news: {
      post: (body, important) => send({ type: "postNews", payload: { tournamentId, body, important } }),
      edit: (newsId, body, important) => send({ type: "editNews", payload: { tournamentId, newsId, body, important } }),
      remove: (newsId) => send({ type: "deleteNews", payload: { tournamentId, newsId } }),
      markRead: () => send({ type: "markNewsRead", payload: { tournamentId } }),
    },
  };
}

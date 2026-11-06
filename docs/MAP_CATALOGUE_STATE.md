# Map catalogue wire budget

Measured on 2026-11-02 from decoded production disk catalogues: 9,332 map records and 1,953 mod records. No catalogue text, account data or local filesystem paths are bundled with this report. Sizes below are compact UTF-8 JSON bytes, not heap measurements.

## Method

`cargo run -p faf-domain --example measure_catalogue_sync -- maps.json mods.json` reads decoded disk catalogue documents with an `entries` array. It serializes the real `CatalogueMap`, `MapsState` and `AppEvent` types, verifies that every map record round-trips unchanged, and prints aggregate field and event budgets. An optional third argument writes before/after snapshots for `pnpm run measure:state-sync <snapshot.json>`.

The snapshot comparison populates the default application state with the two real catalogues. It is a controlled reconstruction, not a captured full live session. The lag-recovery message includes the snapshot envelope with revision 1. The same catalogue reduction applies to a real recovery snapshot; other populated slices retain their own bytes.

## Before and after

| Payload | Before | After |
|---|---:|---:|
| Map catalogue array | 6,908,458 | 4,440,317 |
| Maps slice | 6,909,159 | 4,441,018 |
| Mods slice | 1,462,509 | 1,462,509 |
| Catalogue-populated state | 8,386,726 | 5,918,585 |
| Lag-recovery snapshot message | 8,386,767 | 5,918,626 |
| `VaultLoaded` event | 6,908,524 | 4,440,383 |
| `VaultUpdated_all_records` event | 6,908,525 | 4,440,384 |
| `VaultUpdated_one_real_record` event | 845 | 574 |

The map array saves 2,468,141 bytes (35.73%); the reconstructed state saves 29.43%. `VaultUpdated_one_real_record` is a constructed single-entry event using the first actual map record, not a captured refresh. `VaultUpdated_all_records` is an upper-bound comparison, not evidence that ordinary refreshes send every entry.

## Refresh behavior

At startup, `services/maps/catalogue.rs` publishes the complete disk catalogue as `VaultLoaded`. A successful weekly full refresh also publishes the whole catalogue. Ordinary refreshes fetch a delta and publish only the changed records through `VaultUpdated`; an unchanged delta emits no map catalogue event. `VaultFoldersResolved` publishes only missing records looked up by folder/name. These policies and the on-disk `VaultMap` format are unchanged.

## Field budget

Each cell sums the serialized key, colon and value across all records. Commas, object braces and array delimiters are excluded from field cells but included in total payload sizes.

| Map field | Bytes |
|---|---:|
| `description` | 985,028 |
| `thumbnailUrlLarge` | 894,259 |
| `thumbnailUrl` | 847,599 |
| `downloadUrl` | 698,287 |
| `folderName` | 325,007 |
| `createdAt` | 317,288 |
| `displayName` | 286,875 |
| `versionGamesPlayed` | 219,325 |
| `mapType` | 186,669 |
| `recommended` | 177,275 |
| `author` | 173,724 |
| `versionId` | 154,815 |
| `gamesPlayed` | 154,545 |
| `authorId` | 152,995 |
| `ratingTenths` | 151,199 |
| `maxPlayers` | 133,300 |
| `hidden` | 130,648 |
| `ranked` | 123,194 |
| `version` | 121,856 |
| `height` | 116,226 |
| `mapId` | 115,312 |
| `width` | 106,951 |
| `reviews` | 102,780 |

| Mod field | Bytes |
|---|---:|
| `description` | 366,403 |
| `thumbnailUrl` | 172,988 |
| `downloadUrl` | 157,364 |
| `filename` | 92,915 |
| `uid` | 81,018 |
| `displayName` | 69,545 |
| `createdAt` | 66,402 |
| `updatedAt` | 66,402 |
| `author` | 42,978 |
| `uploader` | 40,135 |
| `recommended` | 37,089 |
| `uploaderId` | 36,116 |
| `versionId` | 32,556 |
| `ratingTenths` | 32,079 |
| `modType` | 28,909 |
| `ranked` | 27,339 |
| `version` | 25,669 |
| `modId` | 23,436 |
| `reviews` | 21,561 |

## Choice and limits

Every map in the measured catalogue has the API's exact raw-folder small preview, large preview and archive URLs. `MapSummary` therefore carries those URLs only when they differ. The Rust serializer compares exact strings without encoding or normalization, and the UI reconstructs the same strings only when used. Custom hosts, alternate filenames, percent encoding, capitalization and empty strings remain exact overrides. Paged searches still return full `VaultMap` records.

The full Rust records remain available through `CatalogueMap`; snapshots and catalogue events clone shared handles, not their strings. Serialization borrows their fields without building a second metadata catalogue. Visibility changes copy only the matching record so an existing snapshot remains consistent. No new command, network request, picker rule or concurrency policy is required.

Descriptions remain because the installed-map search and host dialog read them. Creation dates, review scores and game counts remain because local favourites/downloaded-map filters and ordering need them. `versionGamesPlayed` has no production UI reader in this audit; this scalar is retained so the wire representation can reconstruct the original Rust record without inventing a value. Removing more metadata needs an explicit separate query/detail ownership change.

Mods remain unchanged in this step: their array is 1,461,918 bytes; description members cost 366,403 bytes and the two URL members together cost 330,352 bytes. Changing mod details and their consumers is a separate follow-up rather than widening this map projection change.

Local preview data URLs, store-update batching/selectors and replay data are unchanged. In the controlled reconstruction `localPreviews` is the empty object (2 bytes) and the default replay slice is 1,194 bytes. A real session census on the same date recorded a replay slice of 1,240,951 bytes after use; it is not represented by that default. The census does not break local preview bytes out separately, so their real live size was not measured.

The latest startup-like live census recorded maps=6,909,160 and total=7,429,005 bytes before this change; it had not loaded the mod vault. Subtracting the same measured URL saving projects maps=4,441,019 and total=4,960,864 bytes. These two after values are projections, not a running-client measurement. Initial hydration was 79,078 bytes before the catalogue arrived.

## Frontend readers

The audit used the TypeScript checker before changing the record type, including property reads on inferred `VaultMap`/`VaultMod` objects and explicit catalogue selectors. It found 32 direct map catalogue reader files, 10 direct mod catalogue reader files, 49 map-record consumer files and 13 mod-record property-reader files. Passing a catalogue through props or shared helpers is listed separately from fields read directly. Full paged-record consumers are included so the shared interfaces cannot silently retain an incompatible shape.

| File | Catalogue or contract | Fields read directly |
|---|---|---|
| `ui/src/store/reducers/maps.ts` | maps direct | maps: `hidden`, `mapId`, `versionId` |
| `ui/src/store/reducers/mods.ts` | mods direct | mods: `modId` |
| `ui/src/shared/mapPresentation.ts` | maps record/helper | maps: `displayName`, `folderName`, `height`, `ratingTenths`, `reviews`, `thumbnailUrl`, `thumbnailUrlLarge`, `width` |
| `ui/src/shared/hooks/useVaultFolderLookup.ts` | maps direct | Pass-through/indexing |
| `ui/src/shared/components/MapThumbnail.tsx` | maps record/helper | Pass-through/indexing |
| `ui/src/shared/favoriteMaps.ts` | maps direct | maps: `downloadUrl`, `folderName` |
| `ui/src/shared/components/MapPreviewZoom.tsx` | maps record/helper | Pass-through/indexing |
| `ui/src/shared/gameRules.ts` | maps record/helper, mods record/helper | maps: `ranked`; mods: `ranked`, `uid` |
| `ui/src/features/chat/roster/GameSummaryCard.tsx` | maps record/helper | Pass-through/indexing |
| `ui/src/features/chat/ConversationAside.tsx` | maps record/helper | Pass-through/indexing |
| `ui/src/features/chat/roster/GameSummaryPopover.tsx` | maps record/helper | Pass-through/indexing |
| `ui/src/features/chat/roster/UserList.tsx` | maps record/helper | Pass-through/indexing |
| `ui/src/features/chat/ChatView.tsx` | maps direct | Pass-through/indexing |
| `ui/src/features/lobby/browser/gameFilterRules.ts` | maps record/helper | Pass-through/indexing |
| `ui/src/features/lobby/browser/useFilteredGames.ts` | maps record/helper, mods record/helper | Pass-through/indexing |
| `ui/src/features/maps/MapVaultComponents.tsx` | maps record/helper | maps: `author`, `createdAt`, `description`, `displayName`, `downloadUrl`, `folderName`, `gamesPlayed`, `hidden`, `mapId`, `mapType`, `maxPlayers`, `ranked`, `recommended`, `reviews`, `thumbnailUrl`, `thumbnailUrlLarge`, `version` |
| `ui/src/features/lobby/host/hostMapCatalogue.ts` | maps record/helper | maps: `author`, `description`, `displayName`, `height`, `mapType`, `maxPlayers`, `ranked`, `version`, `width` |
| `ui/src/features/lobby/host/HostMapDetailsColumn.tsx` | maps record/helper | Pass-through/indexing |
| `ui/src/features/lobby/host/HostGameModal.tsx` | maps direct | Pass-through/indexing |
| `ui/src/features/lobby/host/CoopMissionArt.tsx` | maps record/helper | Pass-through/indexing |
| `ui/src/features/lobby/host/HostCoopModal.tsx` | maps direct | Pass-through/indexing |
| `ui/src/features/lobby/matchmaker/MatchmakerRecentGames.tsx` | maps record/helper | Pass-through/indexing |
| `ui/src/features/lobby/matchmaker/MatchmakerMapPoolModal.tsx` | maps record/helper | Pass-through/indexing |
| `ui/src/features/lobby/matchmaker/MatchmakingPanel.tsx` | maps direct | Pass-through/indexing |
| `ui/src/features/lobby/browser/GameTile.tsx` | maps record/helper, mods record/helper | Pass-through/indexing |
| `ui/src/features/lobby/browser/GameBrowserRow.tsx` | maps record/helper, mods record/helper | Pass-through/indexing |
| `ui/src/features/lobby/coop/CoopPanel.tsx` | maps direct, mods direct | Pass-through/indexing |
| `ui/src/features/lobby/browser/GamePreviewDialog.tsx` | maps record/helper | maps: `downloadUrl`, `folderName` |
| `ui/src/features/lobby/browser/CustomGamesBrowser.tsx` | maps record/helper, mods direct | Pass-through/indexing |
| `ui/src/features/lobby/browser/GameDetails.tsx` | maps direct | Pass-through/indexing |
| `ui/src/features/lobby/browser/CustomGamesPanel.tsx` | maps record/helper | Pass-through/indexing |
| `ui/src/features/lobby/LobbyView.tsx` | maps direct, mods direct | Pass-through/indexing |
| `ui/src/features/maps/mapVaultResults.ts` | maps record/helper | maps: `author`, `authorId`, `createdAt`, `displayName`, `gamesPlayed`, `height`, `hidden`, `maxPlayers`, `ranked`, `ratingTenths`, `recommended`, `reviews`, `width` |
| `ui/src/features/uploads/UploadDialog.tsx` | maps direct, mods direct | Pass-through/indexing |
| `ui/src/features/maps/MapsView.tsx` | maps direct | maps: `author`, `authorId`, `createdAt`, `description`, `displayName`, `downloadUrl`, `folderName`, `height`, `maxPlayers`, `ranked`, `ratingTenths`, `versionId`, `width` |
| `ui/src/features/mods/modVaultResults.ts` | mods record/helper | mods: `author`, `createdAt`, `description`, `displayName`, `modType`, `ranked`, `ratingTenths`, `recommended`, `reviews`, `uid`, `updatedAt`, `uploader`, `uploaderId`, `version` |
| `ui/src/features/mods/ModVaultComponents.tsx` | mods record/helper | mods: `author`, `createdAt`, `description`, `displayName`, `downloadUrl`, `modId`, `modType`, `ranked`, `ratingTenths`, `recommended`, `reviews`, `thumbnailUrl`, `uid`, `updatedAt`, `uploader`, `version` |
| `ui/src/features/mods/useInstalledModFilters.ts` | mods record/helper | mods: `author`, `createdAt`, `description`, `displayName`, `ranked`, `ratingTenths`, `uploader`, `version` |
| `ui/src/features/mods/useModUpdateCheck.ts` | mods record/helper | Pass-through/indexing |
| `ui/src/features/mods/InstalledModDetail.tsx` | mods record/helper | mods: `createdAt`, `description`, `downloadUrl`, `ratingTenths`, `reviews`, `updatedAt`, `version` |
| `ui/src/features/mods/InstalledModCard.tsx` | mods record/helper | mods: `downloadUrl`, `thumbnailUrl` |
| `ui/src/features/mods/modIdentity.ts` | mods record/helper | mods: `author`, `displayName`, `uid` |
| `ui/src/features/mods/InstalledModsView.tsx` | mods direct | mods: `displayName`, `downloadUrl`, `uid`, `version` |
| `ui/src/features/mods/ModRenameDialog.tsx` | mods record/helper | mods: `displayName` |
| `ui/src/features/mods/ModsView.tsx` | mods direct | mods: `downloadUrl`, `uid`, `uploaderId`, `versionId` |
| `ui/src/features/replays/coopReplayMap.ts` | maps record/helper | Pass-through/indexing |
| `ui/src/features/replays/ReplayCard.tsx` | maps direct | Pass-through/indexing |
| `ui/src/features/replays/live/LiveReplayRow.tsx` | maps direct | Pass-through/indexing |
| `ui/src/features/replays/live/LiveReplayCards.tsx` | maps direct | Pass-through/indexing |
| `ui/src/features/replays/live/LiveReplayDetail.tsx` | maps direct | Pass-through/indexing |
| `ui/src/features/replays/live/LiveReplayView.tsx` | maps direct, mods direct | Pass-through/indexing |
| `ui/src/features/replays/replayDetailPresentation.ts` | maps record/helper | Pass-through/indexing |
| `ui/src/features/replays/useReplayMapPreparation.ts` | maps direct | maps: `downloadUrl`, `folderName` |
| `ui/src/features/replays/ReplayList.tsx` | maps direct | Pass-through/indexing |
| `ui/src/features/replays/local/LocalReplayView.tsx` | maps direct | Pass-through/indexing |
| `ui/src/features/replays/OnlineReplayList.tsx` | maps direct | Pass-through/indexing |
| `ui/src/features/notifications/notificationArtwork.tsx` | maps direct | Pass-through/indexing |
| `ui/src/shared/rules/tourneyRules.ts` | maps record/helper | maps: `displayName`, `folderName`, `thumbnailUrl` |
| `ui/src/features/tournaments/mapPicture.ts` | maps record/helper | Pass-through/indexing |
| `ui/src/features/tournaments/bracket/VetoPanel.tsx` | maps record/helper | Pass-through/indexing |
| `ui/src/features/tournaments/bracket/VetoOverlay.tsx` | maps record/helper | Pass-through/indexing |
| `ui/src/features/tournaments/bracket/RoundPool.tsx` | maps record/helper | maps: `displayName`, `folderName` |
| `ui/src/features/tournaments/bracket/BracketParts.tsx` | maps record/helper | Pass-through/indexing |
| `ui/src/features/tournaments/bracket/SwissRounds.tsx` | maps record/helper | Pass-through/indexing |
| `ui/src/features/tournaments/bracket/BracketView.tsx` | maps record/helper | Pass-through/indexing |
| `ui/src/features/tournaments/mapSizePresentation.ts` | maps record/helper | maps: `height`, `width` |
| `ui/src/features/tournaments/detail/MapsPanel.tsx` | maps record/helper | maps: `folderName` |
| `ui/src/features/tournaments/manage/MapVaultPicker.tsx` | maps record/helper | maps: `displayName`, `folderName`, `maxPlayers` |
| `ui/src/features/tournaments/manage/MapDbPanel.tsx` | maps record/helper | maps: `displayName` |
| `ui/src/features/tournaments/manage/MapPoolPanel.tsx` | maps record/helper | maps: `displayName` |
| `ui/src/features/tournaments/manage/ManagePanel.tsx` | maps record/helper | Pass-through/indexing |
| `ui/src/features/tournaments/detail/MatchesPanel.tsx` | maps record/helper | Pass-through/indexing |
| `ui/src/features/tournaments/detail/VetoesPanel.tsx` | maps record/helper | Pass-through/indexing |
| `ui/src/features/tournaments/detail/TournamentDetailPane.tsx` | maps record/helper | Pass-through/indexing |
| `ui/src/features/tournaments/TournamentEventDetail.tsx` | maps direct | Pass-through/indexing |
| `ui/src/features/training/trainingPresentation.ts` | maps record/helper | Pass-through/indexing |
| `ui/src/features/training/TrainingCard.tsx` | maps direct | Pass-through/indexing |
| `ui/src/features/training/ResourceDetail.tsx` | maps direct | Pass-through/indexing |
| `ui/src/features/training/TrainingHero.tsx` | maps direct | Pass-through/indexing |
| `ui/src/features/status/ClientStatusBar.tsx` | maps direct, mods direct | maps: `displayName`, `folderName`; mods: `displayName`, `uid` |
| `ui/src/features/player-card/PlayerResults.tsx` | maps direct | Pass-through/indexing |
| `ui/src/features/player-card/PlayerMapStatistics.tsx` | maps direct | Pass-through/indexing |
| `ui/src/features/lobby/join/JoinDownloadDialog.tsx` | mods direct | mods: `downloadUrl`, `uid` |
| `ui/src/shared/components/LaunchProgress.tsx` | maps record/helper | Pass-through/indexing |
| `ui/src/features/lobby/join/JoinPreparationDialog.tsx` | maps direct | Pass-through/indexing |
| `ui/src/features/replays/ReplayStartDialog.tsx` | maps direct | Pass-through/indexing |
| `ui/src/features/notifications/NotificationGameDialog.tsx` | maps direct | Pass-through/indexing |

The partial `PreviewableMap` contract in `shared/components/MapPreview.tsx` also reads folder/name, small/large URLs and local preview URLs; it accepts both full search records and compact catalogue records. The changed URL consumers use `shared/mapCatalogue.ts`: map presentation and preview components, map-card/detail install controls, favourites, game preview downloads, replay preparation downloads and tournament artwork. Other consumers keep the same metadata through the generated `MapSummary` type.

The existing reducer conformance fixture also includes compact catalogue inputs with expected full URLs produced by the Rust decoder. `store/mapCatalogue.conformance.test.ts` checks the frontend accessors against those values, including punctuation, Unicode and empty/custom overrides, so a changed Rust URL template cannot silently diverge from the frontend.

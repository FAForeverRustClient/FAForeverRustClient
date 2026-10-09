# Concurrency contract

Which commands may overlap, what happens to the one that arrives while another
runs, and what calling work off guarantees. The table in
`crates/faf-app/src/runtime/command_policy.rs` is the source of truth; this page
says the same thing in prose and names the test that pins each row. Test paths
are under `crates/faf-app/tests/`.

## Lanes

Every command waits in one of two queues, each with its own concurrency limit.

- **Ordinary**: everything not listed below. 64 commands run at once, 64 more
  wait; once both are full, `dispatch` waits and `try_dispatch` reports it.
- **Priority**: releases and navigation. Checked first, with its own slots, so
  it never waits behind ordinary work.
  `Nav::*`, `Lobby::{CancelJoin, DeclineModReplacement, TerminateGame,
  Disconnect}`, `Lobby::Matchmake { start: false }`, `Chat::Disconnect`,
  `Replays::{CancelWatch, CancelLiveTracking, CancelDownload, CancelReads}`,
  `Maps::CancelInstall`, `Mods::CancelInstall`, `Uploads::Cancel`,
  `ClientUpdate::CancelDownload`, `MapGenerator::Cancel`,
  `Guides::CancelSignIn`, `Auth::{CancelLogin, Logout}`.
  Pinned by `command_contracts::a_priority_command_is_not_held_up_by_a_saturated_ordinary_lane`.

Because a release can overtake its start, a start that leaves the ordinary queue
after a release of the same pair was dispatched is dropped instead of run
(`runtime::ReleaseOrder`; unit test `a_start_overtaken_by_its_release_is_dropped`
in `runtime/mod.rs`). The background-work pairs are keyed by the item, so a
cancel only drops a queued start of the same item: `map-install:<folder>`,
`mod-install:<uid>` (install and update), `replay-download:<uid>`,
`replay-read:<read key>` (details and analysis), `upload`, `client-download`.

## Background work and its cancel

What runs in the background registers with a `runtime::Cancellable` under its
key before its status reaches the screen, so the status bar's Cancel (or the
dialog's) can never arrive before there is anything to stop. Each run holds its
own ticket: one that settles late forgets only itself. The cancel reaches the
work one of two ways, named per row below: the service drops the port's future
(`tokio::select!` against the ticket), or the port is handed the token, or a
flag, and decides itself where stopping is still safe. Called off is never a
failure: the state goes back to idle and nothing is announced.

| Work | Cancel | How it stops | Left on disk | Pinned by |
|---|---|---|---|---|
| Map install (`Maps::InstallMap`) | `Maps::CancelInstall { folder_name }`, any letter case | the port is handed the token and its answer is the outcome. While the folder is waited for and the archive downloads, that work is dropped and the temporary file goes with its handle; while the archive unpacks on the blocking pool, `vault_install::CallOff` asks the worker not to rename it into place, and the port waits for its answer. A cancel that comes after the rename (or between that look and the rename itself) is too late: the listing after it is not raced, and the install ends `Installed` | nothing, or the map installed and listed; the staging folder is removed, and the command (and the map folder's lease) is held until the worker returns | `background_cancellation::{cancelling_a_map_install_*, a_map_install_called_off_too_late_*}`, `infra::game_updater::maps::a_vault_install_called_off_*`, `infra::vault_install::an_install_called_off_before_its_rename_*` |
| Map uninstall (`Maps::UninstallMap`) | none: a half-deleted map is worse than either | holds the map folder's lease (`lease_map_folder`) and deletes on the blocking pool, so a replay or live-game staging of the same map waits for it | the folder gone or whole | `infra::game_updater::maps::an_uninstall_waits_for_a_staging_*` |
| Mod install (`Mods::InstallMod`) | `Mods::CancelInstall { uid }` | as the map install: the port is handed the token, drops the download, asks `CallOff` before the rename and waits for the worker's answer | nothing, or the mod installed and listed | `background_cancellation::{cancelling_a_mod_install_*, a_mod_install_called_off_too_late_*}` |
| Mod update (`Mods::UpdateMod`) | `Mods::CancelInstall { uid }` | the port is handed the token and looks at it during the download and once more before the old version is removed; past that it removes and unpacks on a task of its own and ignores the call-off, because stopping in between would leave neither version | the installed version untouched, or the update finished | `background_cancellation::cancelling_a_mod_update_*` |
| Library download (`Replays::DownloadVault`) | `Replays::CancelDownload { uid }` | future dropped; a write already on the blocking pool asks `CallOff` before it publishes the file | nothing under the replay's name; the temporary file is deleted | `background_cancellation::cancelling_a_library_download_*`, `infra::replay::vault::a_called_off_download_publishes_nothing` |
| Replay panel reads (`Replays::{LoadDetails, LoadAnalysis}`) | `Replays::CancelReads { uid, local_path }`, sent when the detail panel closes with a read running | futures dropped (a vault download stops where it is, the command-stream walk never starts); the analysis is called off and `ReadsCancelled` emitted under the analysis slot's lock, which a new read of the same replay also begins under, so the call-off never clears the loading line of the read that replaced it | the replay in the cache only if its download had finished | `background_cancellation::closing_a_replay_panel_*`, `ReplayDetailPanel.flows.dom.test.tsx` |
| Publish (`Uploads::Start`) | `Uploads::Cancel`, only while `UploadStatus::is_cancellable` (packing, or bytes still going out) | the port's flag (`UploadsPort::cancel_publish`): the packing is stopped where the run is waiting and the request dropped mid-body; once the server could have the whole archive (a map's last byte taken by the transport, or a mod's storage upload about to be confirmed) the flag is ignored and the run ends as it would have; the stream ends `Idle` when it stopped | nothing: the temporary archive is deleted with its handle, and by the packing worker itself when the packing was called off or failed | `background_cancellation::{cancelling_a_publish_*, a_publish_whose_bytes_are_all_sent_*}`, `infra::uploads::a_publish_called_off_*` |
| Client update download (`ClientUpdate::Download`) | `ClientUpdate::CancelDownload` | the port is handed the token; the adapter stops at its next await (a stalled connection included) and takes its error path, and the service reads the stream to its end, so `ClientUpdate` stays held until the worker has deleted its file: the next download writes the same `.partial` file | the `.partial` installer is deleted; the offer stays (`Available`), or the installer is `Ready` when it was complete before the cancel reached it | `background_cancellation::{cancelling_the_client_update_download_*, a_cancelled_update_download_is_over_*}` |
| Replay launch (`Replays::{WatchVault, WatchLive, OpenFile}`) | `Replays::CancelWatch`, from the starting dialog or the status bar | future dropped (see `ReplayAnalysis` and the replay rows in `failure_paths`) | a vault replay's download is the launch's first measured step now, not the library download's status | `failure_paths::cancelling_a_replay_*` |
| Map generation | `MapGenerator::Cancel`, from its dialog or the status bar | the port's flag (see the `MapGenerator` row); the generator is killed, and once it has exited the folders this run made are removed (the requested map and the ones it announced, never one that was there before it started). A run that fails is cleared the same way | nothing of the run; a generator that does not exit within five seconds keeps its folder | `failure_paths::cancelling_*`, `infra::map_generator::{a_run_called_off_takes_*, a_failed_run_takes_*}` |
| Join, host and launch preparation (`Lobby::{Join, Host}`, a launch order) | `Lobby::CancelJoin`, from its dialog or the status bar; a newer join, host or launch order supersedes it; `Lobby::Disconnect` and a dropped socket call it off | the operation's token (`LobbyOperations::called_off`) is handed to the updater (`GameUpdaterPort::prepare_cancellable`) and to the simulation mods (`ModsPort::ensure_game_mods_cancellable`). The updater stops between two files of its checksum pass and of its downloads, drops a download still in flight, and stops before the map's download; a file whose write began is finished. The launcher lets `PREPARATION` go the moment the token is raised, and a preparation still waiting for it gives up at once. The mods stop between two mods and during a download; an approved replacement once begun is finished | every file already updated stays updated and whole, and the next run's checksum pass carries on from there; a stopped run writes no executable stamp, `fa_path.lua` or cache entry, and turns no mods on | `updater_cancellation::a_join_called_off_mid_update_*`, `infra::game_updater::update::the_file_loop_stops_*`, `runtime::policies::an_operations_token_is_raised_*`, `lobby_operations.rs` |
| Search preparation (`Lobby::StartSearch`) | `Lobby::Matchmake { start: false }` while `Preparing`; the end of the connection | the search's own token (`LobbyContext::search_preparation`) reaches the featured-mod update and the pool maps (`GameUpdaterPort::ensure_maps`, which stops between two maps); `PREPARATION` is let go at once. A party member's update for its leader's search stops when the search goes back to idle | as for a join; a pool map is staged whole or not at all | `updater_cancellation::a_search_stopped_mid_update_*`, `reconnects_and_retries::a_search_from_before_a_drop_*` |

Not stopped yet, each with its reason:

- A tutorial launch's update has no cancel: `Tutorials::Launch` has no
  counterpart command, and the lesson view that would send one is not mounted
  (see `TutorialsView.tsx`). It still goes to the end, through the same install
  lease as everything else.
- A generated map behind a join is made by the generator, which `CancelJoin`
  does not reach; the join's updater is never started for it.
- The vault catalogue crawls (`MapVault`, `ModVault`) report no pages and have no
  cancel: the catalogue is a shared index nine views read, so a crawl stopped for
  one view would only start again for the next.
- Galactic War's install reports bytes but has no cancel (a detached task in the
  adapter); the replay launch's generated-map rebuild runs on the generator's own
  detached task, which `CancelWatch` does not reach.

## Keys and service guards

"Dropped" means the command completes at once without doing anything.
"Queued" means it waits its turn and then runs. Commands without an entry here
run concurrently with everything.

| Key / guard | Commands | May overlap | Same kind while one runs | Cancellation | Pinned by |
|---|---|---|---|---|---|
| `MapVault` (single-flight) | `Maps::LoadVault` | everything else | dropped; a loaded catalogue is also skipped, a failed one is retried | none | `command_contracts::a_second_single_flight_command_*`, `map_vault_load.rs` |
| `ModVault` (single-flight) | `Mods::{LoadVault, ReloadVault}` | everything else | dropped | none | `command_contracts::a_second_single_flight_command_*`, `failure_paths::a_failed_mod_vault_load_*`, `mods_reload.rs` |
| `Changelog` (single-flight) | `Changelog::Load` | `Changelog::Select` | dropped (the running load selects the newest patch itself) | none | `command_contracts::a_second_single_flight_command_*`, `changelog.rs` |
| `MapGenerator` (single-flight) | `MapGenerator::{Generate, GenerateNamed, CleanUp}` | options, presets, previews | dropped | `MapGenerator::Cancel`: during the preflight the run is never started; during a run the port stops it and, once the generator has exited, removes the map folders the run made; ends `Cancelled`, no notification, nothing recorded, key free again | `command_contracts::a_second_single_flight_command_*`, `failure_paths::cancelling_*`, `infra::map_generator::a_run_called_off_takes_*` |
| `Upload` (single-flight) | `Uploads::Start` | `Open`, `Close`, `SetRanked`, `Cancel` | dropped | `Uploads::Cancel` while bytes are still going out (see "Background work and its cancel"); closing the dialog only hides it | `command_contracts::a_second_single_flight_command_*`, `uploads.rs`, `background_cancellation.rs` |
| `ClientUpdate` (single-flight) | `ClientUpdate::{Check, Download, Install}` | `Dismiss`, `CancelDownload` | dropped (also for the startup and six-hourly checks, which go through `run_command`) | `ClientUpdate::CancelDownload` stops a download (see below); a check and an install cannot be stopped | `command_contracts::a_second_single_flight_command_*`, `client_update.rs`, `background_cancellation.rs` |
| `GalacticWar` (single-flight) | `GalacticWar::{Install, Play}` | `Refresh*` | dropped | none | `command_contracts::a_second_single_flight_command_*` |
| `GuidesSignIn` (single-flight) | `Guides::SignIn` | everything else | dropped | `Guides::CancelSignIn` stops the polling through the port | `command_contracts::a_second_single_flight_command_*` |
| `TutorialLaunch` (single-flight) | `Tutorials::Launch` | `Load`, `Select` | dropped | none | `command_contracts::a_second_single_flight_command_*`, `tutorials.rs` |
| `ConnectivityCheck` (single-flight) | `Connectivity::RunCheck` | `RefreshRelayStatus` | dropped (its lines would interleave with the running check's) | none; every probe is bounded by a few seconds | `command_contracts::a_second_single_flight_command_*`, `connectivity_check.rs` |
| `RelayStatus` (single-flight) | `Connectivity::RefreshRelayStatus` | `RunCheck` | dropped (the settings page asks again on its next tick) | none; the adapter's `status` call times out after 3 seconds | `command_contracts::a_second_single_flight_command_*`, `connectivity_check.rs` |
| `MapFiles` (serial) | `Maps::{InstallMap, UninstallMap}` | everything else, `Maps::CancelInstall` included | queued, dispatch order | `Maps::CancelInstall` stops the running install (see "Background work and its cancel"); the key is free when it returns | `command_contracts::serial_commands_*`, `background_cancellation::cancelling_a_map_install_*` |
| map folder lease (infra guard) | `Maps::{InstallMap, UninstallMap}`, and the map staging of a replay launch or a live game join | everything | waits for the writer holding that map's folder; an install or staging then finds the map in place and takes it as installed (no second download, no "already installed"), an uninstall removes what it finds | dropping the caller does not stop an extraction or a removal already on the blocking pool; the worker keeps the lease until it returns, and a called-off install's worker removes its staging instead of renaming it | `infra::game_updater::maps` unit tests (`a_vault_install_waits_for_a_replay_staging_*`, `a_replay_staging_waits_for_a_vault_install_*`, `a_map_folder_that_appears_during_staging_*`, `an_uninstall_waits_for_a_staging_*`, `a_vault_install_called_off_while_unpacking_*`) |
| `ReplayAnalysis` (service guard) | `Replays::LoadAnalysis` | everything | for another replay: calls the running read off and starts; for the replay already being read: dropped, the running read answers it | the running read's port future is dropped: a vault download stops, and the command-stream walk never starts if the file is still being read; a read called off emits nothing. `Replays::CancelReads` calls it off for its own replay when the panel closes, and emits `ReadsCancelled` | `stale_replay_and_tourney_reads::{a_superseded_analysis_*, asking_again_for_the_analysis_*}`, `background_cancellation::closing_a_replay_panel_*`, `infra::replay::reader` unit tests |
| `ModFiles` (serial) | `Mods::{InstallMod, UpdateMod, UninstallMod, ToggleMod, SetActiveMods}` | everything else, `Mods::CancelInstall` included | queued, dispatch order | `Mods::CancelInstall` stops a running install, and an update still downloading (see "Background work and its cancel") | `command_contracts::serial_commands_*`, `background_cancellation::cancelling_a_mod_*` |
| `GuidesVerdict` (serial) | `Guides::{Accept, Reject}` | everything else | queued, dispatch order | none | `command_contracts::serial_commands_*` |
| `ClanWrite` (serial) | `Clan::{Create, Edit, AcceptInvitation, Remove, Leave, HandOver, Disband}` | `Load`, `SearchCandidates`, `Invite` | queued, dispatch order | none | `command_contracts::serial_commands_*` |
| `TourneyWrite` (serial) | every `TourneyWrite` | every `TourneyRead` | queued, dispatch order | none | `command_contracts::serial_commands_*`, `tourney_write_order.rs` |
| `PartyPlacements` (serial) | `PlayerCard::LoadPartyPlacements` | everything else | queued, dispatch order; the next one asks only for ids still unknown | none | `command_contracts::serial_commands_*`, `failure_paths::a_*placement*` |
| `LobbyConnection` (service guard) | `Lobby::Connect`, the watchdog's reconnect | everything | dropped while the socket is open or connecting | `Lobby::Disconnect` closes it and disarms the watchdog; any end of the socket (drop or disconnect) calls off a join or search being prepared, which is then never sent on the next connection | `command_contracts::the_lobby_socket_*`, `lobby.rs`, `lobby_operations.rs`, `reconnects_and_retries.rs` |
| `ChatConnection` (service guard) | `Chat::Connect`, the watchdog's reconnect | everything | dropped while the socket is open or connecting | `Chat::Disconnect` closes it and disarms the watchdog; after a drop the channels are joined again and the scrollback is kept | `command_contracts::the_chat_socket_*`, `reconnects_and_retries::chat_comes_back_*` |
| `LobbyJoin` (service guard) | `Lobby::Join` | everything | dropped from the click until the server answers | `CancelJoin`, `Disconnect` or a drop free the slot; a join called off before its request is never sent, one called off after is never launched, and neither is resent after a reconnect. The updater behind it is stopped too, through the operation's token (see "Background work and its cancel") | `lobby_operations.rs`, `launch_preparation.rs`, `reconnects_and_retries.rs`, `updater_cancellation.rs` |
| `Login` (service guard) | `Auth::{Login, Restore, Logout}` | everything | queued behind the lock | `Logout`, `CancelLogin`, `LogoutTest`, `PlayOffline` cancel a login in progress instead of waiting for it; a `Restore` cannot be cancelled, so `Logout` waits for it, and its answer does not land. A login or restore only stages its session in the port; the service commits it (token current, refresh token saved, renewal started) under the cancellation lock and only while the attempt is current and not called off, and discards it otherwise, so a called-off or failed sign-in leaves nothing live | `command_contracts::calling_a_sign_in_off_*`, `command_contracts::a_restore_answering_*`, `auth.rs`, `auth_session.rs`, `infra::oauth` unit tests |
| `Settings` (service guard) | every `Settings` command | everything; settings commands overlap each other except for the two steps below | the merge (read, change, emit) is under one lock, so patches never revert each other; the write is under another, so documents reach the store one at a time in order | none; nothing is written before the file was read, and a failed write is carried by the next | `command_contracts::settings_writes_*`, `settings_patches.rs`, `settings_startup.rs`, `reconnects_and_retries::a_failed_settings_write_*` |

Two more rules hold for every key:

- A service that starts another service's command goes through
  `runtime::run_command`, so the policy applies to it too.
- A serial command whose turn is dropped while it waits keeps the next one
  behind the one before it (unit test
  `a_turn_dropped_while_waiting_keeps_the_next_one_behind_the_one_before`).

## Stale responses (`LatestRequest`)

Admission decides what may run. It does not decide which answer lands: reads
that a newer read replaces run concurrently, and request order is not response
order. Those reads take a generation from a `LatestRequest` before they ask, and
drop their answer if a newer request (or a close, a clear, or a newer selection)
has taken one since.

The rule: **only the newest answer lands, and a refusal is an answer.** A stale
failure must no more set an error status or raise a notification than a stale
success may replace the data.

| Read | Generation | Pinned by |
|---|---|---|
| map and mod vault search | `maps.search_generation`, `mods.search_generation` | `stale_responses.rs` |
| report target by name | `reporting.generation` | `stale_responses.rs`, `reporting.rs` |
| report game log excerpt (also taken by open, close and untick) | `reporting.log_generation` | `reporting.rs` |
| clan invite candidates | `clan.candidate_generation` | `stale_responses.rs` |
| clan identity and roster, the reload after a write included | `clan.load_generation` | `stale_reads.rs` |
| changelog entry | `changelog.entry_generation` | `changelog.rs` |
| leaderboard ratings, seasons, season board | `leaderboard.{ratings, seasons, season}_generation` | `stale_reads.rs` |
| co-op catalogue and board | `coop.{catalog, leaderboard}_generation` | `stale_reads.rs` |
| guides queue | `guides.queue_generation` | `stale_reads.rs` |
| player card profile, history, matchmaker, map stats | `player_card.*_generation` | `stale_reads.rs` |
| reviews | `reviews.generation` | `stale_reads.rs` |
| replay vault search, local replays | `replays.{vault, local}_generation` | `stale_replay_and_tourney_reads.rs` |
| tournament detail, account search | `tourney.{detail, account_search}_generation` | `stale_replay_and_tourney_reads.rs` |
| tournament chat: opening a room (its loading state and its refusal) | `tourney.chat_generation`, and `tourney.chat_answers` below | `stale_replay_and_tourney_reads.rs` |
| tournament rating check, player ratings, template | `tourney.{rating_check, player_ratings, template}_generation` | `tourney_eligibility.rs` |
| sign-in, restore, logout | `auth.generation` | `auth.rs`, `command_contracts.rs` |

### Overlapping reads of one thing (`NewestAnswer`)

A generation is wrong for reads that overlap on purpose and are all equally
wanted: under one, a room polled every five seconds by a server that answers
in six would never update. Those reads take a ticket from a `NewestAnswer`
immediately before they ask, and an answer lands unless an answer from a later
ticket about the same key has already landed. Answers only move forward, and
none is dropped merely because another read started. A refusal that is shown
counts as an answer; a silent one (a failed poll) does not.

A write's re-read takes its ticket after the write has returned, so it outranks
every read sent before the write, and one of those answering late cannot hide
what was written.

| Reads | Key | Pinned by |
|---|---|---|
| tournament chat room: `OpenRoom`, `RefreshChat`, `PinRoom`, the re-read after `PostChat` and `DeleteChatPost` | `tourney.chat_answers`, per room id (what `ChatLoaded` names) | `stale_replay_and_tourney_reads.rs` (`a_poll_sent_before_a_post_never_hides_the_post`, `a_pinned_rooms_first_read_*`, `an_open_rooms_late_refusal_*`) |
| tournament chat room list: `LoadChat`, the list half of `RefreshChat`, the re-read after `PostChat` | `tourney.chat_answers`, one key for the list | `stale_replay_and_tourney_reads.rs` (`a_room_list_read_before_a_post_*`) |

The open room's read also stays under `tourney.chat_generation`: its loading
state and its refusal belong to the open room's pane, and opening another room
makes them worthless.

Known gaps:

- `leaderboard.catalog_generation` is not reachable through commands: `LoadCatalog`
  returns early while the catalogue is loading or loaded.
- A chat answer names its room but not its event, and room ids such as `global`
  repeat across events. A poll of one event's room still out when another event
  is opened is ordered against that event's room of the same name: it is
  dropped once that room's own read has landed, but can show for a moment if it
  arrives first.
- The lobby's `match_generation` (the found-match watchdog) is unit-tested in
  `services/lobby/matchmaking.rs` only; an integration test would need paused
  time.

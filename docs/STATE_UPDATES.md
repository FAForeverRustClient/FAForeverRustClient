# Authoritative state updates

## Ownership and transport

Rust owns `AppState` and all state transitions. Services still emit `AppEvent` values, and backend subscribers still see those events. The window's generated `FrontendUpdate` contract carries a post-reduce state replacement, a post-reduce settings group, or an explicitly retained compact event delta. An authentication boundary replaces auth, chat, and notifications together so a new account cannot render with the previous account's activity.

`EventSink::emit` captures replacements while holding the same state guard as reduction and revision assignment. It releases that guard before broadcasting and keeps the existing delivery-order lock. A queued replacement therefore contains the state of its own revision, rather than a later state read by the shell. The shell moves retained delta payloads into their window envelope without cloning large images or catalogues a second time.

Initial and recovery snapshots remain the complete authoritative state. The existing revision buffer, gap recovery, retry, and snapshot ordering apply to both kinds of update. Build and run the backend and frontend from the same checkout; the window contract changed, while persisted settings and frontend commands did not.

## Current migration

Fourteen slices no longer have frontend replica reducers:

| Update | Content sent to the window |
| --- | --- |
| Session, Auth, Nav, Install | The authoritative state of that small slice. |
| Notifications | The authoritative bounded notification history. |
| Clan, Reporting, Reviews | The authoritative feature state, including failure/status decisions and review summaries. |
| Streams, Tutorials, GalacticWar, LinuxRuntime, Connectivity | The authoritative feature state. |
| Settings | Only the changed, already-normalized preference group; initial settings loading sends the whole settings slice. |

Settings normalization is performed once in Rust. This includes appearance limits, path trimming/defaults, player/replay note normalization, kept generated-map deduplication/caps, and reminder normalization. A preference-group change preserves the frontend references of unrelated groups and catalogue slices.

Eighteen slices retain conformance-tested replica reducers: Chat, Lobby, Social, Maps, Mods, Replays, Tourney, Changelog, UnitHistory, MapGenerator, Uploads, ClientUpdate, Guides, Training, PlayerCard, Leaderboard, Events, and Coop. They mix live collections, pages, cached content, artwork, or progress with smaller metadata. Whole-slice replacement would resend that content for status-only changes; map generation/upload previews and cached release notes are concrete examples. Their next migration needs measured field/item updates rather than automatic whole-slice replacement.

The remaining rule helpers, including tournament permissions, are not migrated in this change. Immediate editor/search validation can justify local twins; state-derived permissions should instead migrate to backend-produced read models in a later phase. This change removes obsolete normalization helpers that only supported deleted reducers. Do not add another replica reducer by default. The Rust projection match and state destructuring are exhaustive, `DELTA_EVENT_KINDS` is generated, conformance cases verify that policy, and `scripts/check-architecture.mjs` rejects replica reducers without an explicit exception.

The source inventory drops from 3,550 to 2,937 lines under `ui/src/store/reducers/` and from 2,486 to 2,419 under `ui/src/shared/rules/`, excluding test files and including comments/blanks. Removing the unused 45-line path-normalization module brings the reduction to approximately 725 lines. These are maintenance-surface counts, not runtime performance results.

## Automated verification

- Rust-generated scenarios contain actual authoritative updates for migrated slices and expected state after each step. The frontend verifies the affected slices and preserves every unrelated slice.
- Compact-delta serialization is checked against the original event, and generated ordering cases continue to cover the remaining reducers.
- Domain tests cover normalized group assignments, path and generated-map handling, bounded notification history, immutable queued snapshots, and moving a large preview payload without resending its cache on status changes.
- The runtime test `window_replacements_capture_the_state_at_their_own_revision` verifies two queued replacements have their own consecutive revisions and state values.
- Frontend tests cover replacement idempotence, unrelated reference preservation, notification history assignment, revision recovery, and affected screens with mocked IPC.

Fixture sizes and timings are not measurements of live application throughput. The migration deliberately avoids the data-heavy slices above; further replacements need measurements from populated state.

## Manual checks in the client

Run both halves from this branch with `pnpm run tauri dev`. Stop the other development command before starting another checkout so its frontend cannot occupy the same development-server port. These checks use normal UI controls; keep your existing installation, cache, and settings.

1. Start and sign in normally. Confirm the workspace opens and lobby/chat connect. Sign out and sign back in once; private unfinished chat drafts should clear when the account session changes.
2. Open Maps, Installed, then visit Chat and return to Maps. Confirm the selected section is retained. Repeat with a Settings section and the client/game Changelogs sections.
3. In Settings, change the theme and interface scale, then return them to your preferred values. Change one notification switch, leave the section, and return. Restart the client and confirm the saved choices remain.
4. Add a temporary player note and a replay note/tag through the existing editors. Save, reopen, edit, and remove them. Check that whitespace is normalized and the notes remain attached to the intended player/replay. Existing notes and unrelated settings should remain intact.
5. Use Notifications, Preview and test to check presentation/delivery. When a real notification next arrives, open the bell, mark/read it, dismiss it, and check the unread count. Preview fixtures themselves intentionally stay out of real history.
6. Open one map's reviews and then another map's reviews. Confirm the target, list, count, and average all agree and an earlier answer does not overwrite the later target. Close and reopen the panel.
7. Open your clan management view and read its current state. Open a player-report dialog, try its log preview, and finish with Cancel. Confirm failures, loading indicators, and retries render normally.
8. Run Settings, Connectivity, Check connection. Lines should update without duplicate entries, the final verdict should appear, and Run again should become available. If a game is running, inspect the live connections view too.
9. Browse maps/mods and run a normal replay search. Open an existing replay, inspect its notes, and watch it. These still use compact deltas, but they pass through the new shared transport.
10. After an ordinary game or replay ends, confirm the client remains responsive, the Play view is usable, and there is no state-synchronization error banner.

Visual/native behavior and a live account session are not established by the mocked tests. Record any failed step with the screen, action, and visible result. The existing diagnostic log records slow reductions, state size, expensive frontend updates, and revision-recovery failures.

# Matchmaker state: this client against the Java and Python clients

Written for issue 390, the continuation of 194: after a ladder or TMM game ends,
the matchmaking panel stays on "searching" / "Starting your match" and offers
no way to search again. The request was to compare the reference clients'
logic with ours, list every difference, and name the likely causes.

Sources read on 2026-10-01:

- Java: `teammatchmaking/TeamMatchmakingService.java` (FAForever/downlords-faf-client)
- Python: `games/automatchframe.py`, `client/_clientwindow.py` (FAForever/client)
- Ours: `crates/faf-app/src/infra/lobby_ws.rs` (the socket loop),
  `crates/faf-app/src/services/lobby.rs`, `crates/faf-domain/src/state/lobby.rs`
  (Rust reducer), `ui/src/store/reducers/lobby.ts` (the TypeScript twin the UI
  actually runs), `ui/src/features/lobby/matchmaker/MatchmakingPanel.tsx`
- Server: `FAForever/server`, for what the server does and does not send

## The finding that explains the report

**v0.7.0 never leaves `launching` after a matchmaker game.** The server sends
no `search_info` when a match ends, because the search was over when the match
was made. So the client has to clear its own "match found / launching" state
when the game exits. In v0.7.0 the Rust reducer does that on `GameTerminated`,
but the TypeScript twin, which is what the UI runs, only resets `join`:

```ts
// v0.7.0, ui/src/store/reducers/lobby.ts
case "gameTerminated":
  return { ...state, join: { type: "idle" } };
```

`MatchmakingPanel` locks the search button while the state is `matchFound` or
`launching` (`searchLocked`), so after every matchmaker game the button stays
on "Starting your match" until the client restarts. That is the report.

The twin was fixed in NoryGit's #355, merged 2026-09-28, a day after v0.7.0 was
tagged. The report on 2026-09-30 came from 0.7.0. **The fix is on develop and
reaches players with the next release**; nothing in this note needs to change
for that.

## Every difference

| # | Topic | Java | Python | Ours |
|---|-------|------|--------|------|
| 1 | Source of "searching" | Per queue, only from `search_info` (`start` / `stop`). | Same, per queue frame. | Same, through `MatchmakingState::update_search`. |
| 2 | `match_found` | Every queue's status cleared, `searching = false`. The button is "Play" again at once. A 60 s "match found" label is cosmetic. | `searching = false` for that queue, button back to "Play". | Becomes `MatchFound`, a **locking** state: the button is disabled until something clears it. |
| 3 | `game_launch` (matchmaker) | Label "game launching", nothing locks. | Nothing. | Becomes `Launching`, also **locking**. |
| 4 | Game ends | Nothing to do: nothing was locked. | Nothing to do. | Must clear `MatchFound` / `Launching` on `GameTerminated`. Done in Rust since #291, in the TypeScript twin only since #355 (see above). |
| 5 | `match_cancelled` | Label "match cancelled", stops the pre-launched game (`stopSearchMatchmaker`). | Ignored unless its `game_id` is the running game's; then kills FA. | Becomes `Cancelled`, and FA is terminated if the state was `Launching` with a launched join. The `game_id` is not compared. |
| 6 | Late `search_info stop` after a match | Applied: the queue's status goes to none (already none). | Applied. | Ignored when not `Searching`, so the terminal state is not erased (`update_search` returns early). |
| 7 | Match found, never launched | No timeout; nothing is locked anyway. | No timeout. | `watch_for_match_start` turns `MatchFound` into `Cancelled` after `MATCH_START_TIMEOUT` and tells the player. |
| 8 | Where the state lives | One observable model. | One widget field per queue. | **Two copies**: the socket loop's own `matchmaking` variable in `lobby_ws.rs`, and the app state. The loop sends its copy on each change; the app state additionally changes on `GameTerminated` and on the watchdog in 7, which the loop's copy never sees. |
| 9 | Party grows past a queue's size | Leaves that queue at once. | Leaves on party update when over size or not owner. | Leaves at once (panel effect), owner or not. |
| 10 | Who may start | Party owner (`onSearchInfo` selects queues only for the owner). | Owner only (`handlePartyUpdate`). | Members see "needs leader" and cannot start. |

## Potential causes besides the release gap

1. **The locking states themselves (rows 2-4).** Neither reference client has
   a state that must be cleared when a game ends, so neither can get stuck in
   one. Ours has two, and every path that ends a matchmaker game without
   `GameTerminated` leaves the button locked. The watchdog covers a match that
   never launches; nothing covers a launch whose exit is never observed, for
   example a client restart of the lobby connection while FA is running.
2. **Two copies of the state (row 8).** After the watchdog in row 7 fires, the
   app state is `Cancelled` while the socket loop still holds `MatchFound`. The
   loop only republishes on a message that changes its copy, so this has not
   been seen to leak back. But any future arm that sends the loop's copy
   unconditionally would put a stale `MatchFound` or `Launching` back on screen.
   That is the bug class #291 already was once.
3. **`match_cancelled` without a game id check (row 5).** The Python client
   ignores a cancel for a game that is not the running one. Ours would
   terminate a launched matchmaker game on any `match_cancelled` that arrives
   while the state is `Launching`.

## Suggested follow-ups, not done here

- Derive the lock instead of storing it: lock the button while the join state
  is a launch in progress (`Joining`, `Preparing`, `Launched`, `InGame`) for a
  matchmaker game, and treat `MatchFound` as a label rather than a lock, as
  both reference clients do. That removes row 4 as a requirement altogether.
- Keep a single copy of the matchmaking state: have the socket loop forward
  the server's facts (`search_info`, `match_found`, `match_cancelled`,
  matchmaker `game_launch`) as events, and let the reducer be the only state.
- Compare `match_cancelled`'s `game_id` with the running game before
  terminating anything.

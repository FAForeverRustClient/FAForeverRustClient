# Matchmaker state: this client against the Java and Python clients

Written for issue 390, the continuation of 194: after a ladder or TMM game ends,
the matchmaking panel stays on "searching" / "Starting your match" and offers
no way to search again. The request was to compare the reference clients'
logic with ours, list every difference, and name the likely causes.

The first version of this note put the whole report down to v0.7.0. That was
not supported: the maintainer's 2026-09-30 "still an issue" came from the
collection branch, which had carried that fix since 2026-09-28. This version
was written after a second, line-by-line pass, and the differences it lists as
fixed are fixed in the same pull request.

Sources read on 2026-10-01:

- Java: `teammatchmaking/TeamMatchmakingService.java`,
  `TeamMatchmakingController.java`, `MatchmakingQueueItemController.java`,
  `game/GameRunner.java`, `map/MapService.java` (FAForever/downlords-faf-client)
- Python: `games/automatchframe.py`, `games/_gameswidget.py`,
  `client/_clientwindow.py` (FAForever/client)
- Server: `ladder_service/ladder_service.py`, `ladder_service/veto_system.py`,
  `matchmaker/matchmaker_queue.py`, `team_matchmaker/party_member.py`,
  `lobbyconnection.py` (FAForever/server), for what the server does and does
  not send
- Ours: `crates/faf-app/src/infra/lobby_ws.rs` (the socket loop),
  `crates/faf-app/src/services/lobby.rs`, `crates/faf-app/src/services/launcher.rs`,
  `crates/faf-domain/src/state/lobby.rs` (Rust reducer),
  `ui/src/store/reducers/lobby.ts` (the TypeScript twin the UI actually runs),
  `ui/src/features/lobby/matchmaker/MatchmakingPanel.tsx`

## What can leave the panel stuck

Neither reference client has a state that has to be cleared when a game ends.
Java's `match_found` and `game_launch` only set a label, which times out after
sixty seconds (`changeLabelForQueues`); the search button is a toggle bound to
`searching`, set optimistically on the press. Python clears its own flag on
`match_found` and on disconnect. Ours has two locking states, `MatchFound` and
`Launching`, and every way out of a match has to clear them. These were the
ways that did not:

1. **A reconnect while searching.** The server ends a player's search when the
   connection goes (`LadderService.on_connection_lost`) and says nothing about
   it on the next connection. The app state kept `Searching`, Stop sent a
   `stop` the server ignores for a search it no longer has, and only a restart
   freed the panel. Our socket loop's own copy reset to `Idle` with the new
   connection, so the two copies disagreed from then on. **Fixed:**
   `Connecting` ends a search, a match found and a cancellation in both
   reducers; a launch under way and a running game survive it.
2. **A matchmaker launch that failed or was called off before the game
   started.** `LaunchFailed` and a cancel during preparation left `Launching`
   in place, and nothing told the server: the panel sat on "Starting your
   match" until the server cancelled the match a minute or two later, and the
   player got a matchmaker violation. Java sends `GameState Ended` on every
   way out of `GameRunner.startOnlineGame`, failures included. **Fixed:** both
   reducers release the panel on `LaunchFailed` and on a cancel during
   preparation, and the launcher sends `GameState Ended` on every failure and
   every abandoned launch.
3. **v0.7.0's TypeScript reducer never left `launching` on `gameTerminated`.**
   Fixed by #355, which reached `develop` two hours after the tag (not a day,
   as the first version said). Reaches players with the next release.

## Every difference, and what became of it

| # | Topic | Java | Python | Ours before | Now |
|---|-------|------|--------|-------------|-----|
| 1 | Where "searching" comes from | `search_info`, plus optimistically from the toggle and `match_found` | `search_info`; cleared on stop and on disconnect | `search_info` only | Unchanged, plus the reconnect reset in 1 above and `Preparing` from the press (row 4). |
| 2 | `match_found` | Clears every queue, `searching = false`; a 60 s label. Sends nothing | `searching = false`; sends `match_ready` | `MatchFound`, which locks; sends `match_ready` (the server ignores it) | Unchanged. The lock is cleared by every exit now. |
| 3 | `game_launch` | Label; the launcher was armed at queue join | Nothing | `Launching`, which locks | Unchanged, see 2 above. |
| 4 | Preparation | At queue join: featured mod updated, then every pool map downloaded, then `start` (`joinQueues`, `downloadAllMatchmakerMaps`). After `game_launch`, map, ICE and replay server in parallel | At launch | Everything after `game_launch`, one step after another, inside the server's 60 s host window | **Like Java.** A new `Preparing` state: featured mod and pool maps first, then `start` for each queue. Party members update their featured mod as soon as their leader's search starts, as Java's `startSearchMatchmaker` does on every client. Preparations are serialized, so the launch never races the search's own update. |
| 5 | The launch blocks the lobby | No: futures beside the connection | No | Yes: `launcher::start` was awaited inside the update loop, so the socket was not read for as long as a map generation or a patch took, and `match_cancelled` arrived only after the game had started | **Like Java.** The launch runs beside the update loop; relay messages that arrive meanwhile are held and delivered in order once the adapter exists. |
| 6 | `match_cancelled` | Cancels the launch future, kills a running game. No `game_id` check | Kills only the game named by `game_id` | Kills a launched game; a launch still preparing was not stopped | A launch still preparing is stopped at its next step; one that finishes anyway is stopped as it reports back. Still no `game_id` check, like Java. |
| 7 | Late `search_info stop` after a match | Applied | Applied | Ignored when not searching | Unchanged: it keeps the terminal state from being erased. |
| 8 | Match found, never launched | No timeout (nothing locks) | No timeout | 120 s watchdog to `Cancelled` | Unchanged. Its comment no longer claims a launch may take fifteen minutes. |
| 9 | Two copies of the state | One model | One flag per queue | Socket loop and app state, which split on reconnect (1 above) | Both reset on reconnect. A single copy is still a possible follow-up. |
| 10 | Starting a search | Refused while a game runs, for a non-owner, without a game path; disabled while a member is in a game (`partyMembersNotReady`) | Owner only | Owner only | **Like Java**, all four. |
| 11 | Accepting a party invite | Refused while searching, while a game runs, without a game path, when the inviter is offline | Stops the search first | Sent unguarded. The server moves the player into the party without ending their search, so they searched alone and, as a member, could not stop it | **Like Java**, all four refusals. |
| 12 | Inviting while searching | Refused | Allowed | Allowed; the invitee then got "That party is already in queue" | **Like Java**, refused. |
| 13 | Factions | Sent on every connection and on every change; every member picks their own | Sent on change | Sent on change and on Start; members could not pick | **Like Java**, and one better: also re-sent when the server's party snapshot shows the default of all four factions, which it gives every member it creates (login, joining a party, being put back into a party of one). |
| 14 | Party outgrows a queue | Owner leaves it while searching | Stops every search on any party change | Leaves it, owner or not | Unchanged. |
| 15 | Forced veto changes (`vetoes_info` with `forced`) | Notification | Nothing | Applied silently | **Like Java**, a notification. |
| 16 | Queue pop countdown | Counts down to the server's absolute `queue_pop_time`; keeps the last value at zero | Not shown | Counted the delta from whenever the Play tab rendered it, so a delta that arrived while the tab was closed restarted from its full value | Counts down to an instant recorded when the message arrived (the delta added to this machine's clock, which keeps a skewed clock out of it); stays at zero until the next update. |
| 17 | Outgoing frames | Unbounded queue | Unbounded | 8 slots, `try_send`, a full queue logged as "disconnected" | 1024 slots, and a full queue says so. No drops were seen in the local logs from 2026-09-25 to 10-01. |
| 18 | `/division`, `/subdivision` launch arguments | Sent from the league entry | Not sent | Not sent | Not done: the client has the division's display name, not the `nameKey` Forged Alliance expects. Cosmetic. |
| 19 | Default `/mean` `/deviation` | 0 / 0 | 1500 / 500 | 1500 / 500 | Unchanged, deliberately: see `launch_arguments`. |

## What is left

- A single copy of the matchmaking state (row 9). With the reconnect fixed,
  the two copies no longer disagree on any path found, but the class of bug
  stays possible as long as there are two.
- Division arguments (row 18).
- Nothing here has been verified at runtime; it needs a ladder game, a TMM
  party game, a reconnect while searching, and a cancelled launch.

# Native smoke test

The automated suites cover the reducers, the runtime's command policy, the
services against fake ports and the mounted UI. None of them start the real
game, talk to the live lobby server or render in WebView2. This checklist is
the part only a person at a native build can do. Run it before a release and
after any change to joining, replay preparation, tournaments or the state
mirror.

Each step names what to look for. "Log" means the client log; search it for
the quoted text.

## Before starting

- Start from a release build (`pnpm tauri build`), not the dev server: the
  timings below are meaningless under a debug build.
- Note the time, so the log lines from this run are easy to find.

## 1. Startup and state size

1. Log in with a normal account.
2. Log: `webview hydration snapshot` appears once, with `bytes` and
   `copy_seconds`. Write both down.
3. Wait two minutes on the Play tab. Log: `state census` appears with a total
   and per-slice sizes, largest first. Write down the total and the three
   largest slices.

## 2. Multiplayer join, cancel and rejoin

1. Join an open custom game. The game starts, the lobby shows you, leave it.
2. Join a game and cancel while the game is still starting. The client
   returns to idle, no game window stays open, and joining again works.
3. Join, cancel, and join the same game again quickly (within a second). Only
   one game launches.
4. Join a password game with a wrong password. The refusal is shown, the
   client is idle afterwards, and a retry with the right password works.

## 3. Replays

1. Clear the replay cache folder, including the featured mod overlay.
2. Open an online replay of a ranked game and press Watch. The status bar
   shows preparation, the replay starts.
3. Watch a replay whose map is a generated map not on disk. The status bar
   says the map is being generated, then the replay starts.
4. Open the replay panel on a local replay: details, players, teams with
   separators, and the replay ID are shown.
5. Change results per page next to More filters. The list reloads from page 1.

## 4. Host and map picker

1. Host a game, open the map picker, search, pick a map, change it again.
2. Pick a generated map with "+". It is generated and selected.
3. Cancel hosting. The client is idle and can host again.

## 5. Tournaments (organiser account)

1. Open a tournament you organise and run a few organiser actions, such as
   reporting a match result or starting a round. Each takes effect once.
2. Press two organiser actions quickly one after another. Both apply, in order,
   and neither is lost.
3. Send a chat message in the tournament chat. It appears once.

## 6. Matchmaking

1. Join the 1v1 queue, leave it, join again. The pulsating dot reflects the
   queue state each time; no progress bar remains in the corner.
2. Switch between the matchmaker and leaderboard tabs repeatedly. Nothing
   shifts and nothing overlays the other.

## 7. Responsiveness under load

1. Open Replays, Live, in tile view, with many live games listed. Switch to
   Online and back several times. Each switch answers within a moment.
2. Log, for the whole run: look for
   - `reducing an event held the state write lock this long` (backend reduce
     over 25 ms, with the event name);
   - `applying backend events cost the webview this much` (webview apply time
     per 30-second window, with the slowest event);
   - `the webview was busy for most of the last five seconds` (stalls, with
     where);
   - `webview event stream fell behind; sent a full state snapshot`, with
     `bytes` and `seconds`;
   - `a command waited for a free slot before it could start`.
   Write down every occurrence with its numbers.

## 8. Long session

Leave the client running for at least an hour with the lobby open and chat
connected. Compare the last `state census` line with the first one. A slice
that grew steadily while the lobby was quiet is a leak candidate; note it.

## Recording the run

Note the build, the date, and for each section either "pass" or what went
wrong. Keep the numbers from sections 1, 7 and 8: they are the performance
evidence the automated suites cannot produce.

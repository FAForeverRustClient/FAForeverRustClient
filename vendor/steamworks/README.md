# Steamworks API library

`win64/steam_api64.dll` is Valve Corporation's Steamworks API library, taken
unchanged from the `redistributable_bin/win64` folder of the Steamworks SDK as
Valve publishes it at <https://partner.steamgames.com/downloads/list>.

**It is not covered by this repository's MIT licence.** It is Valve's software,
and it is redistributed here under the Steamworks SDK Access Agreement
(<https://partner.steamgames.com/documentation/sdk_access_agreement>), whose
section 1.1(b) permits distributing the contents of `redistributable_bin`
together with the software that uses them, in object code form. Valve keeps
all rights the agreement does not grant (section 1.3). Anyone redistributing
this client redistributes this file under those terms, not under MIT.

## What it is used for

One thing: the optional **Steam status** setting (issue 364, Settings, Account,
off by default). When it is on, the client starts a small helper process beside
each game. The helper loads this library, calls `SteamAPI_Init` as Supreme
Commander: Forged Alliance (Steam app 9420), waits for the game to exit, and
calls `SteamAPI_Shutdown`. Steam then shows the player as playing Forged
Alliance for exactly the length of the game and counts those hours. No other
part of the Steamworks API is called: no stats, achievements, friends, cloud
or workshop. See `crates/faf-app/src/infra/steam_presence.rs`.

The library talks only to the Steam client already running on the player's
machine. What Steam learns is what it learns from any game: which account is
playing which app, from when to when.

## Conditions this repository keeps

- The file is never modified, and nothing in this client talks to Steam other
  than through it (agreement section 2.4: no reverse engineering, no
  replacement of the SDK's functionality).
- This client uses no Valve trademark as its own and does not present itself as
  made, endorsed or partnered by Valve (section 2.3). The setting names Steam
  only to say what it does.
- This project is not affiliated with Valve Corporation. Steam and the Steam
  logo are trademarks of Valve Corporation.

## Updating it

Download the current SDK from the link above (a Steam account and acceptance
of the agreement are required), replace `win64/steam_api64.dll` with the file
from `redistributable_bin/win64`, and record the SDK version and SHA-256 below.

| SDK version | SHA-256 of `steam_api64.dll` |
| ----------- | ---------------------------- |
| (pending)   | (pending)                    |

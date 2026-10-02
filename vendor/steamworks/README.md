# Steamworks API library

`win64/steam_api64.dll` and `linux64/libsteam_api.so` are Valve Corporation's
Steamworks API library for Windows and Linux, taken unchanged from the
`redistributable_bin` folder of the Steamworks SDK as Valve publishes it at
<https://partner.steamgames.com/downloads/list>. The Windows file carries
Valve Corp.'s Authenticode signature.

**They are not covered by this repository's MIT licence.** They are Valve's
software, redistributed here under the Steamworks SDK Access Agreement
(<https://partner.steamgames.com/documentation/sdk_access_agreement>), whose
section 1.1(b) permits distributing the contents of `redistributable_bin`
together with the software that uses them, in object code form. Valve keeps
all rights the agreement does not grant (section 1.3). Anyone redistributing
this client redistributes these files under those terms, not under MIT.

## What they are used for

One thing: the optional **Steam status** setting (issue 364, Settings, Account,
off by default). When it is on, the client starts a small helper process beside
each game. The helper loads the library, calls `SteamAPI_InitFlat` as Supreme
Commander: Forged Alliance (Steam app 9420), waits for the game to exit, and
calls `SteamAPI_Shutdown`. Steam then shows the player as playing Forged
Alliance for exactly the length of the game and counts those hours. Apart from
`SteamAPI_RunCallbacks`, which Valve asks every such process to call, no other
part of the Steamworks API is used: no stats, achievements, friends, cloud or
workshop. See `crates/faf-app/src/infra/steam_presence.rs`.

The library talks only to the Steam client already running on the player's
machine. What Steam learns is what it learns from any game: which account is
playing which app, from when to when. FAF is a separate client, so with the
setting off Steam does not learn when someone plays on FAF at all; turning it
on is what tells it.

## What we cannot vouch for

The library is **closed source**. This repository controls which of its
functions are called, and the list above is complete, but nobody here can see
or verify what the library itself does inside those calls, or what it or the
Steam client then sends to Valve. Turning the setting on means trusting Valve
with that, exactly as with any game started from Steam. For that reason the
setting is marked experimental, stays off unless the player turns it on, and
asks once before it does, saying the same in the client's own words.

On Linux it is the native library talking to the native Steam client, while
the game itself runs through Wine or Proton. It finds Steam through
`~/.steam`, which a Steam installed from the distribution or from Valve
provides. A Steam installed as a Flatpak or a Snap keeps that inside its
sandbox, and the status may then not appear; the client log says why.

## Conditions this repository keeps

- The files are never modified, and nothing in this client talks to Steam other
  than through them (agreement section 2.4: no reverse engineering, no
  replacement of the SDK's functionality).
- This client uses no Valve trademark as its own and does not present itself as
  made, endorsed or partnered by Valve (section 2.3). The setting names Steam
  only to say what it does.
- This project is not affiliated with Valve Corporation. Steam and the Steam
  logo are trademarks of Valve Corporation.

## Updating them

Download the current SDK from the link above (a Steam account and acceptance
of the agreement are required), replace both files with the ones from
`redistributable_bin/win64` and `redistributable_bin/linux64`, and record the
SDK version and SHA-256 below.

| SDK version | File | SHA-256 |
| ----------- | ---- | ------- |
| 1.65 | `win64/steam_api64.dll` | `e6d9bafb9a41e42fba7b21553db49f8719027af3f0deb23ff86cfc44d60e776d` |
| 1.65 | `linux64/libsteam_api.so` | `eb2dd015b84177cf4f4326fe578aab375fd8931bbbd719c7492420d9777007fe` |

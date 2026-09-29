# Third-party notices

This distribution includes or downloads components from other FAForever
projects. Their original licenses remain in force.

## Official FAF Client flag assets

The country flag images in `ui/public/flags/` come from the official
[FAF Client](https://github.com/FAForever/downlords-faf-client), which is
distributed under the MIT License. Copyright (c) 2015 Michel Jung and its
contributors.

## FAF Java ICE adapter

The release build downloads and redistributes the platform artifact from
[FAForever/java-ice-adapter](https://github.com/FAForever/java-ice-adapter).
It is distributed under the MIT License by its contributors. The download is
pinned and verified with the SHA-256 digest published by GitHub Releases.

## Eclipse Temurin Java runtime

Windows release builds download and redistribute the Eclipse Temurin 25 JRE
from [Eclipse Adoptium](https://adoptium.net/). The archive is pinned and
verified against the SHA-256 digest published with the official GitHub release.
Temurin binaries are distributed under the GNU General Public License version 2
with the Classpath Exception. The runtime archive includes its complete licence
and legal notices.

## faf-pioneer

The experimental `faf-pioneer` executable comes from
[FAForever/faf-pioneer](https://github.com/FAForever/faf-pioneer). It is
distributed under the MIT License by its contributors.

## Steamworks API library (Valve)

Windows and Linux builds include Valve Corporation's Steamworks API library
(`steam_api64.dll` and `libsteam_api.so`, SDK 1.65), kept in the repository
under `vendor/steamworks/` and installed under `natives/steam/`. It is
proprietary software of Valve Corporation and is **not** licensed under this
project's MIT License: it is redistributed, unmodified,
under section 1.1(b) of the
[Steamworks SDK Access Agreement](https://partner.steamgames.com/documentation/sdk_access_agreement),
and all rights not granted there remain with Valve. It is used only by the
optional Steam status setting, which is experimental and off by default. It is
closed source: we know which of its functions the client calls, but cannot
verify what the library does or sends to Valve. See
`vendor/steamworks/README.md` for what is called, why, and what that means.

This project is not affiliated with or endorsed by Valve Corporation. Steam is
a trademark of Valve Corporation.

## FAF wiki rating figures

The five diagrams in the leaderboard's "How rating works" tab
(`ui/src/features/leaderboard/assets/`) are taken from the FAForever wiki's
[rating system page](https://wiki.faforever.com/en/Infrastructure/Rating-System),
which is that project's own documentation. The prose beside them is a summary
of the same page written for this client. If the wiki states a licence for its
media, name it here.

## Match-found notification sound

`ui/src/features/notifications/assets/match-found.mp3` is the sound the FAF
Java client plays when the matchmaker finds you a game, taken from
[FAForever/downlords-faf-client](https://github.com/FAForever/downlords-faf-client)
(`src/main/resources/theme/sounds/matchFoundSound.mp3`).

That repository states the licence for its sounds in a `license.txt` beside
them: they come from [Pixabay](https://pixabay.com/service/license/), whose
licence allows commercial and non-commercial use and modification, and asks for
no attribution. This notice is here because attribution is appreciated, and
because the next person to wonder where a binary in the tree came from should
not have to find out the hard way.

It is the only sound file the client ships. The other five notification tones
are synthesised at runtime; see `ui/src/features/notifications/notificationSound.ts`.

## Bundled typefaces

Every typeface the client uses is self-hosted in `ui/public/fonts/` and
declared in `ui/src/design-system/fonts.css`. Nothing is fetched from a font
CDN at runtime, so the desktop app needs no network access to render text.

| Family | Designer / publisher | Licence |
| --- | --- | --- |
| Geist, Geist Mono | Vercel | SIL Open Font License 1.1 |

`docs/design/forgemaptoolkit-theme.css` names two more, Poppins and Space
Mono, that an archived theme used. Neither is in the tree: that file records
where to fetch them and under what licence if the theme is ever picked up.

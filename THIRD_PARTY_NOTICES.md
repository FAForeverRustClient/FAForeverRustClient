# Third-party notices

This distribution includes or downloads components from other FAForever
projects. Their original licenses remain in force.

## Historical FAF patchnotes

The early notes in `crates/faf-domain/src/protocol/data/early_changelog.json`
are reproduced with permission from the archived FAF wiki and original FAF
release announcements. Attribution: FAForever contributors. Original rights
are retained; this import does not assert a new licence for the source text.

The exact source URLs, capture timestamps, content hashes and date evidence
are recorded in `scripts/data/early-changelog-sources.json` and
`docs/development/early-changelog-sources.md`. Each displayed note links to its
original source. Archive timestamps are not release dates.

## Official FAF Client flag assets

The country flag images in `ui/public/flags/` come from the official
[FAF Client](https://github.com/FAForever/downlords-faf-client), which is
distributed under the MIT License. Copyright (c) 2015 Michel Jung and its
contributors.

## FAF API map marker icons

The mass, hydrocarbon and army icons in `ui/src/shared/assets/map-markers/`
come from the [FAF API](https://github.com/FAForever/faf-java-api)
(`src/main/resources/images/map_markers/`), which draws them on the vault's map
previews. It is distributed under the MIT License. Copyright (c) 2016 Michel
Jung and its contributors.

## FAF Java ICE adapter

The release build downloads and redistributes the platform artifact from
[FAForever/java-ice-adapter](https://github.com/FAForever/java-ice-adapter).
It is distributed under the MIT License by its contributors. The download is
pinned and verified with the SHA-256 digest published by GitHub Releases.

## Eclipse Temurin Java runtime

Windows and Linux release builds download and redistribute the Eclipse Temurin 25 JRE
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

## FAF wiki rating page

The leaderboard's "How rating works" dialog summarises the FAForever wiki's
[rating system page](https://wiki.faforever.com/en/Infrastructure/Rating-System),
which is that project's own documentation, and follows its order. Its figures
are drawn by the client (`ui/src/features/leaderboard/RatingFigures.tsx`) from
the numbers in the text; none of the wiki's images is shipped. The one figure
with data of its own, the five teams' ratings over forty games, uses values
read off the wiki's chart of the same name.

## Unit history rules (faf-workshop, FAF unit database)

The Changelog tab's unit history (`crates/faf-domain/src/protocol/unit_history.rs`)
follows two other projects closely, without copying their code:

- Which differences between two releases' blueprints count as a change
  (numbers rounded to four decimals, 0 read as "not set" where it means none,
  categories compared as a set), and the release from which the FA repository
  holds every unit (3738), follow
  [Garanas/faf-workshop](https://github.com/Garanas/faf-workshop)
  (`UnitSummary.cs`, `tools/generate-unit-data.cs`), distributed under the MIT
  License. Copyright (c) 2024 (Jip) Willem Wijnia.
- The DPS tests use the weapon cases of the FAF unit database,
  [FAForever/etfreeman-db](https://github.com/FAForever/etfreeman-db)
  (`dpsCalculator.spec.js`), distributed under the MIT License by its
  contributors. The calculation itself is the game's own unit view
  (`lua/ui/game/unitviewDetail.lua` in FAForever/fa).

Nothing of either project is embedded, linked to or fetched by the client.

## Lucide icons

The drawings in `ui/src/design-system/Icon.tsx`, except the GitHub, Twitch and
Discord marks, are taken from [Lucide](https://lucide.dev) (`lucide-static`
1.55.0). Only the drawing data is copied; no Lucide package is installed. The
same notice is kept at the top of that file, where the build carries it into
the shipped code.

```text
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

Of the icons used, arrow-left, arrow-right, calendar, check, chevron-down,
chevron-right, chevron-up, clock, download, external-link, info, lock, log-out,
minus, plus, search, smile, trash-2, upload and x are derived from the
[Feather](https://feathericons.com) project, under this licence:

```text
The MIT License (MIT)

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The GitHub, Twitch and Discord marks in the same file are drawn by this
project in the set's outline style. They are their owners' trademarks, used
only to name the service a link leads to.

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

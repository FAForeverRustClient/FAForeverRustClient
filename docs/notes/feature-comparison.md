# FAF-Client Feature-Vergleich: Rust vs. Python vs. Java

Stand: 2026-08-14 · Rust-Repo Basis `56e5b5e` (*feat: complete client implementation and UI modernization*)

> Momentaufnahme, nicht gepflegt. Seither sind unter anderem die erweiterte
> Replay-Suche, die Coop-Kampagne, der Turnier-Tab und die Kartensuche
> dazugekommen; die Tabellen unten kennen davon nichts.

Vergleichsbasis:

| Client | Pfad | Rolle |
|---|---|---|
| Rust/Tauri | `D:\Projects\FAF\FAForeverRustClient-PR` | Neuentwicklung (dieses Repo) |
| Python | `D:\Projects\FAF\Forks\py-client` | Legacy-Client (PyQt6) |
| Java | `D:\Projects\FAF\Forks\java-client` | Offizieller Client (JavaFX/Spring), Referenz |

## Methodik

Alle Einstufungen stammen aus dem Code, nicht aus READMEs. Geprüft wurden Modul- und Klassennamen,
Wire-Protokoll-Handler, Tests unter `crates/faf-app/tests/`, sowie TODO- und Stub-Marker.
Statuswerte für den Rust-Client:

- ✅ vollständig: Feature ist end-to-end vorhanden (Backend-Port + Service + UI)
- 🟡 teilweise: vorhanden, aber mit benannter Lücke
- ❌ nicht vorhanden
- 📝 nur Stub/TODO/Dead Code

Für Python und Java wird ✅ / 🟡 / ❌ ohne Detaillierung verwendet (Referenzspalten).

### Hinweis zur Historie dieses Dokuments

Die erste Fassung stufte den Matchmaker als Platzhalter ein, gestützt auf einen "Coming soon"-Text in
`ui/src/features/lobby/MatchmakerView.tsx`. Das war falsch: die Datei war toter Code ohne einen
einzigen Importeur. Der Tab `play` zeigte über `ui/src/features/nav/tabs.tsx` auf `LobbyView`, und
der dort eingebundene `MatchmakingPanel` ist vollständig implementiert. Die betroffenen sechs
Dateien wurden inzwischen entfernt (siehe Abschnitt "Erledigt").

---

## a) Gesamt-Feature-Matrix

### Login & Auth

| Feature | Python | Java | Rust | Belegstelle |
|---|---|---|---|---|
| OAuth2-Login (Authorization Code + PKCE) | ✅ | ✅ | ✅ | `crates/faf-app/src/infra/oauth.rs` · `src/oauth/` · `client/login/` |
| Token-Refresh / Session-Persistenz | ✅ | ✅ | ✅ | `crates/faf-app/src/infra/auth.rs`, `infra/session.rs` |
| Lobby-Session-Handshake (`/lobby/access`) | ✅ | ✅ | ✅ | `crates/faf-app/src/infra/lobby_ws.rs` (`fetch_access_url`) |
| UID-/Hardware-Token beim Login | ✅ | ✅ | ✅ | `natives/faf-uid*`, gebündelt via `src-tauri/tauri.conf.json` |
| Login-UI inkl. Fehlerpfade | ✅ | ✅ | ✅ | `ui/src/features/auth/LoginView.tsx`; Test `crates/faf-app/tests/auth.rs` |
| Abmelden / Account wechseln | ✅ | ✅ | ✅ | `crates/faf-app/src/services/auth.rs` |

### Lobby, Custom Games & Matchmaking

| Feature | Python | Java | Rust | Belegstelle |
|---|---|---|---|---|
| Lobby-WebSocket-Protokoll | ✅ | ✅ | ✅ | `crates/faf-app/src/infra/lobby_ws.rs` (1900+ Zeilen inkl. Tests) |
| Custom-Games-Browser (Liste/Detail) | ✅ | ✅ | ✅ | `ui/src/features/lobby/CustomGamesBrowser.tsx`, `LobbyView.tsx` |
| Spiel hosten (Titel, Mod, Rating-Range, Passwort) | ✅ | ✅ | ✅ | `ui/src/features/lobby/HostGameModal.tsx` |
| Beitreten inkl. passwortgeschützter Spiele | ✅ | ✅ | ✅ | `ui/src/features/lobby/PrivateGameDialog.tsx` |
| Spielfilter (Titel/Host/Map/Mod/Rating) | ✅ | ✅ | ✅ | `ui/src/features/lobby/GameFiltersModal.tsx` |
| Sortierung + Listen-/Kachelansicht, persistiert | ✅ | ✅ | ✅ | `CustomGamesToolbar.tsx`, Persistenz via `Settings.setBrowsing` |
| Matchmaker-Queues (`matchmaker_info`) | ✅ | ✅ | ✅ | `lobby_ws.rs:617` + `parse_matchmaker_queues():1263` |
| Queue betreten/verlassen | ✅ | ✅ | ✅ | `lobby_ws.rs:222 fn matchmake()` |
| Mehrere Queues gleichzeitig | ✅ | ✅ | ✅ | `ui/src/features/lobby/MatchmakingPanel.tsx` |
| Match-Found-/Launching-State-Machine | ✅ | ✅ | ✅ | `lobby_ws.rs:580-662` |
| Party: erstellen, einladen, annehmen, kicken, verlassen | ✅ | ✅ | ✅ | `lobby_ws.rs:234-258`; `MatchmakerPartyPanel.tsx` |
| Fraktionswahl für die Party | ✅ | ✅ | ✅ | `lobby_ws.rs:259`; `MatchmakerFactionPicker.tsx` |
| Party-Chat | ✅ | ✅ | ✅ | `ui/src/features/lobby/MatchmakerPartyChat.tsx` |
| Map-Pool-Anzeige je Queue | ✅ | ✅ | ✅ | `ui/src/features/lobby/MatchmakerMapPoolModal.tsx` |
| Map-Vetos | ✅ | ✅ | ✅ | `lobby_ws.rs:272`, `:1332` |
| Queue-Pop-Timer | ✅ | ✅ | ✅ | `MatchmakingPanel.tsx` (`queueClocks`) |

### GPGNet, ICE-Adapter & Verbindungsaufbau

| Feature | Python | Java | Rust | Belegstelle |
|---|---|---|---|---|
| GPGNet-Protokoll (Encode/Decode) | ✅ | ✅ | ✅ | `crates/faf-domain/src/protocol/gpgnet.rs` |
| GPGNet-Server für FA | ✅ | ✅ | ✅ | `crates/faf-app/src/infra/relay.rs` |
| JSON-RPC zum ICE-Adapter | ✅ | ✅ | ✅ | `crates/faf-app/src/infra/jsonrpc.rs` |
| Java-ICE-Adapter starten/steuern | ✅ | ✅ | ✅ | `crates/faf-app/src/infra/ice_java.rs` |
| Go-Adapter `faf-pioneer` | 🟡 | ❌ | ✅ | `crates/faf-app/src/infra/ice_pioneer.rs` |
| Adapter-Wahl zur Laufzeit (ohne Neustart) | ❌ | ❌ | ✅ | `crates/faf-app/src/infra/ice_select.rs` |
| Coturn-/ICE-Server-Bezug vom Server | ✅ | ✅ | ✅ | `lobby_ws.rs` (`ice_servers`) |
| Gebündelte JRE für den Java-Adapter | ❌ | ✅ | ✅ | `crates/faf-app/src/infra/java_runtime.rs` |
| Verbindungs-Diagnosedialog | ✅ | ✅ | 🟡 | Rust: nur Status in `ClientStatusBar.tsx`; kein Peer-Diagnosefenster wie `ConnectivityDialog.py` |

### Spielstart, Patching & Versionierung

| Feature | Python | Java | Rust | Belegstelle |
|---|---|---|---|---|
| FA-Prozess starten (Args, Logpfad) | ✅ | ✅ | ✅ | `crates/faf-app/src/infra/game.rs:424` |
| Featured-Mod-Update (MD5-Diff je Datei) | ✅ | ✅ | 🟡 | `infra/game_updater.rs`: nur Basis-Mods `faf`/`ladder1v1`/`fafbeta`/`fafdevelop` (`BASE_FEATURED_MODS`, Zeile 185) |
| Engine-Versions-Patch in `ForgedAlliance.exe` | ✅ | ✅ | ✅ | `game_updater.rs:35 VERSION_ADDRESSES` |
| Content-adressierter Datei-Cache | ✅ | ✅ | ✅ | `game_updater.rs` |
| `fa_path.lua` generieren | ✅ | ✅ | ✅ | `game_updater.rs` |
| Auto-Download fehlender Map/Sim-Mods vor Start | ✅ | ✅ | 🟡 | Nur manueller "Download map"-Button in `LobbyView.tsx` |
| Fortschritt je Datei beim Patchen | ✅ | ✅ | ❌ | Rust meldet nur Schritte (`PreparationStep`) |
| Offline-/Skirmish-Start | ✅ | ✅ | ✅ | `game.rs:200 launch_offline()` |
| Spiel-Logs sammeln + Retention | ✅ | ✅ | ✅ | `crates/faf-app/src/infra/game_logs.rs` |
| Log-Analyse mit Fehlerhinweisen | ❌ | ✅ | ❌ | Java: `logging/analysis/LogAnalyzerService.java` |

### Chat & Social

| Feature | Python | Java | Rust | Belegstelle |
|---|---|---|---|---|
| IRC-Verbindung + Auth | ✅ | ✅ | ✅ | `crates/faf-app/src/infra/irc.rs`, `infra/irc_session.rs` |
| Kanäle: join/part, Topic, Userliste | ✅ | ✅ | ✅ | `crates/faf-domain/src/state/chat.rs` |
| Auto-Join inkl. Sprachkanal nach OS-Locale | ✅ | ✅ | ✅ | `state/chat.rs:333`, `:349` |
| Privatnachrichten als eigene Tabs | ✅ | ✅ | ✅ | `state/chat.rs:145 is_private()` |
| Unread-/Mention-Zähler | ✅ | ✅ | ✅ | `state/chat.rs:121`, `:124` |
| Scrollback-Retention über Reconnects | ✅ | ✅ | ✅ | `state/chat.rs:132 RetainedChatHistory` |
| Moderator-Elevation anzeigen | ✅ | ✅ | ✅ | `state/chat.rs:102 is_moderator()` |
| Join/Part-Meldungen ausblendbar | ✅ | ✅ | ✅ | `state/chat.rs:176 show_joins_parts` |
| Nutzer stummschalten (lokal) | ✅ | ✅ | ✅ | `ui/src/features/chat/UserMenu.tsx:112` |
| Individuelle Namensfarben | ✅ | ✅ | ✅ | `ui/src/features/settings/ChatNameColorSettings.tsx` |
| Freunde / Feinde (server-seitig) | ✅ | ✅ | ✅ | `crates/faf-domain/src/state/social.rs` |
| Clan-Tag + Clan-Ansicht | ✅ | ✅ | ✅ | `ui/src/features/player-card/PlayerClanView.tsx` |
| Avatare in Roster/Karte | ✅ | ✅ | ✅ | `state/social.rs` (`avatar_url`) |
| Länderflaggen | ✅ | ✅ | ✅ | `ui/src/shared/countryFlags.ts` |
| Private Notizen zu Spielern | ❌ | ✅ | ✅ | `PlayerNoteEditor.tsx`; Test `tests/player_notes.rs` |
| Emoticons / Emoji-Picker | ❌ | ✅ | ❌ | Java: `chat/emoticons/` (7 Klassen) |
| Nachrichten-Reaktionen | ❌ | ✅ | ❌ | Java: `chat/ReactionController.java` |
| Typing-Indikator | ❌ | ✅ | ❌ | Java: `chat/TypingState.java` |
| Nick-Autovervollständigung | ❌ | ✅ | ❌ | Java: `chat/AutoCompletionHelper.java` |
| URL-Vorschau im Chat | ❌ | ✅ | ❌ | Java: `chat/UrlPreviewResolverImpl.java` |

### Replay-Vault

| Feature | Python | Java | Rust | Belegstelle |
|---|---|---|---|---|
| Online-Vault-Suche | ✅ | ✅ | ✅ | `crates/faf-app/src/infra/replay.rs:542` |
| Erweiterte Filter | ✅ | ✅ | ✅ | `ui/src/features/replays/AdvancedReplayFilters.tsx` |
| Replay-Download + lokale Ablage | ✅ | ✅ | ✅ | `replay.rs:282`; Test `tests/replay_download.rs` |
| Lokale Replays scannen | ✅ | ✅ | ✅ | `replay.rs:601` |
| `.fafreplay`-Header parsen (Lua-Binärformat) | ✅ | ✅ | ✅ | `replay.rs:869 parse_replay_lua()` |
| Live-Replay (WebSocket-Relay + FA) | ✅ | ✅ | ✅ | `replay.rs`, `services/replays.rs:31` |
| 5-Minuten-Live-Delay durchgesetzt | ✅ | ✅ | ✅ | Test `tests/live_replay_delay.rs` |
| Live-Replay "später automatisch starten" | ❌ | 🟡 | ✅ | `services/replays.rs:79 TrackLive` |
| Detail-Tabs (Chat-Log, Economy-Charts) | ✅ | 🟡 | ❌ | Python: `src/replays/replaydetails/tabs/`, `zigparser/` |

### Map- & Mod-Vault

| Feature | Python | Java | Rust | Belegstelle |
|---|---|---|---|---|
| Vault durchsuchen (JSON:API) | ✅ | ✅ | ✅ | `infra/maps.rs`, `infra/mods.rs` |
| Installieren / Deinstallieren | ✅ | ✅ | ✅ | `infra/vault_install.rs`, `maps.rs:195` |
| `mod_info.lua` parsen | ✅ | ✅ | 🟡 | `mods.rs:295`: zeilenbasiert, kein vollständiger Lua-Parser |
| Mods aktivieren/deaktivieren via `game.prefs` | ✅ | ✅ | ✅ | `mods.rs:569` |
| Bewertungen lesen und schreiben | ✅ | ✅ | ✅ | `infra/reviews.rs`; Test `tests/reviews.rs` |
| Map/Mod hochladen | ✅ | ✅ | ✅ | `infra/uploads.rs`; Test `tests/uploads.rs` |
| Map-Generator (Neroxis) | ✅ | ✅ | ✅ | `infra/map_generator.rs` |

### Leaderboards, Turniere, Co-op, Tutorials

| Feature | Python | Java | Rust | Belegstelle |
|---|---|---|---|---|
| Rating-Leaderboards (paginiert) | ✅ | ✅ | ✅ | `infra/leaderboard.rs` |
| Ligen/Divisionen + Seasons | ✅ | ✅ | ✅ | `state/leaderboard.rs:30`, `:39`, `:54` |
| Spielerprofil inkl. Achievements | ✅ | ✅ | ✅ | `infra/player_card.rs:182` |
| Eigenen Avatar wechseln | ✅ | ✅ | ✅ | `ui/src/features/player-card/OwnAvatarPicker.tsx` |
| Rating-Verteilungskurve | ❌ | ✅ | ❌ | Java: `leaderboard/LeaderboardDistributionController.java` |
| Turnierliste | ✅ | ✅ | ✅ | `infra/tournaments.rs`; Test `tests/tournaments.rs` |
| Turnier-Bracket-Ansicht | ✅ | ✅ | 🟡 | Java rendert die volle Bracket-Seite in einer WebView |
| Co-op Missionen + Szenarien | ✅ | ✅ | ✅ | `infra/coop.rs` |
| Co-op Rekord-Leaderboard | ✅ | ✅ | ✅ | `coop.rs:150`, `state/coop.rs:133` |
| Tutorials (Liste, Detail, Start) | ✅ | ✅ | 🟡 | `infra/tutorials.rs`; `TutorialsView.tsx:159` liefert teils noch "Coming soon" |

### Benachrichtigungen, Einstellungen, Client-Update

| Feature | Python | Java | Rust | Belegstelle |
|---|---|---|---|---|
| In-App-Toasts + Notification-Center | ✅ | ✅ | ✅ | `services/notifications.rs`; `NotificationCenter.tsx` |
| OS-Benachrichtigungen | ✅ | ✅ | ✅ | `ui/src/ipc/native.ts` |
| Sounds | ✅ | ✅ | 🟡 | `notificationSound.ts`: synthetischer WebAudio-Ton, keine Audiodateien |
| Tray-Icon inkl. Menü | ✅ | ✅ | ✅ | `src-tauri/src/lib.rs:289-321` |
| Feinsteuerung je Ereignistyp | ✅ | ✅ | 🟡 | Python: `src/notifications/ns_settings.py` feiner |
| Taskbar-Fortschritt | ❌ | ✅ | ❌ | Java: `ui/taskbar/` |
| Persistente Einstellungen | ✅ | ✅ | ✅ | `infra/settings_file.rs` |
| Themes | ✅ | ✅ | 🟡 | Rust: feste Token-Themes; Java/Python laden Themes vom Datenträger |
| Client-Update via GitHub Releases | ✅ | ✅ | ✅ | `infra/client_update.rs`; Test `tests/client_update.rs` |
| Signaturprüfung des Updates | ❌ | ❌ | ❌ | In `client_update.rs:21-26` als bewusste Lücke dokumentiert |

### Lokalisierung (i18n)

| Feature | Python | Java | Rust | Belegstelle |
|---|---|---|---|---|
| Übersetzungs-Framework | ❌ | ✅ | 🟡 | **Neu:** `ui/src/i18n/` (eigenes typisiertes Katalogmodul). Java: `i18n/` + 18 Bundles |
| Sprachwahl in den Einstellungen | ❌ | ✅ | 🟡 | **Neu:** `GeneralSettingsSection.tsx`; bisher Englisch + Deutsch |
| Lokalisierte Datums-/Zahlenformate | ❌ | ✅ | ✅ | **Neu:** `ui/src/shared/dates.ts`, `i18n/index.ts formatNumber` |
| Migrierte UI-Strings | n/a | ✅ | 🟡 | Bisher Navigation + Shell + General-Settings; Rest folgt |
| Backend-Strings (Fehler, Statustexte) | ❌ | ✅ | ❌ | ~166 Strings in `crates/faf-app/src/`, noch fest englisch |

### Sonstiges

| Feature | Python | Java | Rust | Belegstelle |
|---|---|---|---|---|
| News | ✅ | ✅ | 🟡 | `NewsView.tsx`: iframe auf `faforever.com/newshub` |
| Unit-Datenbank | ✅ | ✅ | 🟡 | `UnitsView.tsx`: iframe auf die ETFreeman-DB |
| Discord Rich Presence | ❌ | ✅ | ✅ | `infra/discord.rs`; Test `tests/discord_presence.rs` |
| Steam-Integration | ✅ | ✅ | ❌ | Java: `steam/SteamService.java` |
| Screenshot-Upload zu Imgur | ❌ | ✅ | ❌ | Java: `uploader/imgur/` |
| Spieler melden (Moderation Report) | ✅ | ✅ | ✅ | `infra/reporting.rs`; Test `tests/reporting.rs` |
| Admin: Spiel schließen, Broadcast, Ban | ✅ | ✅ | ❌ | Java: `moderator/ModeratorService.java`; Python: `src/power/actions.py` |

---

## b) Priorisierte Lückenliste

Aufwand grob geschätzt (S ≤ 1 Tag, M ≈ 2-5 Tage, L > 1 Woche).

| # | Lücke | In | Warum wichtig | Aufwand |
|---|---|---|---|---|
| L1 | **i18n vollständig ausrollen** (in Arbeit) | Java | Fundament steht, ~660 UI-Strings noch zu migrieren | L |
| L2 | **Auto-Download von Maps/Sim-Mods vor Spielstart** | Python, Java | Beitritt zu Spielen mit unbekannter Map schlägt praktisch fehl | M |
| L3 | **Featured-Mod-Update für Total-Conversion-Mods** | Python, Java | Nomads/LOUD u. ä. starten nicht (`game_updater.rs:185`) | M |
| L4 | **Update-Signaturprüfung** | (auch Java fehlt sie) | Client lädt und startet eine EXE ohne Signaturprüfung | M |
| L5 | **Moderator-/Admin-Werkzeuge** | Python, Java | Moderatoren können den Client nicht produktiv nutzen | M |
| L6 | **Echte Notification-Sounds** | Python, Java | Aktuell zwei synthetische WebAudio-Töne | S |
| L7 | **Feingranulare Benachrichtigungs-Matrix** | Python | Python hat 5 Hook-Typen mit eigenen Einstellungen | S |
| L8 | **Chat: Nick-Autovervollständigung** | Java | Alltagsfunktion, Fehlen fällt sofort auf | S |
| L9 | **Chat: Emoticons/Emoji-Picker** | Java | Sichtbarer Komfortunterschied | M |
| L10 | **Benutzerdefinierte Themes vom Datenträger** | Python, Java | Etabliertes FAF-Feature | M |
| L11 | **Replay-Detailansicht (Chat-Log, Economy-Charts)** | Python | Rust liest nur den Header | L |
| L12 | **Turnier-Bracket-Ansicht** | Java | Rust zeigt nur Liste + Beschreibungstext | S |
| L13 | **Log-Analyse mit Fehlerhinweisen** | Java | Reduziert Support-Aufwand deutlich | M |
| L15 | **Vollständiger Lua-Parser für `mod_info.lua`** | Python, Java | Mods mit verschachtelten Tabellen unvollständig gelesen | M |
| L16 | **Datei-granularer Fortschritt beim Patchen** | Python, Java | Client wirkt bei großen Updates eingefroren | S |
| L17 | **Verbindungs-Diagnosedialog** | Python, Java | Wichtig für Support bei NAT-/ICE-Problemen | M |
| L18 | **Rating-Verteilungskurve** | Java | Rein darstellend | S |
| L19 | **Chat: Reaktionen, Typing, URL-Vorschau** | Java | Komfort, nur Java hat sie | M |
| L20 | **Taskbar-Fortschritt** | Java | Kosmetisch | S |
| L21 | **Imgur-Upload** | Java | Randfunktion | S |
| L22 | **Steam-Integration** | Python, Java | Randfunktion | S |
| L23 | **News nativ statt iframe** | Python, Java | Nativ wäre offline- und themefähig | M |

### Erledigt

| # | Punkt | Ergebnis |
|---|---|---|
| L14 | **Toten Code entfernen** | `PlayView.tsx`, `MatchmakerView.tsx`, `CoOpView.tsx`, `CustomGamesView.tsx`, `HostGameDialog.tsx`, `mapInfo.ts` gelöscht. Beseitigte 3 von 3 Typecheck-Fehlern, 32 von 32 ESLint-Fehlern und 6 von 11 Architektur-Verstößen. |

---

## c) Wo der Rust-Client über Python/Java hinausgeht

| Feature | Belegstelle | Gegenüber |
|---|---|---|
| **Zwei ICE-Backends mit Laufzeitumschaltung** | `infra/ice_select.rs` | Java kennt `faf-pioneer` gar nicht; Python nur rudimentär |
| **Gebündelte JRE + gebündelter Go-Adapter** | `src-tauri/tauri.conf.json` | Python setzt System-Java voraus |
| **Live-Replay "später automatisch starten"** | `services/replays.rs:79` | Referenzclients erzwingen nur das Warten |
| **Domain als reine, testbare Schicht** | `crates/faf-domain/`, `tests/conformance_fixtures.rs` | Backend- und Frontend-Reducer werden gegen dieselben Fixtures geprüft |
| **Discord Rich Presence ohne SDK-Abhängigkeit** | `infra/discord.rs`, `protocol/discord.rs` | Python hat es gar nicht |
| **Gehärtete Embed-/Link-Behandlung** | `shared/embedSecurity.ts`, strikte CSP | Kein Äquivalent in den Referenzclients |
| **Pfad-Escape-Schutz bei Vault-Operationen** | `maps.rs:681`, `vault_install.rs` | Zip-Slip- und Größenschutz explizit getestet |
| **Ausführbare Architekturregeln** | `scripts/check-architecture.mjs` | Schichtgrenzen, Locale-Vererbung und Schriftgrößen sind CI-geprüft |
| **Breite automatisierte Abdeckung** | 19 Integrationstests in `crates/faf-app/tests/` | Deutlich mehr als im Python-Client |

---

## Zusammenfassende Einschätzung

Der Rust-Client ist erheblich weiter, als einzelne Platzhaltertexte im Repo suggerierten. Login/Auth,
Lobby & Matchmaking, GPGNet/ICE, Chat & Social, Replay-Vault, Map-/Mod-Vault, Leaderboards, Co-op und
Client-Auto-Update sind funktional auf Augenhöhe mit dem Java-Referenzclient oder darüber.

Die substanziellen Restlücken liegen in drei Bereichen:

1. **Vollständigkeit des Spielstarts** (L2, L3, L16): der spürbarste Blocker für den Alltagsbetrieb.
2. **Internationalisierung** (L1): Fundament steht seit 2026-08-14, die Masse der Strings fehlt noch.
3. **Betreiber- und Moderatorenfunktionen** (L5, L13): nötig, bevor der Client Java ablösen kann.

Alles Übrige ist Komfort und blockiert die Ablösung nicht.

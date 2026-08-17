# Bestandsaufnahme: Turnier-Feature gegen faf-tournaments

Aufgenommen 2026-08-17, nach der Feststellung, dass nach rund 20 Arbeitsstunden kein Feature
verlässlich läuft. Gelesen wurde die Quelle, nicht die eigene Dokumentation:
`D:\Projects\FAF\faf-tournaments` (`server.js`, `lib/`, `public/app*.js`) gegen unseren Baum.

Dieses Dokument ersetzt `faf-tournaments-api.md` als Referenz für alles, was unten belegt ist.
Jene Datei ist aus einer Teillektüre entstanden und in mindestens drei Punkten nachweislich
falsch (Abschnitt 4).

---

## 1. Größenverhältnis

| Seite | Zeilen | Funktionsumfang |
|---|---:|---|
| Server (`server.js` + `lib/`) | 5.686 | 100 % |
| Website (`public/app*.js` + CSS/HTML) | 9.067 | 100 % |
| **Zusammen** | **14.753** | **100 %** |
| Unser Turnier-Code | 12.048 | **46 %** |

46 % ist gemessen, nicht geschätzt: 38 von 83 Server-Aktionen sind im Port vorhanden, und
`parse_tourney` liest 31 von ~68 Feldern, die `publicView` sendet.

Auf Parität hochgerechnet: **~26.000 Zeilen für das, was im Original 14.753 sind.** Faktor 1,8.

### Wohin unsere 12.048 Zeilen gehen

| Datei | Zeilen | Was es tut |
|---|---:|---|
| `faf-domain/state/tourney.rs` | 2.491 | Modell, Reducer, Unit-Tests |
| `faf-app/tests/tourney.rs` | 1.593 | Integrationstests **gegen den Fake** |
| `faf-app/infra/tourney_fake.rs` | 1.590 | **Zweite Implementierung des Servers**, in Rust |
| `faf-domain/protocol/tourney.rs` | 955 | Codec + 24 Tests |
| `faf-app/services/tourney.rs` | 940 | Befehlsabwicklung |
| `faf-app/infra/tourney.rs` | **646** | **Der einzige Code, der mit dem echten Server spricht** |
| `faf-app/ports/tourney.rs` | 246 | Trait mit 38 Methoden |
| `ui/store/reducers/tourney.ts` | 185 | TS-Zwilling des Reducers |
| `ui/features/tournaments/*` | 3.402 | Oberfläche |

**5,4 % des Codes redet mit dem Server. Und das ist der am schwächsten geprüfte Teil.**

---

## 2. Warum nichts läuft: es hat den echten Server nie getroffen

Belegkette, jeder Punkt nachgeprüft:

1. **Die 24 Codec-Tests arbeiten ausnahmslos mit handgeschriebenen `json!`-Objekten.** Kein
   einziger benutzt eine aufgezeichnete Server-Antwort. Sie prüfen also unsere *Annahme* über
   die Antwortform — genau die Annahme, die aus der unvollständigen Doku stammt.
2. **Im ganzen Repo liegt keine aufgezeichnete Antwort** von `tournaments.doodlepros.com`.
   Gesucht wurde nach jeder `.json` außerhalb von `node_modules`/`target`.
3. **`infra/tourney.rs` hat keinen HTTP-Mock** (kein wiremock, kein mockito). URL- und
   Body-Bau sind gegen nichts geprüft.
4. **Alle Integrationstests laufen gegen `fake_ports()` / `FakeTourney`.** Die 1.593 Zeilen
   beweisen, dass der Client mit unserer eigenen 1.590-Zeilen-Nachbildung des Servers
   übereinstimmt. Über den Server sagen sie nichts.

### Der Beweis dafür, in einem Fund

`PlayerCardClient::search_players` (`infra/player_card.rs:206`):

```rust
let filter = format!("login=={}*", quote(trimmed));
```

`quote()` setzt die Anführungszeichen, das `*` landet außerhalb → `login=="Seraphim"*`. RSQL
lehnt das ab:

> Filter expression is not in expected format at: login=="Seraphim"*

Die Funktion hat **nie** funktioniert. Sie trägt den Kommentar „For pickers, so a tournament
entry can carry a real account instead of a typed name" — geschrieben genau für den
Teilnehmer-Picker —, hatte bis 2026-08-17 **null Aufrufer**, und kein Test führt je eine
Abfrage aus. Sie brach beim ersten echten Aufruf.

Korrekt wäre die Wildcard *innerhalb* der Anführungszeichen: `login=="Seraphim*"`.

Das ist keine Ausnahme, das ist das Muster: geschrieben, nie ausgeführt, grün.

---

## 3. Warum es so lange dauert: 13 Stellen pro Server-Aktion, die eine Zeile umhüllen

`infra/tourney.rs:155` hält die ganze Schreib-Oberfläche in einer Funktion:

```rust
/// One write against a tournament. Every one of them is a `POST` to
/// `/api/t/{id}/{action}`, whatever it does.
async fn act(&self, tournament_id: &str, action: &str, body: Value) -> Result<(), RequestError>
```

Alle 38 Port-Methoden sind Einzeiler darüber:

```rust
async fn publish(&self, id: &str) -> Result<(), RequestError> {
    self.act(id, "publish", json!({})).await
}
```

Darüber liegt pro Aktion:

| # | Stelle |
|---:|---|
| 1 | `TourneyCommand`-Variante |
| 2 | `TourneyAction`-Variante (nur damit ein Spinner weiß, zu welchem Knopf er gehört) |
| 3 | Body-Bauer in `protocol/tourney.rs` |
| 4 | Trait-Methode in `ports/tourney.rs` |
| 5 | Echte Implementierung (Einzeiler über `act`) |
| 6 | Fake-Implementierung (Nachbau der Server-Logik) |
| 7 | Service-Arm |
| 8 | Integrationstest gegen den Fake |
| 9 | Conformance-Fall, falls Zustand betroffen |
| 10 | `pnpm run bindings` |
| 11 | TS-Reducer-Zwilling |
| 12–14 | Prop-Durchleitung `TournamentsView` → `DetailPane` → `ManagePanel` → Komponente |
| 15 | i18n-Schlüssel, mindestens `en` + `de` |

**~13–15 Editierstellen über 8 Dateien, pro Aktion, für einen POST.** Bei 45 offenen
Aktionen sind das ~600 Editierstellen.

### Und der Zustand, den das schützt, existiert nicht

`reduce` für `ActionSucceeded` (`state/tourney.rs:1862`) tut genau eines: `pending = None`.
Danach lädt `write_selecting` Liste **und** Detail komplett neu. Kein einziger Schreibvorgang
wird lokal angewendet.

Der Slice ist also ein Cache von `publicView`. Es gibt auf dem Schreibpfad keine lokale
Zustandslogik, die ein Zwilling oder eine Conformance-Klammer schützen könnte. Die 43
Befehls- und ~30 Aktionsvarianten kaufen **Spinner-Zuordnung pro Knopf** — und sonst nichts.

Die Conformance-Klammer, die ich in den letzten zwei Sitzungen für dieses Feature ausgebaut
habe, ist für den Schreibpfad daher Zeremonie. Für Lesepfade (`DetailLoaded` verwerfen, wenn
veraltet; Chat-Räume; Suchantworten überholen sich) ist sie richtig und hat auch einen echten
Fehler gefunden. Für die 38 Schreibaktionen nicht.

---

## 4. Die eigene Doku ist falsch, und darauf wurden Entscheidungen gebaut

`faf-tournaments-api.md` behauptet, `POST /api/tournaments` sei „read in full". Nachweislich
nicht:

| Behauptung der Doku | Wirklichkeit |
|---|---|
| `ratingDate` nicht im Create-Body | `server.js:1627` nimmt es an |
| `publicView` sendet keine Rating-Art | `server.js:962` sendet `ratingType` **und** `ratingDate` |
| Create-Body = 8 Felder | ~40 Felder, u. a. `rewards`, `sponsors`, `prize`, `streams`, `lobbyOptions`, `mods`, `seriesId`, `minTeams`, `ffaCfg`, `plan`, `veto`, `ratingDate` |

**Folge, und das ist mein Fehler:** ich habe letzte Sitzung den Zweig `asksForRating` samt
Übersetzungsschlüssel gelöscht, mit der Begründung, der Client könne ein unbewertetes Turnier
nicht erkennen. Er kann es — `ratingType` kommt mit jeder Antwort. Und ich habe die
Fehlannahme anschließend als „offene Frage" in die Doku geschrieben, wo sie den nächsten Leser
in dieselbe Falle führt.

### Felder, die der Server sendet und `parse_tourney` wegwirft (37)

`rewards`, `prize`, `sponsors`, `published`, `publishAt`, `archived`, `abandoned`, `seriesId`,
`qualifiers`, `feedsInto`, `seriesName`, `seriesColor`, `minTeams`, `descImages`, `streams`,
`lobbyOptions`, `mods`, `draftOrder`, `ffaCfg`, `plan`, `perRoundBo`, `cfg`, `ratingType`,
`ratingDate`, `challongeDate`, `rounds`, `subs`, `pendingCaptains`, `imported`, `importedType`,
`importedGroups`, `importedStandings`, `standingsOnly`, `hasOrganizer`, `createdByName`,
`source`, `sourceUrl`, `out`

Mehrere davon sind keine Zierde: `plan` ist der Best-of-Plan pro Runde, `ffaCfg` die ganze
FFA-Konfiguration, `importedStandings` die Tabellen importierter Turniere, `veto` der Zustand
der Map-Bans.

---

## 5. Replays: der Server verlangt sie, wir können sie nicht wegwerfen

Zur Ansage „wir brauchen kein Replay zum Verifizieren" — `server.js:4607`, `report_submit`:

```js
if (ids.length !== newGames)
  return bad(res, 'Provide exactly ' + newGames + ' replay ID… one for each newly reported game');
```

**Harte Server-Prüfung.** Entfernen wir die Replay-Ids clientseitig, wird jede
Spielermeldung abgelehnt — mit genau diesem Satz.

Der Organisator-Pfad ist anders: `report` (`server.js:4776`) macht sie optional
(`if (Array.isArray(b.replayIds))`), und ein expliziter Sieger ist erlaubt.

Es gibt also drei Wege, keinen vierten:

1. `playerReporting: false` setzen — dann meldet nur der Organisator, ohne Replay-Zwang. Ein
   Turnier-Schalter, kein Client-Umbau.
2. Den Server ändern. Es ist unser Fork.
3. So lassen.

Was **nicht** geht: die Replay-Logik im Client löschen und hoffen.

*(Anmerkung zum Umfang: gemeint ist die Replay-Id-Pflicht beim Melden. Der Replays-Tab des
Clients ist ein eigenes Feature und davon nicht berührt.)*

---

## 6. Abgleich der Schreib-Aktionen

Server: 83. Port: 38. Fehlend: 45.

**Vorhanden (38):** `add_player`(=`org_add_player`), `advance`(=`phase`), `archive`(=`delete`),
`articles`, `assign_pool`, `cancel_join`, `chat_post`, `chat_read`, `chat_rooms`, `check_in`,
`confirm_report`, `create`, `create_team`, `decide_report`(=`report`), `delete_news`, `detail`,
`disband_team`, `edit_info`, `hosting`, `invite_player`, `invite_to_team`, `leave_team`, `list`,
`post_news`, `publish`, `rename_team`, `request_join`, `reseed`, `respond_invite`,
`respond_join`, `respond_signup`, `save_pool`, `set_division`, `sign_up`, `split_divisions`,
`submit_report`, `uninvite`, `withdraw`

**Fehlend (45):** `abandon`, `add_desc_image`, `add_organizer`, `cancel_invite`, `chat_delete`,
`chat_mute`, `claim_organizer`, `copy_maps`, `decline_invite`, `edit_date`, `edit_format`,
`edit_player`, `faf_lookup`, `join_team`, `map_delete`, `map_publish`, `map_save`, `move_player`,
`news_edit`, `news_read`, `org_create_team`, `organizer_visibility`, `pick`, `pool_copy_sequence`,
`pool_delete`, `pool_publish`, `qualifier_add`, `qualifier_remove`, `remove_desc_image`,
`remove_organizer`, `replace_player`, `restore`, `secrets`, `set_captain`, `set_category`,
`set_maps`, `set_match_team`, `set_plan_round_bo`, `set_round_bo`, `set_series`, `set_team_name`,
`signup_team`, `undo_pick`, `veto_action`, `veto_setab`, `veto_undo`

---

## 7. Was daraus folgt

Nicht „mehr Features bauen". Vier Hebel, in dieser Reihenfolge:

### 7.1 Eine echte Server-Antwort ins Repo (der wichtigste Schritt)

Ein `GET /api/t/{id}` gegen die laufende Instanz, als Datei abgelegt, und `parse_tourney`
dagegen getestet. Das verwandelt den gesamten Codec von *Annahme* in *Tatsache* — und deckt in
einem Zug auf, welche der 37 ignorierten Felder wirklich ankommen und in welcher Form.

Solange das fehlt, ist jeder grüne Test über die Server-Grenze hinweg bedeutungslos.

### 7.2 `search_players` reparieren

Eine Zeile, blockiert gerade das Hinzufügen von Teilnehmern:

```rust
let filter = format!("login=={}", quote(&format!("{trimmed}*")));
```

Plus ein Test, der die erzeugte Filterzeichenkette festhält.

### 7.3 Die Aktions-Zeremonie einklappen

Da physisch alles `POST /api/t/{id}/{action}` ist, kann eine generische Aktion die 13 Stellen
auf etwa 3 senken: einen Befehl mit Aktionsname und typisiertem Body, einen Zeichenketten-
Schlüssel für den Spinner, einen Service-Arm. Die typisierten Bodys bleiben in `protocol`, wo
das Risiko liegt.

Preis: die Compilerprüfung „gibt es diese Aktion" fällt weg. Gegenwert: 45 offene Aktionen
kosten nicht mehr 600 Editierstellen, sondern etwa 140 — und der Fake muss nicht 45-mal
erweitert werden.

Das ist die Entscheidung, die zu treffen ist, bevor weitergebaut wird. Sie ist der Grund für
den Faktor 1,8.

### 7.4 `faf-tournaments-api.md` ersetzen oder löschen

Sie ist eine Nacherzählung und war die Quelle mehrerer falscher Entscheidungen. Entweder aus
`server.js` erzeugt oder ersatzlos weg, mit dem Verweis: lies `server.js`. Die Website
(`public/app*.js`, 9.067 Zeilen) ist zusätzlich eine vollständige, laufende Referenz für jeden
Ablauf — sie wurde bisher kaum benutzt.

---

## 8. Was gut ist

Nicht alles ist Ballast, und das Folgende sollte bleiben:

- **Das Bracket als expliziter Graph** (`winnerTo`/`loserTo`) statt geratener Rundengeometrie.
  Das ist echte Modellierungsarbeit und richtig.
- **Der Codec als eigene Schicht.** Der Server ist ohne Schema und antwortet mit `0`/`1` für
  Booleans, Millisekunden und ISO-Text gemischt, Zahlen als Zeichenketten. Die tolerante
  Leseschicht ist berechtigt — ihr fehlt nur eine echte Vorlage.
- **Der `LatestRequest`-Generationszähler.** Verhindert, dass eine überholte Antwort ein
  neueres Detail überschreibt. Nachweislich nötig.
- **Die Conformance-Klammer für Lesepfade.** Sie hat einen echten Fehler gefunden:
  `MatchReport::is_submittable` zählte leere Replay-Felder als Ids, hätte den Absende-Knopf
  freigegeben, und der Spieler hätte sein Ergebnis verloren.
- **Der schreibfähige Fake.** Für Entwicklung ohne Server wertvoll. Er darf nur nicht die
  Prüfinstanz *sein*.

---

## 9. Der schwerste Fund: `viewer` existiert nicht

`parse_viewer` liest `document["viewer"]`. **Der Server sendet kein solches Objekt.** Das Wort
kommt in `server.js` ausschließlich in Kommentaren vor. `publicView` hat es nicht.

Folge: `TourneyViewer::default()` bei jeder Antwort, also dauerhaft

- `logged_in: false` → `may_sign_up()` ist immer falsch → **der Anmelde-Knopf erscheint nie**
- `organiser: false` → **keine Organisator-Steuerung erscheint je**
- `signed_up_player_id: None` → Abmelden, Team bilden, beitreten: alles unmöglich
- `member_team_id: None` → kein Team, keine Meldung

**Der ganze Tab ist gegen den echten Server inert.** Jedes Gate hängt an einem Block, den es
nicht gibt. Das ist die eigentliche Antwort auf „nichts klappt" — nicht ein Fehler, sondern
ein erfundenes Datenmodell.

Der Server identifiziert ausschließlich über die Sitzung (`currentSession(req)`). Die Website
löst es so, und so muss es der Client auch:

| Was | Woher |
|---|---|
| angemeldet, FAF-Id, FAF-Name | **Eigener `auth`-Slice.** Der Client weiß das schon; er hat es nie benutzt |
| `signedUpPlayerId` | `players[]` nach `fafId == meine` durchsuchen |
| `memberTeamId` | Das gefundene `players[].teamId` |
| Organisator | `GET /api/my_tournaments` → Liste der eigenen Turniere; Mitgliedschaft = Organisator |

`organizerFafIds` ist **nicht** öffentlich; `organizersPublic` trägt nur Namen. Ein Vergleich
über Namen wäre die falsche Lösung. `my_tournaments` ist die richtige und ist ein
dokumentierter Endpunkt.

---

## 10. Plan

Reihenfolge nach Blockade-Wirkung, nicht nach Bequemlichkeit.

### Phase 1 — Was ersatzlos rausfliegt

Entscheidung des Auftraggebers 2026-08-17: **nur der Organisator trägt Sieg/Niederlage ein.**
Damit fällt der ganze Spieler-Meldepfad, und mit ihm die Replay-Pflicht.

| Weg | Warum |
|---|---|
| `report_submit`, `report_confirm` (Port, Service, Befehle, Aktionen) | Spieler melden nicht |
| `PendingReport`, `TourneyMatch::pending_report` | Es gibt keine Bestätigung mehr |
| `replay_ids`, `draw_replay_ids` (Match und Meldung) | `report` verlangt sie nicht |
| `MatchReport::new_games`, `is_submittable`, `usable_replay_count` | Regeln des gestrichenen Pfads |
| `clean()` / `usable()` im Service | Nur für Replay-Ids da |
| `Tourney::may_report`, `may_confirm`, `player_reporting` | Wir setzen `playerReporting: false` beim Anlegen |
| `map_key`, `match_vault_map`, `without_version` (Rust) | `shared/mapPresentation.ts::findVaultMap` tut es besser |
| `mapKey`, `matchVaultMap`, `withoutVersion` (TS) | dito |
| `TourneyViewer` in heutiger Form | Der Server füllt es nicht |
| Zugehörige Conformance-Fälle und Tests | Prüfen gestrichenen Code |

### Phase 2 — Was reparieren, weil es blockiert

1. `search_players`: Wildcard in die Anführungszeichen. Plus Test auf die Filterzeichenkette.
2. Identität aus dem `auth`-Slice ableiten statt aus `viewer`; Organisator über `my_tournaments`.
3. `parse_tourney`: `ratingType` und `ratingDate` lesen — sie kommen mit jeder Antwort.

### Phase 3 — Organisator-Meldung richtig bauen

`report` kann mehr, als wir nutzen. Vollständig abbilden:
Punktestand, expliziter Sieger, Forfeit-Kurzform, Korrektur eines fertigen Matches,
FFA-Sieger und FFA-Punkte.

### Phase 4 — Bestehendes benutzen

| Statt | Nimm |
|---|---|
| Eigenes Map-Matching und `<img>` | `findVaultMap` + `MapThumbnail` (Fallback-Kette, Fehler-Retry, Generator-Vorschau) |
| Erfundene Identität | `auth`-Slice |
| Eigene Namenssuche | `PlayerCardPort::search_players` (nach der Reparatur) |
| Nackte Namen | `PlayerChip` / `PlayerName`, wie Leaderboard und Chat |

### Phase 5 — Die Aktions-Zeremonie einklappen

Erst nachdem 1–4 stehen und beweisbar gegen den echten Server laufen. Vorher wäre es
Umbau an ungeprüftem Code.

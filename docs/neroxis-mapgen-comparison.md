# Neroxis-Mapgen: Feature-Vergleich Rust vs. Python vs. Java vs. Generator-CLI

Stand: 2026-08-16 · Rust-Repo Branch `feat/tutorials-guides`, Basis `582ab6f`

## Vergleichsbasis

| Quelle | Referenz | Rolle |
|---|---|---|
| **Rust/Tauri** | dieses Repo | Neuentwicklung |
| **Python** | `D:\Projects\FAF\Forks\py-client` (= `FAForever/client`) | Legacy-Client (PyQt6) |
| **Java** | `FAForever/downlords-faf-client` | Offizieller Client |
| **Generator** | `FAForever/Neroxis-Map-Generator`, **empirisch gegen `NeroxisGen_1.22.1.jar` verifiziert** | Autoritative Quelle |

Der Python-Code liegt an **zwei** Stellen, was leicht zu übersehen ist:

- `src/mapGenerator/` (328 Zeilen): nur Prozess-Handling und Download
- `src/games/mapgenoptions*.py` + `res/games/mapgen.ui` (~900 Zeilen + 32 KB UI): **der komplette Options-Dialog**

Wer nur `src/mapGenerator/` liest, hält den Python-Client für reproduktions-only. Das ist falsch:
er hat den umfangreichsten Optionsdialog der drei Clients.

## Methodik

Alle Aussagen stammen aus dem Quellcode. Zusätzlich wurde der **ausgelieferte JAR direkt
ausgeführt** (`natives/jre` = Temurin 25, weil Neroxis 1.22.x Class-File-Version 69 braucht) -
alle mit ⚡ markierten Befunde sind empirisch belegt, nicht aus dem Code geschlossen.

Status Rust-Client: ✅ Parität oder besser · 🟡 Lücke · ❌ fehlt · 🐞 fehlerhaft

---

## 1. Executive Summary

| # | Befund | Schwere |
|---|---|---|
| 1 | ⚡ Dichte-Slider senden 0–127, der Generator akzeptiert nur 0–1. **Beide** Referenzclients rechnen um, wir nicht | 🐞 **P0** |
| 2 | ⚡ Ungültige Spawn/Team- und Symmetrie/Team-Kombinationen werden nicht abgefangen | ❌ **P0** |
| 3 | ⚡ `--parse` existiert: Validierung + Namensauflösung **ohne** Generierung. **Kein Client nutzt es** | 💡 **Chance** |
| 4 | Rohargumente werden per `split_whitespace()` zerlegt → Pfade mit Leerzeichen brechen (Python nutzt `shlex`) | 🐞 **P1** |
| 5 | Versionsliste holt nur 30 von 130 Releases (keine Paginierung) | 🟡 **P1** |
| 6 | Optionslisten werden bei jedem Dialogöffnen neu vom JAR geholt; Python cacht sie pro Version als JSON | 🟡 **P1** |
| 7 | `numTeams = 0` (asymmetrisch) und 9–16 nicht erreichbar | ❌ **P1** |
| 8 | Kein Generator-Log: beide Referenzclients schreiben eines | ❌ **P1** |
| 9 | ⚡ Map-Styles haben Größen-/Spawn-/Team-Constraints. **Kein Client filtert danach** | 💡 **Chance** |
| 10 | ⚡ `--preview-path` erzeugt Vorschaubilder in einen eigenen Ordner. **Kein Client nutzt es** | 💡 **Chance** |

---

## 2. Die drei Clients im Überblick

### Python: der umfangreichste Dialog, die schwächste Validierung

Aufbau:

| Datei | Aufgabe |
|---|---|
| `mapgenManager.py` | Download, Versionsverwaltung, JAR-Cache |
| `mapgenProcess.py` | QProcess, stdout-Scraping, Fortschrittsdialog mit **Cancel** |
| `mapgenoptionsdialog.py` | Der Dialog, inkl. `OptionsExtractor` |
| `mapgenoptions.py` | Options-Abstraktion (ComboBox/SpinBox/Range → CLI-Argument) |
| `mapgenoptionsvalues.py` | Hartkodierte Fallback-Enums für alte Versionen |

Was der Python-Client **besser macht als Java und wir**:

- **Options-Cache pro Generatorversion.** `OptionsExtractor` ruft das JAR einmal pro Optionsliste
  auf und schreibt das Ergebnis nach `mapgen_options.json`, **verschlüsselt nach Version**. Beim
  nächsten Öffnen wird nichts mehr gestartet. Wir starten sechs JVMs bei jedem Dialogöffnen.
- **Vollständige Release-Liste.** `?per_page=100` plus Auswertung des GitHub-`Link`-Headers für
  Folgeseiten (`GITHUB_NEXT_PAGE`-Regex). Ergebnis in `release_tags` gecacht.
- **`shlex.split`** für Rohargumente: korrektes Shell-Quoting.
- **`--folder-path`-Schalter**: eine Checkbox stellt automatisch `--folder-path <User-Maps-Ordner>`
  voran.
- **„Run Help"-Button**: zeigt die `--help`-Ausgabe des Generators im Dialog.
- **Versions-Umschaltung zur Laufzeit** mit „Switch"-Button, plus Nachfrage bei neuer Version.
- **Mindestversion für Optionsextraktion**: unter 1.12.0 wird gar nicht erst versucht.
- **`RANDOM`-Sentinel** in jeder Combo; wählt man bei Prop/Resource `RANDOM`, werden die
  zugehörigen Dichte-Felder deaktiviert.

Was er **schlechter** macht: praktisch keine Eingabevalidierung. Spawns und Teams gehen 1–1000,
Map-Größe 2,5–80 km. Der Client verlässt sich darauf, dass der Generator meckert, und zeigt dessen
stdout in einem Dialog an.

**Wichtig:** Python nutzt bereits `--visibility` (das aktuelle Flag), nicht die Legacy-Aliase.

### Java: die strengste Validierung

`GenerateMapController` macht ungültige Eingaben *strukturell unmöglich*: `selectableSpawnCounts`
ist eine `FilteredList` mit Prädikat `value % numTeams == 0`, die bei jeder Team-Änderung neu
filtert. Man *kann* dort keine 5 Spawns bei 2 Teams einstellen.

Dafür: keine Versionsauswahl, kein Options-Cache, keine Paginierung, `commandLineArgs.split(" ")`.

### Rust: dazwischen, mit eigenen Stärken

Versionsauswahl im UI, Download-Größenlimit, sauberes Prozess-Reaping, Vorschau-Karten,
vierstufige Fortschrittsanzeige, benutzergesteuertes Cleanup mit Favoritenschutz. Aber: keine
Validierung, und der Dichte-Bug.

---

## 3. CLI-Flag-Matrix

| Flag | Generator | Python | Java | **Rust** |
|---|---|---|---|---|
| `--map-name` | ✔ | ✔ | ✔ | ✅ |
| `--map-size` | oGrids **oder** `10km` | ✔ (km, 1,25er-Raster) | ✔ (km-Spinner) | 🟡 nur oGrids, feste Liste |
| `--spawn-count` | 0–16 | ✔ 1–1000 | ✔ gefiltert | 🟡 2–16, ungefiltert |
| `--num-teams` | 0–16 (**0 = asymmetrisch**) | ✔ 1–1000 | ✔ 0, 2–16 | ❌ 2–8 |
| `--num-to-generate` | ✔ | ✔ | ✔ 1–50 | 🟡 1–10 |
| `--seed` | `Long` | ✔ | ✔ | 🟡 unvalidierter String |
| `--terrain-symmetry` | 22 Werte | ✔ | ✔ | ✅ |
| `--style` | 21 Presets | ✔ | ✔ | ✅ |
| `--terrain-style` | 24 | ✔ | ✔ | ✅ |
| `--texture-style` / `--biome` | 13 | ✔ | ✔ | ✅ |
| `--resource-style` | 6 | ✔ | ✔ | ✅ |
| `--prop-style` | 10 | ✔ | ✔ | ✅ |
| `--reclaim-density` | **0.0–1.0** | ✔ (`/100`) | ✔ (`/127`) | 🐞 **roh 0–127** |
| `--resource-density` | **0.0–1.0** | ✔ (`/100`) | ✔ (`/127`) | 🐞 **roh 0–127** |
| `--visibility` | aktuelles Flag | ✔ | ❌ | ❌ |
| `--tournament-style` / `--blind` / `--unexplored` | `hidden` (Legacy) | ❌ | ✔ | ✅ |
| `--visualize` | negierbar | nur roh | nur roh | ✅ (Timeout-Ausnahme korrekt) |
| `--debug` | negierbar | nur roh | nur roh | 🟡 nur roh |
| `--out-path` / `--folder-path` | ✔ | ✔ **Checkbox** | ❌ | ❌ |
| `--preview-path` | ✔ | ❌ | ❌ | ❌ |
| `--parse` | ✔ | ❌ | ❌ | ❌ |
| `--help` / `--version` | ✔ | ✔ Button | ❌ | ❌ |
| Optionslisten-Unterbefehle | 6 Stück | ✔ **gecacht** | ✔ | ✅ ungecacht |

---

## 4. Die Lücken im Detail

### 4.1 🐞 P0: Dichte-Einheiten ⚡

Die Hilfe des ausgelieferten JAR sagt wörtlich: *„Reclaim density for the generated map. **Min: 0
Max: 1**"*. Direkt verifiziert:

```
$ java -jar NeroxisGen_1.22.1.jar --parse ... --reclaim-density 64
Invalid value for option '--reclaim-density': Must be between 0 and 1 but was `64,000000`
```

Die 127 ist `GeneratedMapNameEncoder.NUM_BINS`, also die Auflösung der internen Diskretisierung -
nicht die Skala. Beide Referenzclients rechnen um:

- Java: Slider 0–127 (Bin-Skala) → `reclaimLowValue / 127f`
- Python: SpinBox 0–100 (Prozent) → `random.randrange(min, max+1) / 100`

Bei uns fehlt die Division. Slider bis 127 in
[GenerateMapModal.tsx:412](ui/src/features/maps/GenerateMapModal.tsx:412) und `:423`, roh
weitergereicht in
[protocol/map_generator.rs:554-571](crates/faf-domain/src/protocol/map_generator.rs:554). Der
Kommentar auf `:302` behauptet ausdrücklich das Gegenteil und ist zu korrigieren.

**Auswirkung:** Unangetastete Slider bleiben auf `None`, es wird kein Flag emittiert: es
funktioniert. Beim ersten Verschieben bricht der Lauf ab. Custom-Style mit Dichte ist unbenutzbar.

**Fix:** `/ 127.0` beim Emittieren, UI-Einheit belassen. Domain-Test, der prüft, dass der
emittierte Wert in `0.0..=1.0` liegt.

### 4.2 ❌ P0: Ungültige Kombinationen ⚡

```
$ java -jar NeroxisGen_1.22.1.jar --parse --spawn-count 5 --num-teams 2
Spawn Count `5` not a multiple of Num Teams `2`

$ java -jar NeroxisGen_1.22.1.jar --parse --num-teams 2 --terrain-symmetry POINT3
Terrain symmetry `POINT3` not compatible with Num Teams `2`
```

Regeln aus `MapGeneratorCommand.checkParameters` und den Record-Constructors:

| Regel | Prüfen wir? |
|---|---|
| `numTeams != 0 && spawnCount % numTeams != 0` | ❌ |
| `numTeams != 0 && terrainSymmetry.numSymPoints % numTeams != 0` | ❌ |
| `mapSize % 64 != 0` | ⚠️ implizit (Liste ist konform, Rohargumente umgehen sie) |
| `spawnCount ∈ 0..16`, `mapSize ∈ 0..2048`, `numTeams ∈ 0..16` | 🟡 teilweise |

Die Symmetrie-Regel ist die subtilste: `POINT3` hat 3 Symmetriepunkte, `XZ`/`X`/`Z`/`ZX` je 2,
`QUAD`/`DIAG` je 4. Wir behandeln Symmetrien als undurchsichtige Strings.

**Fix:** siehe § 5.1: `--parse` erledigt das, ohne dass wir eine Regel nachbauen.

### 4.3 🐞 P1: Rohargumente zerbrechen an Leerzeichen

```rust
options.command_line_args.split_whitespace()
```
[protocol/map_generator.rs:466](crates/faf-domain/src/protocol/map_generator.rs:466)

`--folder-path "C:\Users\Max Mustermann\maps"` wird zu vier Argumenten. Der Java-Client hat
denselben Fehler (`split(" ")`), der Python-Client nicht: er nutzt `shlex.split`. Da unser Ziel der
bessere Client ist, ist Python hier die Referenz.

### 4.4 🟡 P1: Versionsliste unvollständig ⚡

Wir rufen `/releases` ohne `per_page` und ohne Paginierung auf. GitHub liefert **30 von 130**
Releases; die Liste endet bei 1.8.4. Python holt alle 130 (`per_page=100` + `Link`-Header) und
cacht sie in `release_tags`.

### 4.5 🟡 P1: Optionslisten nicht gecacht

`load_options` startet sechs JVM-Prozesse bei jedem Dialogöffnen
([services/map_generator.rs:180-189](crates/faf-app/src/services/map_generator.rs:180)). Python
extrahiert einmal pro Generatorversion und legt das Ergebnis in `mapgen_options.json` ab.

Ein Cache ist umso sinnvoller, als die Listen sich innerhalb einer Version definitionsgemäß nie
ändern.

### 4.6 ❌ P1: Nicht erreichbare gültige Werte

| Einstellung | Generator | Python | Java | Rust |
|---|---|---|---|---|
| `numTeams` | 0–16 | 1–1000 | 0, 2–16 | **2–8** |
| `numToGenerate` | beliebig | ≥1 | 1–50 | **1–10** |
| `mapSize` | 0–2048, `%64` | 2,5–80 km | 5–20 km (13 Werte) | **9 Werte** |

`--num-teams 0` ist ausdrücklich dokumentiert als *„0 is no teams asymmetric"* und schaltet
sämtliche Team-Validierung ab. Ein eigener Map-Typ, den wir nicht anbieten.

Bei den Größen fehlen uns 576, 704, 832, 896, 960 gegenüber Javas Raster; dafür haben wir 2048.

### 4.7 ❌ P1: Kein Generator-Log

Python schreibt `map_generator.log`, Java loggt über `faf-map-generator`. Wir loggen bewusst nur,
*dass* eine Zeile kam ([infra/map_generator.rs:354](crates/faf-app/src/infra/map_generator.rs:354)).
Bei einem Fehlschlag sieht der Nutzer nur die erste stderr-Zeile.

### 4.8 ❌ P2: Kein Bestätigungs-Prompt beim Join

Python fragt vor der Generierung einer Lobby-Map (Yes / Yes to all / No), weil der Vorgang
minutenlang eine CPU auslastet. Unser `GenerateNamed` startet sofort. Java fragt ebenfalls nicht.

---

## 5. Was der Generator kann, das **kein** Client liefert

Der zweite Teil der Fragestellung. Alles hier ist am ausgelieferten 1.22.1-JAR verifiziert.

### 5.1 ⚡ `--parse`: Trockenlauf, Validator und Namensauflöser in einem

> „Only parse the options and return the parameters in json"

Der Generator kann Optionen **auflösen, validieren und den resultierenden Map-Namen berechnen,
ohne eine Map zu erzeugen**. Er läuft in unter einer Sekunde statt in Minuten.

**Richtung A: Optionen → Name + Parameter:**

```
$ java -jar NeroxisGen_1.22.1.jar --parse --map-size 10km --spawn-count 6 \
      --num-teams 2 --style MOUNTAIN_RANGE --terrain-symmetry POINT2 --seed 12345
{"parameters":{"seed":12345,"spawnCount":6,"mapSize":512,"numTeams":2,
 "mode":{"terrainSymmetry":"POINT2","mapStyle":"MOUNTAIN_RANGE"}},
 "mapName":"neroxis_map_generator_1.22.1_aaaaaaaaaayds_ayeaeaaj"}
```

**Richtung B: Name → Parameter:**

```
$ java -jar NeroxisGen_1.22.1.jar --map-name neroxis_map_generator_1.22.1_mmyctirfxqlx6_baeaj7yja4aqoxza --parse
{"parameters":{"seed":7147258385031501695,"spawnCount":8,"mapSize":512,"numTeams":4,
 "mode":{"terrainSymmetry":null,"mapStyle":{"terrainStyle":"FLOODED","biomeName":"SYRTIS",
 "propStyle":"ROCK_FIELD","resourceStyle":"LOW_MEX",
 "reclaimDensity":0.7480315,"resourceDensity":0.2519685}}}, "mapName":"…"}
```

Das löst gleich drei Probleme auf einmal:

1. **Validierung ohne Nachbau.** Statt `spawnCount % numTeams`, `mapSize % 64` und die
   Symmetrie-Regel in `faf-domain` zu reimplementieren und bei jedem Generator-Release
   nachzuziehen: `--parse` vorschalten. Exit-Code 0 → generieren. Exit ≠ 0 → die Fehlermeldung des
   Generators anzeigen, die bereits präzise formuliert ist („Spawn Count `5` not a multiple of Num
   Teams `2`"). Der JAR ist im Host-Flow ohnehin schon geladen.
2. **Namensvorschau.** Der Nutzer sieht den Map-Namen, bevor er generiert: teilbar, in die Lobby
   kopierbar.
3. **Metadaten zu fremden Maps.** Beim Lobby-Join lässt sich anzeigen „10 km · 8 Spawns · 4 Teams ·
   FLOODED/SYRTIS", bevor man eine minutenlange Generierung startet.

Einschränkung für Punkt 3: ein JVM-Start pro Name ist für eine Lobby-**Liste** zu langsam. Dafür
eignet sich die lokale Base32-Dekodierung (Byte-Layout siehe § 6) oder ein Cache; `--parse` ist die
richtige Wahl auf Anfrage für eine einzelne Map.

### 5.2 ⚡ `--preview-path`: Vorschaubilder in einen eigenen Ordner

`--preview-path <ordner>` schreibt die Preview-PNGs separat. Wir lesen die Vorschau derzeit aus dem
Map-Ordner und probieren dafür neun Dateinamensvarianten durch
([infra/map_generator.rs:474-531](crates/faf-app/src/infra/map_generator.rs:474)). Mit
`--preview-path` in ein temporäres Verzeichnis entfällt das Raten komplett.

Achtung: greift nur im Casual-Modus (`allowDebug()`), bei Turnier-/Blind-Maps gibt es
definitionsgemäß keine Vorschau.

### 5.3 ⚡ Map-Styles haben Parameter-Constraints

Jedes Preset in `MapStyle.Predefined` trägt einen `ParameterConstraints`-Datensatz:

| Style | Map-Größe | Spawns | Teams |
|---|---|---|---|
| `BIG_ISLANDS`, `SMALL_ISLANDS`, `LAND_BRIDGE` | 768–1024 | – | LAND_BRIDGE: 2–4 |
| `CENTER_LAKE`, `FLOODED`, `ONE_ISLAND`, `VALLEY` | 384–1024 | – | – |
| `MOUNTAIN_RANGE` | 256–640 | – | – |
| `LOW_MEX` | 256–640 | 0–4 | genau 2 |
| `SETONISH` | 512–1024 | – | genau 2 |
| alle übrigen | beliebig | – | – |

Der Generator nutzt diese Constraints **nur bei der Zufallsauswahl** (`RANDOM_MAP_STYLE_OPTIONS`,
gewichtet: `BASIC` und `LAND_BRIDGE` doppelt, `FORREST_SOMETHING` mit 0,01). Wählt der Nutzer
einen Style explizit, wird er ungefiltert übernommen: auch wenn er nicht passt.

**Kein Client zeigt das an.** Wer bei 5 km `BIG_ISLANDS` wählt, bekommt kein sinnvolles Ergebnis
und erfährt nicht, warum. Styles im Dialog auszugrauen oder mit dem gültigen Größenbereich zu
beschriften, wäre eine echte Verbesserung. Die Tabelle ist allerdings versionsabhängig und müsste
gepflegt werden: oder man leitet sie aus einem `--parse`-Vergleich ab.

### 5.4 ⚡ Weitere ungenutzte Fähigkeiten

| Fähigkeit | Detail | Wer nutzt es |
|---|---|---|
| **km-Schreibweise** | `--map-size 10km` wird intern zu 512 (`× 51.2`) | niemand direkt (alle rechnen selbst) |
| **`--num-teams 0`** | asymmetrische Maps ohne Teamstruktur | niemand |
| **Abgekürzte Optionen** | `setAbbreviatedOptionsAllowed(true)` → `--map-si 512` funktioniert | niemand |
| **Unbekannte Argumente tolerant** | `setUnmatchedArgumentsAllowed(true)` → unbekannte Flags brechen den Lauf **nicht** ab | niemand (wichtig für Vorwärtskompatibilität) |
| **`--version`** | `-V` liefert die Generatorversion | niemand (alle leiten sie aus dem Dateinamen ab) |
| **`--debug`** | schreibt `debug/pipelineMaskHashes.txt` und gibt Parameter aus | nur über Rohargumente |
| **Unterbefehl-Aliase** | `styles` = `--styles`, `biomes` = `--texture-styles` = `--biomes` | alle nutzen nur die `--`-Form |

Nicht im JAR enthalten: die **Toolsuite** (MapEvaluator, MapPopulator, MapResizer,
PbrTextureGenerator, Import/Export) wird als eigenes Artefakt `neroxis-toolsuite-*` veröffentlicht.
`NeroxisGen_<version>.jar` enthält nur den Generator. Wer diese Werkzeuge nutzen will, müsste ein
zweites, ~55 MB großes Paket ausliefern: für einen Client vermutlich außerhalb des Sinnvollen.

---

## 6. Anhang: Aufbau des Map-Namens

```
neroxis_map_generator_<version>_<seed-b32>_<options-b32>[_<time-b32>]
```

Base32 (Commons-Codec, lowercase, ohne Padding). Options-Bytes:

| Byte | Bedeutung |
|---|---|
| 0 | spawnCount |
| 1 | mapSize / 64 |
| 2 | numTeams |
| 3 | Symmetrie-Ordinal (−1 = keine) |
| 4 (bei Länge 5) | `MapStyle.Predefined`-Ordinal |
| 4–9 (bei Länge 10) | Biome, Terrain, Resource, Prop, Reclaim-Bin, Resource-Bin |
| 3 + Segment 6 (bei Länge 4) | Visibility-Ordinal + Generierungszeitpunkt (Turniermodus) |

Dichten werden als Bin-Index 0–126 gespeichert; `0.75` kommt als `0.7480315` (= 95/127) zurück.
Die Enum-Ordinale sind **versionsabhängig**: eine lokale Dekodierung muss bei Unbekanntem
schweigen statt zu raten.

---

## 7. Umsetzungsstand

Der Vergleich oben beschreibt den Stand *vor* der Umsetzung. Dieser Abschnitt hält fest, was
inzwischen im Rust-Client steckt. Die Abschnitte 3 bis 6 sind bewusst unverändert geblieben: sie
dokumentieren die Ausgangslage und die Belege dafür.

### Umgesetzt

| # | Punkt | Wo |
|---|---|---|
| 1 | Dichte wird als 0.0-1.0 emittiert (`format_density`), Slider bleiben Bin-Skala | `protocol/map_generator.rs` |
| 2 | `--parse` als Vorabprüfung vor jeder Generierung aus Optionen | `services/map_generator.rs`, `infra/map_generator.rs` |
| 3 | Rohargumente mit Shell-Quoting (`split_command_line`) | `protocol/map_generator.rs` |
| 4 | Release-Paginierung, 130 statt 30 Versionen | `infra/map_generator.rs` |
| 5 | Optionslisten pro Version auf Platte gecacht | `infra/map_generator.rs` |
| 6 | Teams 0-16 inklusive „asymmetrisch", Spawns auf Vielfache gefiltert | `generatorPresentation.ts` |
| 7 | Generator-Logfile mit Rotation | `infra/map_generator.rs` |
| 8 | Alle 13 Größen des 64er-Rasters plus 1280 und 2048 | `generatorPresentation.ts` |
| 9 | Bis zu 50 Karten pro Lauf | `generatorPresentation.ts` |
| 10 | Namensvorschau aus `--parse` im Dialog | `GenerateMapModal.tsx` |
| 11 | `--preview-path` statt neun geratener Dateinamen | `infra/map_generator.rs` |
| 13 | Abbrechen während des Laufs (`CancelSignal`) | `infra/map_generator.rs` |
| 14 | `--out-path` als Feld | `GenerateMapModal.tsx` |
| 15 | Generator-Hilfe im Dialog | `GenerateMapModal.tsx` |
| 16 | Seed wird als `i64` validiert | `protocol/map_generator.rs` |
| 18 | `--debug` und `--visualize` als Schalter | `GenerateMapModal.tsx` |
| 20 | Map-Namen werden lokal dekodiert und angezeigt | `protocol/map_generator_name.rs` |
| 21 | Style-Constraints als Warnung und als Auswahlkriterium | `protocol/map_generator.rs` |

Dazu zwei Dinge, die in der ursprünglichen Liste gar nicht standen, weil sie erst beim
Nachbau auffielen:

- **Symmetrie-Vorfilterung.** Sind mehrere Symmetrien angehakt, wählen Python und Java gleichverteilt
  aus allen. Steht `POINT3` neben `POINT4` und man will zwei Teams, scheitert etwa jeder zweite Lauf
  ohne erkennbaren Grund. Wir filtern vor der Auswahl auf team-kompatible Symmetrien und fallen nur
  auf die Rohauswahl zurück, wenn keine einzige passt.
- **Style-Vorfilterung.** Dieselbe Logik für Map-Styles gegenüber der gewählten Kartengröße.

### Bewusst nicht umgesetzt

**19. Wechsel auf `--visibility`.** Die ursprüngliche Empfehlung war falsch. Am ausgelieferten JAR
verifiziert: picocli läuft mit `setUnmatchedArgumentsAllowed(true)`, unbekannte Flags werden also
**stillschweigend ignoriert** statt einen Fehler auszulösen.

```
$ java -jar NeroxisGen_1.22.1.jar --parse --map-size 512 --spawn-count 6 --num-teams 2 --totally-bogus-flag
{"parameters":{...},"mapName":"neroxis_map_generator_1.22.1_ed577kmcvkh22_ayeae"}
```

Ein `--visibility BLIND` an einen älteren Generator wäre damit wirkungslos, und der Nutzer bekäme
kommentarlos eine Casual-Karte statt einer Blind-Karte. Die Legacy-Flags `--tournament-style`,
`--blind` und `--unexplored` funktionieren dagegen über die gesamte unterstützte Versionsspanne;
in 1.22.1 sind sie nur `hidden`, nicht entfernt. Sie zu behalten ist die sicherere Wahl.

### Offen

| # | Punkt | Warum noch nicht |
|---|---|---|
| 12 | Bestätigungs-Prompt vor der Generierung beim Lobby-Join | Braucht ein neues Feld im Settings-Schema und einen Eingriff in den Join-Pfad, beides außerhalb des Mapgen-Moduls |
| 17 | „Generierte Karten beim Beenden löschen" | Ebenfalls Settings-Schema plus ein Shutdown-Hook; der manuelle `CleanUp`-Befehl mit Favoritenschutz existiert bereits |

### Verifikation

Die Dekodierung der Map-Namen ist gegen die echte Generator-Ausgabe getestet, nicht gegen unsere
Lesart des Quellcodes: die Erwartungswerte in `map_generator_name.rs` stammen aus
`java -jar NeroxisGen_1.22.1.jar --parse ...`-Läufen. Ebenso die Fehlermeldungen, an denen sich die
Validierung orientiert.

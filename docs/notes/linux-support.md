# Linux support: what already works, and what is left

> Audit written on 2026-09-10 against `develop`, for issue #115. A note, not a
> living document: it describes the state of the tree on that day and the shape
> of the remaining work. Check the code before trusting a line of it.

Issue #115 is one word ("yes"), so the first useful thing is a boundary: how
much of "add Linux support" is already done, and what specifically is not. The
answer is that the **client** is close to portable and the **game launch** is
the real work.

## Already there

Nothing in this section needs doing.

| What | Where | State |
|---|---|---|
| CI | `.github/workflows/ci.yml` | Every check already runs on `ubuntu-latest`: tests, clippy, architecture, bindings drift, the frontend gate. Nothing in the checks is Windows-only. |
| Release packaging | `.github/workflows/release.yml` | The matrix builds `ubuntu-22.04` alongside Windows and both macOS architectures, with the webkit2gtk/appindicator/rsvg/patchelf dependencies installed. |
| Self-update | `infra/client_update.rs` | `ASSET_SUFFIXES` picks `.AppImage`, `.deb` and `.rpm` on anything that is not Windows or macOS, so the updater already looks for the right artifacts. |
| Anti-smurf id | `scripts/ensure-faf-uid.mjs` | A Linux `faf-uid` asset is downloaded and hash-checked next to the Windows and macOS ones. |
| Galactic War | `protocol/galactic_war.rs` | `faf_galactic_war_client_linux.zip` and its `.x86_64` executable are already the non-Windows constants. |
| Discord presence | `infra/discord.rs` | The Windows named pipe has a `#[cfg(unix)]` counterpart. |
| Live replays | `infra/replay.rs` | The named-pipe transport is Windows-only, but it is the opt-in workaround; the TCP proxy is the default and is portable. |
| Map generator console | `infra/map_generator.rs` | The debug run-window has a non-Windows branch. |
| WebKitGTK version | `src-tauri/src/lib.rs` | Diagnostics already read the real webkit2gtk version through its C API on Linux. |

That is not an accident: every `#[cfg(windows)]` in the tree has a counterpart.
The layering helps here, because all of it lives in `faf-app/src/infra/`.

## What is actually missing

### 1. Starting the game (the whole problem)

`GameProcess::spawn` runs the configured executable directly:

```rust
let mut command = Command::new(&exe);
```

On Linux the configured executable is still `ForgedAlliance.exe`, a Windows
binary, and FAF has no native Linux build of the engine. So the launch has to go
through Wine or Proton, which is a real design decision rather than a `cfg`:

- **Which runner.** System `wine`, a Lutris/Steam Proton prefix, or a
  user-supplied command. The Java client's approach is a configurable wrapper
  command, which is the smallest thing that can work here too: a
  `wine_command: Vec<String>` in `GamePreferences`, prepended to the
  `Command`, with the executable and its arguments after it.
- **Which prefix.** FA writes to `%LOCALAPPDATA%`, which under Wine is inside
  the prefix. The game's own preferences file (`game.prefs`), which this client
  reads and writes for mods and settings, therefore lives at a path only the
  prefix knows. `PathPreferences` would need a Linux answer for it, and
  `install_path_is_present` would need to resolve inside the prefix.
- **Working directory.** `spawn` uses the executable's parent, which stays
  correct under a wrapper as long as the wrapper does not change it.
- **The ICE adapter and the relay** are a Java process and a local socket. Both
  are portable already; what is not obvious is whether the *game* reaching the
  relay works the same from inside a prefix.

None of that is difficult. All of it needs a Linux machine with FAF installed to
verify, which is why this note stops at describing it.

### 2. Finding an existing install

`discover_reference_install_paths` reads `APPDATA` and `PROGRAMDATA` to import
the Java and Python clients' configured paths. Both are unset on Linux, so
discovery silently finds nothing and the user configures the paths by hand in
Settings. That degrades gracefully, which is why it is second on this list and
not first, but the Linux equivalents are known:

- the Java client's `client.prefs` under `$XDG_DATA_HOME/Forged Alliance Forever`
  (in practice `~/.faforever`),
- the Python client's `FA Lobby.ini` under `~/.config/ForgedAllianceForever`.

`discover_from_reference_configs` already takes the three paths as arguments and
is unit tested that way, so this is a change to one function that builds them.

### 3. The executable name

`MANAGED_EXE` is `"ForgedAlliance.exe"` and `is_original_game_executable`
recognises the Steam/retail install by its Windows layout. Under a prefix the
name is unchanged, so this is likely fine as it stands, but it is worth checking
rather than assuming.

## Suggested order

1. Add the wrapper command to `GamePreferences` and prepend it in
   `GameProcess::spawn`. That alone makes the client usable on Linux for anybody
   who already has a working prefix.
2. Teach `game.prefs` resolution about the prefix, so mods and game settings
   work rather than silently doing nothing.
3. Add the two Linux reference-config paths to install discovery.
4. Only then worry about packaging polish: a desktop entry, the icon, and
   whether the AppImage or the `.deb` is the recommended artifact.

Steps 1 to 3 are each small. What none of them can be done without is somebody
running FAF on Linux to check the result, because every one of them is a claim
about a filesystem this repository cannot see.

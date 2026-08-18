//! Launcher orchestration: turns a `game_launch` order into a running game.
//!
//! Backend-neutral: it asks the [`IcePort`](crate::ports::IcePort) for a
//! [`ConnectivitySession`](crate::ports::ConnectivitySession) (Go or Java decide
//! their own internals), launches the game on the session's GPGNet port, and
//! bridges the session's relay channels to the lobby:
//!
//! - `session.to_lobby` → `lobby.send_game_relay` (adapter → lobby)
//! - lobby `target: "game"` messages → [`LaunchSession::forward_to_adapter`] →
//!   `session.from_lobby` (lobby → adapter)
//!
//! The lobby connect loop owns the returned [`LaunchSession`] and feeds it the
//! relay messages arriving on the same socket. On any setup failure we stop the
//! adapter and emit `LaunchFailed`.

use faf_domain::state::{
    Game, GameLaunch, LobbyEvent, NotificationKind, PlayerProfile, ReplayEvent,
};
use serde_json::Value;
use tokio::sync::mpsc;

use crate::ports::{
    GameLaunchParams, GamePreparation, IceParams, RelayMsg, ReplayMetadata, UpdateProgress,
    DEFAULT_LOCAL_REPLAY_LIMIT,
};
use crate::runtime::{EventSink, ServiceCtx};
use crate::services::notifications;

/// A live launch: the channel into the adapter, used to forward lobby
/// game-relay messages. Dropping it does not stop the game.
pub struct LaunchSession {
    from_lobby: mpsc::Sender<RelayMsg>,
}

impl LaunchSession {
    /// Forward a lobby `target: "game"` message to the connectivity backend.
    pub async fn forward_to_adapter(&self, command: String, args: Vec<Value>) {
        // ICE candidates are correctness-critical. A full bounded queue must
        // apply backpressure instead of silently dropping the one candidate a
        // peer needs to connect.
        tracing::trace!(%command, "launcher: forwarding lobby relay message to adapter");
        if self
            .from_lobby
            .send(RelayMsg { command, args })
            .await
            .is_err()
        {
            tracing::warn!("launcher: connectivity adapter stopped accepting lobby messages");
        }
    }
}

/// Run the launch chain. Emits `InGame` on success (returning the session) or
/// `LaunchFailed` on any failure (returning `None`, after stopping the adapter).
pub async fn start(
    launch: &GameLaunch,
    ctx: &ServiceCtx,
    out: &EventSink,
    already_prepared: bool,
) -> Option<LaunchSession> {
    let Some(player) = out.with_state(|state| state.auth.player.clone()) else {
        return fail(ctx, out, "not logged in".into());
    };
    let player_profile = out.with_state(|state| {
        state
            .social
            .players
            .iter()
            .find(|profile| profile.id == player.id)
            .cloned()
    });
    let init_mode = init_mode_for(&launch.game_type);

    // 0. Reproduce a generated map before anything else.
    //
    // Matchmaker pools contain maps that are never distributed as files: the
    // server names them and every client rebuilds identical terrain from the
    // name (see `infra::map_generator`). Launching without the folder present
    // drops the player into a game they cannot load, so this is a hard gate on
    // the launch rather than a warning. Both reference clients do the same
    // check at the same point (Java's `MapService.generateIfNotInstalled`).
    if !already_prepared {
        if let Err(reason) = ensure_generated_map(&launch.mapname, ctx, out).await {
            return fail(ctx, out, reason);
        }

        // 1. Patch the featured mod and download the map.
        //
        // The server does not care whether this client is current: it will happily
        // seat a player on an old build or a map they have never seen, and the game
        // then fails to load or desyncs. Both reference clients update before every
        // game rather than tracking whether an update is due (Java's
        // `prepareAndLaunchGameWhenReady`, the Python client's `fa.check.check`);
        // it is cheap when nothing changed, because files matching by MD5 are
        // skipped and a present map is not re-fetched.
        if let Err(reason) = prepare_install(launch, ctx, out).await {
            return fail(ctx, out, reason);
        }
    }

    // 2. Bring up the connectivity backend (it picks its own ports / control plane).
    let session = match ctx
        .ports
        .ice
        .start(IceParams {
            player_id: player.id,
            player_login: player.name.clone(),
            game_id: launch.uid,
            init_mode,
        })
        .await
    {
        Ok(session) => session,
        Err(e) => return fail(ctx, out, format!("ice adapter: {e}")),
    };

    // 3. Launch the game pointed at the adapter's GPGNet port.
    let game_params = GameLaunchParams {
        game_id: launch.uid,
        game_port: session.game_port,
        init_mode,
        featured_mod: launch.mod_name.clone(),
        player_id: player.id,
        player_login: player.name.clone(),
        args: launch_arguments(launch, player_profile.as_ref()),
        replay: replay_metadata(launch, &player.name, out),
    };
    if let Err(e) = ctx.ports.process.launch_game(game_params).await {
        ctx.ports.ice.stop();
        return fail(ctx, out, format!("game launch: {e}"));
    }
    // Java cancels delayed replay actions as soon as GameRunner becomes active.
    // Do the same so auto-watch can never replace a game the user just launched.
    super::replays::cancel_live_tracking(out);

    // 4. Pump adapter → lobby. The reverse direction is driven by the lobby loop
    //    via `forward_to_adapter`.
    let lobby = ctx.ports.lobby.clone();
    let mut to_lobby = session.to_lobby;
    tokio::spawn(async move {
        tracing::debug!("launcher: adapter->lobby pump started");
        while let Some(msg) = to_lobby.recv().await {
            tracing::trace!(command = %msg.command, "launcher: adapter -> server lobby");
            lobby.send_game_relay(msg.command, msg.args);
        }
        tracing::debug!("launcher: adapter->lobby pump ended (adapter session channel closed)");
    });

    // 5. Notice when the game exits.
    //
    // Nothing used to. The client stayed `InGame` until the user explicitly
    // terminated, so after a failed join the Play tab kept reporting a game in
    // progress and refused another attempt: the reported "stuck joining
    // forever, cannot try again".
    //
    // `GameState Ended` goes to the server first, as the Python client does in
    // `GameSession._exited`. Without it the server still believes this player
    // is in the game, which is its own reason a rejoin can be refused.
    let exit_ports = ctx.ports.clone();
    let exit_sink = out.clone();
    tokio::spawn(async move {
        tracing::debug!("launcher: game exit watcher started");
        exit_ports.process.wait_for_exit().await;
        tracing::info!("the game process exited; releasing the launch");
        tracing::debug!("sending GameState Ended to the server");
        exit_ports
            .lobby
            .send_game_relay("GameState".into(), vec![Value::String("Ended".into())]);
        tracing::debug!("stopping ICE adapter");
        exit_ports.ice.stop();
        exit_sink.emit(LobbyEvent::GameTerminated);

        // The replay the game just streamed to the local recorder is on disk
        // now. Re-listing here is what makes it appear in the Local tab without
        // the user knowing to press refresh: the scan is a directory read, and
        // it only happens once per game.
        match exit_ports
            .replay
            .list_local(DEFAULT_LOCAL_REPLAY_LIMIT)
            .await
        {
            Ok(replays) => exit_sink.emit(ReplayEvent::LocalLoaded { replays }),
            Err(reason) => {
                tracing::warn!(%reason, "could not refresh the local replay list after the game")
            }
        }
        tracing::info!("launcher: game exit cleanup complete");
    });

    out.emit(LobbyEvent::InGame);
    Some(LaunchSession {
        from_lobby: session.from_lobby,
    })
}

/// Prepare a selected custom game before asking the server for a seat. Java's
/// `prepareAndLaunchGameWhenReady` does this in the same order so a large patch,
/// map, or simulation-mod download cannot consume the server's launch window.
pub(crate) async fn prepare_custom_join(
    game: &Game,
    ctx: &ServiceCtx,
    out: &EventSink,
) -> Result<(), String> {
    use faf_domain::protocol::map_generator::is_generated_map;

    // Validate this before generating or downloading anything. Apart from
    // producing a much more useful error, this prevents spending minutes on
    // preparation for a game that cannot possibly be launched.
    if ctx.ports.process.game_install_dir().is_none() {
        return Err(
            "no game install configured: locate ForgedAlliance.exe in Settings → Paths".to_string(),
        );
    }

    ensure_generated_map(&game.map, ctx, out).await?;
    prepare_request(
        GamePreparation {
            featured_mod: game.mod_name.clone(),
            map_folder: (!game.map.is_empty() && !is_generated_map(&game.map))
                .then(|| game.map.clone()),
        },
        ctx,
        out,
    )
    .await?;

    let mod_uids: Vec<String> = game.sim_mods.keys().cloned().collect();
    if !mod_uids.is_empty() {
        out.emit(LobbyEvent::Preparing {
            detail: format!(
                "Installing {} required simulation mod{}…",
                mod_uids.len(),
                if mod_uids.len() == 1 { "" } else { "s" }
            ),
            progress: None,
        });
        ctx.ports
            .mods
            .ensure_game_mods(&mod_uids)
            .await
            .map_err(|error| format!("could not prepare simulation mods: {error}"))?;
    }
    Ok(())
}

/// Make sure a generated map exists locally, generating it if not.
///
/// A no-op for ordinary maps: those ship with the game or come from the vault,
/// and are handled elsewhere. Returns `Err` only when the map *is* generated and
/// could not be produced, since that is the one case where continuing would
/// strand the player in an unloadable game.
async fn ensure_generated_map(
    map_name: &str,
    ctx: &ServiceCtx,
    out: &EventSink,
) -> Result<(), String> {
    use faf_domain::protocol::map_generator::is_generated_map;
    use faf_domain::state::{GeneratorStatus, MapGeneratorEvent};

    if !is_generated_map(map_name) {
        return Ok(());
    }
    if ctx.ports.map_generator.is_installed(map_name) {
        return Ok(());
    }

    let settings = ctx.ports.settings.load().await;
    if !settings.game.auto_generate_maps {
        return Err(format!(
            "map {map_name} is not installed and automatic map generation is disabled in settings"
        ));
    }

    tracing::info!(map_name, "generating map required by launch");
    let mut updates = ctx
        .ports
        .map_generator
        .generate_named(map_name.to_string())
        .await;

    // Forward progress so the UI can show what the wait is for: generation
    // routinely takes tens of seconds.
    let mut outcome = Err("the map generator produced no result".to_string());
    while let Some(crate::ports::GeneratorUpdate::Status(status)) = updates.recv().await {
        match &status {
            GeneratorStatus::Generated { .. } => outcome = Ok(()),
            GeneratorStatus::Failed { reason } => {
                outcome = Err(format!("could not generate {map_name}: {reason}"))
            }
            _ => {}
        }
        out.emit(MapGeneratorEvent::StatusChanged { status });
    }
    outcome
}

/// Patch the featured mod to the current build and download the map, narrating
/// progress as [`LobbyEvent::Preparing`].
///
/// Fatal on failure, unlike the same work on the replay path. A replay is a
/// recording the user chose to watch; here the server has already seated them
/// in a game, and starting an out-of-date client means a failed load, a desync,
/// or a leave the other players see as a drop. Reporting why beats all three.
async fn prepare_install(
    launch: &GameLaunch,
    ctx: &ServiceCtx,
    out: &EventSink,
) -> Result<(), String> {
    use faf_domain::protocol::map_generator::is_generated_map;

    // A generated map was already rebuilt above and is never in the vault, so
    // asking the CDN for it would be a guaranteed 404.
    let map_folder = (!launch.mapname.is_empty() && !is_generated_map(&launch.mapname))
        .then(|| launch.mapname.clone());

    prepare_request(
        GamePreparation {
            featured_mod: launch.mod_name.clone(),
            map_folder,
        },
        ctx,
        out,
    )
    .await
}

async fn prepare_request(
    request: GamePreparation,
    ctx: &ServiceCtx,
    out: &EventSink,
) -> Result<(), String> {
    let mut updates = ctx.ports.updater.prepare(request).await;

    // The port always ends with `Finished`; treating a stream that closes
    // without one as a failure keeps a panicked adapter task from looking like
    // a successful update.
    let mut outcome = Err("the game updater stopped without finishing".to_string());
    while let Some(update) = updates.recv().await {
        match update {
            UpdateProgress::Step(step) => out.emit(LobbyEvent::Preparing {
                detail: step.detail,
                progress: step.progress,
            }),
            UpdateProgress::Finished(result) => outcome = result,
        }
    }
    outcome
}

/// Stop the adapter and emit `LaunchFailed`. Always returns `None` so call sites
/// can `return fail(..)`.
pub(crate) fn report_failure(ctx: &ServiceCtx, out: &EventSink, reason: String) {
    tracing::warn!("game launch failed; details were sent to the client");
    ctx.ports.ice.stop();
    notifications::add_required(
        out,
        NotificationKind::Error,
        "Game launch failed",
        reason.clone(),
        None,
    );
    out.emit(LobbyEvent::LaunchFailed { reason });
}

fn fail(ctx: &ServiceCtx, out: &EventSink, reason: String) -> Option<LaunchSession> {
    report_failure(ctx, out, reason);
    None
}

/// Custom games init in NORMAL mode (0); matchmaker games in AUTO (1).
fn init_mode_for(game_type: &str) -> i32 {
    if game_type == "matchmaker" {
        1
    } else {
        0
    }
}

/// Describe the game for the header of the replay this launch will record.
///
/// `game_launch` carries the identity of the game (uid, title, map, mod) but not
/// who is in it, so the lobby's own listing is consulted for the teams, the host
/// and the launch time. It is legitimately absent on the matchmaker path, where
/// the game exists before it is ever listed publicly; the recording still gets a
/// correct map, title and mod, and falls back to its own start time for the
/// date. Nothing here is worth failing a launch over.
fn replay_metadata(launch: &GameLaunch, player: &str, out: &EventSink) -> ReplayMetadata {
    let game = out.with_state(|state| {
        state
            .lobby
            .games
            .iter()
            .find(|game| game.id == launch.uid)
            .cloned()
    });
    ReplayMetadata {
        uid: launch.uid,
        recorder: player.to_string(),
        featured_mod: launch.mod_name.clone(),
        title: if launch.name.is_empty() {
            game.as_ref()
                .map(|game| game.title.clone())
                .unwrap_or_default()
        } else {
            launch.name.clone()
        },
        map_name: launch.mapname.clone(),
        game_type: launch.game_type.clone(),
        host: game
            .as_ref()
            .map(|game| game.host.clone())
            .unwrap_or_default(),
        launched_at: game.as_ref().and_then(|game| game.launched_at),
        num_players: game.as_ref().map(|game| game.players).unwrap_or_default(),
        teams: game
            .as_ref()
            .map(|game| game.teams.clone())
            .unwrap_or_default(),
        sim_mods: game.map(|game| game.sim_mods).unwrap_or_default(),
    }
}

/// Add the player and automatic-lobby arguments that the server deliberately
/// does not own. This mirrors Java's `LaunchCommandBuilder` and Python's
/// `handle_game_launch` rather than deriving a displayed rating from the game
/// list, which has already discarded the TrueSkill deviation.
fn launch_arguments(launch: &GameLaunch, profile: Option<&PlayerProfile>) -> Vec<String> {
    let mut args = launch.args.clone();
    let has = |args: &[String], flag: &str| {
        args.iter()
            .any(|argument| argument.eq_ignore_ascii_case(flag))
    };
    let push_pair = |args: &mut Vec<String>, flag: &str, value: String| {
        if !has(args, flag) {
            args.push(flag.to_string());
            args.push(value);
        }
    };

    if let Some(profile) = profile {
        let rating_type = if launch.rating_type.is_empty() {
            "global"
        } else {
            &launch.rating_type
        };
        if let Some(rating) = profile
            .ratings
            .iter()
            .find(|rating| rating.leaderboard.eq_ignore_ascii_case(rating_type))
        {
            push_pair(&mut args, "/mean", rating.mean.to_string());
            push_pair(&mut args, "/deviation", rating.deviation.to_string());
        }
        if !profile.country.is_empty() {
            push_pair(&mut args, "/country", profile.country.clone());
        }
        if !profile.clan.is_empty() {
            push_pair(&mut args, "/clan", profile.clan.clone());
        }
        let games = profile
            .ratings
            .iter()
            .map(|rating| rating.games_played)
            .sum::<i32>();
        push_pair(&mut args, "/numgames", games.max(0).to_string());
    }

    if launch.game_type.eq_ignore_ascii_case("matchmaker") {
        if let Some(faction) = launch.faction.and_then(faction_argument) {
            if !has(&args, faction) {
                args.push(faction.to_string());
            }
        }
        if let Some(team) = launch.team {
            push_pair(&mut args, "/team", team.to_string());
        }
        if let Some(players) = launch.expected_players {
            push_pair(&mut args, "/players", players.to_string());
        }
        if let Some(position) = launch.map_position {
            push_pair(&mut args, "/startspot", position.to_string());
        }
        if !launch.game_options.is_empty() && !has(&args, "/gameoptions") {
            args.push("/gameoptions".into());
            args.extend(
                launch
                    .game_options
                    .iter()
                    .map(|(name, value)| format!("{name}:{value}")),
            );
        }
    }

    args
}

fn faction_argument(faction: i32) -> Option<&'static str> {
    match faction {
        1 => Some("/uef"),
        2 => Some("/aeon"),
        3 => Some("/cybran"),
        4 => Some("/seraphim"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use faf_domain::state::PlayerLobbyRating;
    use std::collections::BTreeMap;

    #[test]
    fn init_mode_normal_for_custom_auto_for_matchmaker() {
        assert_eq!(init_mode_for("custom"), 0);
        assert_eq!(init_mode_for(""), 0);
        assert_eq!(init_mode_for("matchmaker"), 1);
    }

    fn profile() -> PlayerProfile {
        PlayerProfile {
            id: 7,
            login: "Commander".into(),
            global_rating: 1_200,
            ratings: vec![PlayerLobbyRating {
                leaderboard: "global".into(),
                rating: 1_200,
                mean: 1_800,
                deviation: 200,
                games_played: 374,
            }],
            country: "de".into(),
            clan: "BC".into(),
            ..PlayerProfile::default()
        }
    }

    fn launch() -> GameLaunch {
        GameLaunch {
            uid: 1,
            mod_name: "faf".into(),
            name: "Game".into(),
            mapname: "scmp_007".into(),
            game_type: "custom".into(),
            rating_type: "global".into(),
            expected_players: None,
            team: None,
            faction: None,
            map_position: None,
            game_options: BTreeMap::new(),
            args: Vec::new(),
        }
    }

    #[test]
    fn custom_launch_includes_the_players_true_skill_identity() {
        let args = launch_arguments(&launch(), Some(&profile()));
        assert_eq!(
            args,
            [
                "/mean",
                "1800",
                "/deviation",
                "200",
                "/country",
                "de",
                "/clan",
                "BC",
                "/numgames",
                "374",
            ]
        );
    }

    #[test]
    fn matchmaker_launch_includes_automatic_lobby_seating() {
        let mut launch = launch();
        launch.game_type = "matchmaker".into();
        launch.faction = Some(3);
        launch.team = Some(2);
        launch.expected_players = Some(4);
        launch.map_position = Some(3);
        launch.game_options.insert("Timeouts".into(), "3".into());

        let args = launch_arguments(&launch, Some(&profile()));
        assert!(args.windows(2).any(|pair| pair == ["/team", "2"]));
        assert!(args.windows(2).any(|pair| pair == ["/players", "4"]));
        assert!(args.windows(2).any(|pair| pair == ["/startspot", "3"]));
        assert!(args.iter().any(|argument| argument == "/cybran"));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["/gameoptions", "Timeouts:3"]));
    }

    #[test]
    fn server_supplied_values_are_not_duplicated() {
        let mut launch = launch();
        launch.args = vec![
            "/mean".into(),
            "1900".into(),
            "/numgames".into(),
            "8".into(),
        ];
        let args = launch_arguments(&launch, Some(&profile()));
        assert_eq!(args.iter().filter(|arg| *arg == "/mean").count(), 1);
        assert_eq!(args.iter().filter(|arg| *arg == "/numgames").count(), 1);
    }
}

//! The integration tests of `faf-app`, as one test binary.
//!
//! Each file in this folder is a module of it and covers one feature area,
//! driving the real runtime on fake ports. They used to be sixty binaries of
//! their own, which is sixty times the whole crate and its dependencies went
//! through the linker for a `cargo test`, and sixty executables in the target
//! folder. One binary links once.
//!
//! To run one area, name its module:
//!
//! ```text
//! cargo test -p faf-app --test it -j 1 -- tourney::
//! cargo test -p faf-app --test it -j 1 -- lobby::invalid_host_requests_never_reach_the_lobby_port
//! ```
//!
//! [`support`] starts the app and waits for it; a new file takes those from
//! there instead of writing its own.
//!
//! Two files stay beside this folder as binaries of their own, because the
//! tests in a binary share one process and theirs lean on something the
//! process has only one of:
//!
//! - `replay_install.rs` names its stand-in for the retail game through the
//!   `FAF_GAME_INSTALL_DIR` environment variable, which every other test in
//!   the process would read as well;
//! - `updater_cancellation.rs` holds the launcher's preparation lock, one for
//!   the whole process, across whole tests, and every test here that prepares
//!   a launch would wait behind it.
//!
//! A new test that sets an environment variable, changes the working
//! directory or otherwise writes process-wide state belongs with those two.

mod support;

mod auth;
mod auth_session;
mod background_cancellation;
mod browsing_settings;
mod changelog;
mod chat;
mod client_update;
mod command_contracts;
mod companion_programs;
mod connectivity_check;
mod connectivity_settings;
mod coop;
mod discord_presence;
mod failure_paths;
mod galactic_war_cancellation;
mod game_cache_port;
mod generated_map_on_launch;
mod guides;
mod host_content_updates;
mod keep_generated_maps;
mod late_ice_session;
mod launch_preparation;
mod leaderboard_catalog;
mod live_lookups;
mod live_replay_delay;
mod lobby;
mod lobby_operations;
mod r#loop;
mod map_generator_presets;
mod map_vault_load;
mod map_visibility;
mod mod_update;
mod mods_reload;
mod offline_game;
mod player_notes;
mod reconnects_and_retries;
mod relay_across_reconnects;
mod repeated_installs;
mod replay_analysis_cancellation;
mod replay_download;
mod reporting;
mod reviews;
mod runtime_settings;
mod settings_patches;
mod settings_startup;
mod shared_games_search;
mod social_lookup;
mod stale_reads;
mod stale_replay_and_tourney_reads;
mod stale_responses;
mod sweep_generated_maps_on_exit;
mod tourney;
mod tourney_eligibility;
mod tourney_write_order;
mod training;
mod training_lessons;
mod tutorials;
mod unit_history_budget;
mod uploads;

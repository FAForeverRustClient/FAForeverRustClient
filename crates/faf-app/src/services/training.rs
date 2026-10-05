//! Training hub orchestration.
//!
//! Three jobs, and the middle one is the interesting one:
//!
//! 1. **Load the library.** The catalogue comes from a port; FAF's own guided
//!    lessons come from the tutorials slice, which another service already
//!    owns. This service asks for them rather than fetching them again, which
//!    is why the tab shows lessons the moment the tutorials tab has ever been
//!    opened, and loads them itself when it has not.
//!
//! 2. **Recommend.** Computed here, from the post-reduce state, and emitted as
//!    an event. Not computed in the view: a recommendation is a rule, and this
//!    codebase has already paid for a rule written once in Rust and again in
//!    TypeScript. The view renders an ordered list of ids and nothing else.
//!    Kept current by [`spawn`], which watches what the profile is read from.
//!
//! 3. **Compose a way out.** A replay review request and a content submission
//!    both end as a forum post the *player* sends. The client's contribution is
//!    knowing which replay, which map, which rating and which category, so that
//!    the player is not asked for any of it.

use std::sync::Arc;
use std::time::Duration;

use faf_domain::state::{
    compose_contribution, compose_review_request, compose_submission, contribution_problem,
    official_map_name, own_row, profile_from, recommend, AppState, AuthEvent, ContributionDraft,
    GuidesEvent, JoinState, LocalReplay, MatchmakerPlayerProfile, PlayerCardEvent, ReplayCommand,
    ReplayEvent, ReviewRequestDraft, Trainer, TrainingCommand, TrainingEvent, TrainingProfile,
    TrainingStatus, VaultReplay, VaultStatus, RECOMMENDED_LIMIT,
};
use faf_domain::AppEvent;

use crate::runtime::{EventSink, ServiceCtx};

/// How many local replays the profile is read from, and therefore how many the
/// scan is asked for when nobody has asked yet.
///
/// Matches [`faf_domain::state::PROFILE_REPLAY_WINDOW`]: reading headers is the
/// expensive part of that scan, and there is no reason to pay for more of them
/// than the recommendation looks at.
const PROFILE_REPLAY_REQUEST: u32 = faf_domain::state::PROFILE_REPLAY_WINDOW as u32;

/// How long after a game ends the replay folder is read again.
///
/// The recorder writes the file once the game has closed its stream, a moment
/// after the game itself ends. The replays tab waits the same moment for the
/// same reason (`GAME_END_RESCAN_DELAY_MS`).
const GAME_END_RESCAN_DELAY: Duration = Duration::from_secs(2);

pub async fn handle(cmd: TrainingCommand, ctx: &ServiceCtx, out: &EventSink) {
    match cmd {
        TrainingCommand::Load => load(ctx, out).await,
        TrainingCommand::SetQuery { query } => {
            out.emit(TrainingEvent::QueryChanged { query });
        }
        TrainingCommand::Select { resource_id } => {
            out.emit(TrainingEvent::Selected { resource_id });
        }
        TrainingCommand::ReadGuide { resource_id } => read_guide(resource_id, ctx, out).await,
        TrainingCommand::OpenReview {
            replay_uid,
            local_path,
        } => {
            let own = own_profile(ctx);
            let draft = out.with_state(|state| {
                draft_for(state, own.as_ref(), replay_uid, local_path.as_deref())
            });
            out.emit(TrainingEvent::ReviewOpened {
                draft: Box::new(draft),
            });
        }
        TrainingCommand::ComposeReview { draft } => {
            // Recorded first, then composed from the post-reduce state. Going
            // through the reducer rather than composing the command's value
            // directly is what stops the preview and the state describing two
            // different requests.
            out.emit(TrainingEvent::ReviewChanged { draft });
            let composed = out.with_state(|state| {
                state
                    .training
                    .review
                    .as_ref()
                    .map(|draft| compose_review_request(draft, &state.training.links))
            });
            if let Some(post) = composed {
                out.emit(TrainingEvent::ReviewComposed {
                    post: Box::new(post),
                });
            }
        }
        TrainingCommand::CloseReview => out.emit(TrainingEvent::ReviewClosed),
        TrainingCommand::OpenContribution => {
            out.emit(GuidesEvent::SubmitReset);
            out.emit(TrainingEvent::ContributionOpened {
                draft: Box::new(ContributionDraft::default()),
            });
        }
        // Only the draft: the last submission's result is left alone, because
        // nothing was composed. The reducer drops a composed post on any
        // change, so a post for an older text cannot outlive the edit.
        TrainingCommand::ChangeContribution { draft } => {
            out.emit(TrainingEvent::ContributionChanged { draft });
        }
        TrainingCommand::ComposeContribution { draft } => {
            // A post that has just been composed has not been submitted, and
            // the last submission's result is about a different guide. Said
            // here rather than remembered in the component, because the stale
            // value lives in the backend's state.
            out.emit(GuidesEvent::SubmitReset);
            out.emit(TrainingEvent::ContributionChanged { draft });
            let composed = out.with_state(|state| {
                let draft = state.training.contribution.as_ref()?;
                // A draft the form would refuse is recorded but not composed.
                // The form disables its button on the same rule, so this only
                // stops another caller from producing a post (and a browser
                // link) for an issue titled "Training submission: " alone.
                if contribution_problem(draft).is_some() {
                    return None;
                }
                // Where the catalogue lives decides what a submission *is*. With
                // a repository it is an issue the queue can accept in one step;
                // without one it falls back to the forum, which is where FAF's
                // training material was discussed before there was a catalogue.
                Some(if state.guides.repo.is_empty() {
                    compose_contribution(draft, &state.training.links)
                } else {
                    compose_submission(
                        draft,
                        state
                            .auth
                            .player
                            .as_ref()
                            .map(|player| player.name.as_str())
                            .unwrap_or_default(),
                        &state.guides.repo,
                    )
                })
            });
            if let Some(post) = composed {
                out.emit(TrainingEvent::ContributionComposed {
                    post: Box::new(post),
                });
            }
        }
        TrainingCommand::CloseContribution => out.emit(TrainingEvent::ContributionClosed),
    }
}

/// Make sure the vault index is loaded, so a build order can show its map.
///
/// A card for a build order is a picture of the map, which is what a player
/// recognises before they read a word of the title. The picture comes out of
/// the same vault index nine other features resolve a map through, and that
/// index is loaded by whoever needs it first. Until now nobody in this tab did,
/// so a player who opened training before ever opening the maps tab got a grid
/// of marks. Same shape as [`ask_for_ratings`], and the same reason.
async fn ask_for_map_previews(ctx: &ServiceCtx, out: &EventSink) {
    let needed = out.with_state(|state| state.maps.vault.is_empty());
    if !needed {
        return;
    }
    super::maps::handle(faf_domain::state::MapsCommand::LoadVault, ctx, out).await;
}

/// Load this account's ratings into the hub's own slot.
///
/// Not through the player card. That is one shared slot, and loading this
/// account into it replaced whatever card the player had open from chat, so
/// the hub asks the port itself and keeps the answer in
/// [`ServiceCtx::training_own_profile`]. Skipped when that already holds this
/// account, unless the player pressed refresh. A failure is silent:
/// recommendations without a rating are still recommendations, and a rating
/// is not worth an error banner on a tab that works without one.
async fn ask_for_own_ratings(refresh: bool, ctx: &ServiceCtx, out: &EventSink) {
    let Some((player_id, login)) = out.with_state(|state| {
        state
            .auth
            .player
            .as_ref()
            .map(|me| (me.id, me.name.clone()))
    }) else {
        return;
    };
    let held = own_profile(ctx).is_some_and(|profile| profile.player_id == player_id);
    if held && !refresh {
        return;
    }

    match ctx
        .ports
        .player_card
        .load_matchmaker_profile(player_id, &login)
        .await
    {
        Ok(profile) => {
            // Signed out, or into another account, while the request ran: the
            // answer describes somebody who is no longer here.
            let still_me = out.with_state(|state| {
                state.auth.player.as_ref().map(|me| me.id) == Some(profile.player_id)
            });
            if still_me {
                set_own_profile(ctx, Some(profile));
            }
        }
        Err(error) => tracing::info!(%error, "could not read this account's ratings"),
    }
}

fn own_profile(ctx: &ServiceCtx) -> Option<MatchmakerPlayerProfile> {
    ctx.training_own_profile
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
}

fn set_own_profile(ctx: &ServiceCtx, profile: Option<MatchmakerPlayerProfile>) {
    *ctx.training_own_profile
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = profile;
}

/// Fill in each trainer's avatar from their FAF account.
///
/// The catalogue could carry an image URL per trainer, and it can, but nobody
/// should have to maintain one: the account already has an avatar, it changes
/// when they change it, and a copy in a JSON file would be stale the day after
/// it was written. One batched lookup for the whole team.
///
/// Best effort throughout. The lookup needs a session, so an offline or
/// signed-out client simply keeps whatever the manifest stated (usually
/// nothing) and the tiles draw their empty mark. A trainer list is worth
/// showing without pictures; it is not worth failing the whole catalogue load
/// over.
async fn with_avatars(mut trainers: Vec<Trainer>, ctx: &ServiceCtx) -> Vec<Trainer> {
    let ids: Vec<i32> = trainers
        .iter()
        .filter_map(|trainer| trainer.faf_id)
        .collect();
    if ids.is_empty() {
        return trainers;
    }

    let found = match ctx.ports.player_card.players_by_id(&ids).await {
        Ok(found) => found,
        Err(error) => {
            tracing::info!(%error, "could not read the trainers' avatars");
            return trainers;
        }
    };

    for trainer in &mut trainers {
        let Some(id) = trainer.faf_id else { continue };
        // A stated avatar still wins: a manifest that names one is making a
        // deliberate choice, and the account is the fallback rather than the
        // override.
        if !trainer.avatar_url.is_empty() {
            continue;
        }
        if let Some(player) = found.iter().find(|player| player.id == id) {
            trainer.avatar_url = player.avatar_url.clone();
        }
    }
    trainers
}

/// Read one guide's text, so the tab can render it instead of opening a browser.
///
/// The command names an entry and the url is read out of the state here, which
/// is the same rule the review form follows: a command carrying a url would let
/// a catalogue entry choose where this client sends a request, and a catalogue
/// is remote content. An entry the parser did not mark readable never reaches
/// the port at all.
async fn read_guide(resource_id: String, ctx: &ServiceCtx, out: &EventSink) {
    let attachments = out.with_state(|state| {
        state.training.resource(&resource_id).map(|resource| {
            (
                resource.readable.then(|| resource.url.clone()),
                (!resource.recording_url.is_empty()).then(|| resource.recording_url.clone()),
            )
        })
    });
    let Some((prose, recording)) = attachments else {
        out.emit(TrainingEvent::GuideFailed {
            resource_id,
            reason: "that entry is no longer in the catalogue".into(),
        });
        return;
    };
    if prose.is_none() && recording.is_none() {
        out.emit(TrainingEvent::GuideFailed {
            resource_id,
            reason: "that entry is a link rather than a guide this client holds".into(),
        });
        return;
    }

    // The prose first, because it is the entry and the run is the bonus. Both
    // are announced before either is fetched, so the pane can lay out its panes
    // rather than growing one at a time as replies land.
    if let Some(url) = prose {
        out.emit(TrainingEvent::GuideReading {
            resource_id: resource_id.clone(),
        });
        match ctx.ports.training.read_guide(url).await {
            Ok(markdown) => out.emit(TrainingEvent::GuideRead {
                resource_id: resource_id.clone(),
                markdown,
            }),
            Err(reason) => out.emit(TrainingEvent::GuideFailed {
                resource_id: resource_id.clone(),
                reason,
            }),
        }
    }

    let Some(url) = recording else {
        return;
    };
    out.emit(TrainingEvent::RecordingReading {
        resource_id: resource_id.clone(),
    });
    match ctx.ports.training.read_recording(url).await {
        Ok(envelope) => out.emit(TrainingEvent::RecordingRead {
            resource_id,
            envelope,
        }),
        Err(reason) => out.emit(TrainingEvent::RecordingFailed {
            resource_id,
            reason,
        }),
    }
}

async fn load(ctx: &ServiceCtx, out: &EventSink) {
    // One load at a time. The refresh button stays live while a load runs,
    // and a second one used to repeat every request and the replay scan; the
    // load in flight already ends with the state the second would produce.
    let Some(_flight) = ctx.training_load_active.try_acquire() else {
        return;
    };
    // A tab that has loaded before is asking again on purpose: the refresh
    // button, or trying again after a failure. That is the one case worth
    // going past the CDN's cache for.
    let refresh = out.with_state(|state| state.training.status != TrainingStatus::Idle);
    out.emit(TrainingEvent::Loading);

    // Three independent reads, side by side, and the library is published the
    // moment it arrives. The catalogue used to be asked for only after the
    // ratings and the whole map vault had loaded, which on a first visit is
    // dozens of pages of maps before a few kilobytes of guides.
    //
    // The ratings come from the matchmaker profile, which only the play tab
    // used to ask for, so opening training first left the profile with one
    // number standing in for five. The map previews are what a build order's
    // card shows.
    let (loaded, (), ()) = tokio::join!(
        publish_catalogue(refresh, ctx, out),
        ask_for_own_ratings(refresh, ctx, out),
        ask_for_map_previews(ctx, out),
    );
    if !loaded {
        return;
    }

    // The player's own recent games, which is what "recommended for you" is
    // read from. A bounded scan, and only when it has not happened yet: the
    // replays tab asks for the same list for its own reasons.
    //
    // Deliberately after the library is on screen rather than before. Reading
    // forty replay headers off disk is the slowest thing this load does, and
    // holding the whole tab blank for it would trade the part that is useful
    // immediately for the part that is only a ranking.
    if out.with_state(|state| state.replays.local_status == VaultStatus::Idle) {
        super::replays::handle(
            ReplayCommand::LoadLocal {
                limit: PROFILE_REPLAY_REQUEST,
            },
            ctx,
            out,
        )
        .await;
    }

    // Last, so the ids it names are ids the state now holds and the profile it
    // ranks against is the one the scan just produced.
    recompute_recommendations(ctx, out, true);
}

/// Fetch the catalogue and put it on screen. `false` when it could not be had.
async fn publish_catalogue(refresh: bool, ctx: &ServiceCtx, out: &EventSink) -> bool {
    let catalogue = match ctx.ports.training.list_catalogue(refresh).await {
        Ok(catalogue) => catalogue,
        Err(reason) => {
            out.emit(TrainingEvent::LoadFailed { reason });
            return false;
        }
    };

    let resources = catalogue.resources;
    let trainers = with_avatars(catalogue.trainers, ctx).await;
    out.emit(TrainingEvent::Loaded {
        resources,
        trainers,
        links: catalogue.links,
        source: catalogue.source,
    });
    // Ranked straight away against whatever is already known, so the rail is
    // not empty while the ratings and the replay scan finish. The end of the
    // load ranks again with everything.
    recompute_recommendations(ctx, out, false);
    true
}

// The library used to be the catalogue *plus* FAF's tutorial API, folded
// together by `merge_catalogue`. That is gone. The API returns entries flagged
// playable whose maps and scenarios no longer start anything, and link
// categories ("Video tutorials", "Written guides") that are neither lessons nor
// tagged, so the tab filled with rows that either did nothing or were
// unfindable. Worse, none of it could be corrected without a client release,
// which is the one thing this whole design exists to avoid.
//
// Everything a player reads now comes from the catalogue repository. Anything
// of FAF's worth keeping can be added there in a commit, where it gains the
// tags that make it findable and somebody's name against the decision.

/// Rank the library against the profile the state describes now.
///
/// `always` emits even when nothing changed, which a load wants so the tab
/// learns the profile it was ranked against. The watcher passes `false`: it
/// runs on every event that could matter, and most of them do not.
fn recompute_recommendations(ctx: &ServiceCtx, out: &EventSink, always: bool) {
    let own = own_profile(ctx);
    let update = out.with_state(|state| {
        let profile = profile_from(state, own.as_ref());
        let ids = recommend(&state.training.resources, &profile, RECOMMENDED_LIMIT);
        let changed = ids != state.training.recommended || profile != state.training.profile;
        (always || changed).then_some((ids, profile))
    });
    if let Some((ids, profile)) = update {
        out.emit(TrainingEvent::Recommended {
            resource_ids: ids,
            profile: Box::new(profile),
        });
    }
}

/// Keep the recommendations in step with what they are read from.
///
/// They used to be computed once, at the end of a load, so signing in later,
/// a replay scan finishing, or a game ending changed nothing until the player
/// pressed refresh. Like Discord presence, this is driven by state rather than
/// by a command, so it watches the event stream. Called once from the runtime
/// loop; the task lives for the process.
pub fn spawn(ctx: Arc<ServiceCtx>, sink: EventSink) {
    let events = sink.subscribe();
    tokio::spawn(async move { watch(events, ctx, sink).await });
}

async fn watch(
    mut events: tokio::sync::broadcast::Receiver<AppEvent>,
    ctx: Arc<ServiceCtx>,
    sink: EventSink,
) {
    let mut was_playing = sink.with_state(is_playing);
    loop {
        // `None` is a lagged receiver: events were missed, and since the
        // profile is derived from the whole state, recomputing is right.
        let event = match events.recv().await {
            Ok(event) => Some(event),
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => None,
            Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
        };

        let game_ended = if matches!(event, Some(AppEvent::Lobby(_)) | None) {
            let playing = sink.with_state(is_playing);
            let ended = was_playing && !playing;
            was_playing = playing;
            ended
        } else {
            false
        };

        let reaction = match &event {
            // First, so a game that ended during a lag is still rescanned.
            _ if game_ended => Reaction::Rescan,
            Some(AppEvent::Auth(AuthEvent::LoggedIn { .. } | AuthEvent::TestLoggedIn { .. })) => {
                Reaction::SignedIn
            }
            Some(AppEvent::Auth(AuthEvent::LoggedOut | AuthEvent::WentOffline)) => {
                Reaction::SignedOut
            }
            Some(AppEvent::Replays(
                ReplayEvent::LocalLoaded { .. } | ReplayEvent::LocalDeleted { .. },
            ))
            | Some(AppEvent::PlayerCard(PlayerCardEvent::MatchmakerProfileLoaded { .. }))
            | None => Reaction::Recompute,
            _ => continue,
        };

        // A sign-out forgets the account's ratings whether or not the tab
        // was ever opened, so the next account cannot inherit them.
        if matches!(reaction, Reaction::SignedOut) {
            set_own_profile(&ctx, None);
        }
        // Nothing to keep current until the tab has loaded once; its first
        // load computes everything from scratch.
        if sink.with_state(|state| state.training.status == TrainingStatus::Idle) {
            continue;
        }

        match reaction {
            Reaction::SignedIn => {
                let ctx = ctx.clone();
                let sink = sink.clone();
                tokio::spawn(async move {
                    ask_for_own_ratings(false, &ctx, &sink).await;
                    recompute_recommendations(&ctx, &sink, false);
                });
            }
            Reaction::SignedOut | Reaction::Recompute => {
                recompute_recommendations(&ctx, &sink, false);
            }
            Reaction::Rescan => {
                // The game just played is the newest thing the profile could
                // learn from. The scan's own `LocalLoaded` brings the
                // recommendations up to date.
                let ctx = ctx.clone();
                let sink = sink.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(GAME_END_RESCAN_DELAY).await;
                    super::replays::handle(
                        ReplayCommand::LoadLocal {
                            limit: rescan_limit(&sink),
                        },
                        &ctx,
                        &sink,
                    )
                    .await;
                });
            }
        }
    }
}

enum Reaction {
    SignedIn,
    SignedOut,
    Recompute,
    Rescan,
}

/// Whether Forged Alliance is running for this client, as the lobby sees it.
fn is_playing(state: &AppState) -> bool {
    matches!(
        state.lobby.join,
        JoinState::Launched { .. } | JoinState::InGame
    )
}

/// How many headers a rescan reads: at least the profile's window, and never
/// fewer than the replays tab already had read, so the rescan does not take
/// detail away from rows that tab is showing.
fn rescan_limit(sink: &EventSink) -> u32 {
    let read = sink.with_state(|state| {
        state
            .replays
            .local
            .iter()
            .filter(|replay| !replay.teams.is_empty())
            .count()
    });
    u32::try_from(read)
        .unwrap_or(u32::MAX)
        .max(PROFILE_REPLAY_REQUEST)
}

/// Fill in a review request from whichever replay the caller named.
///
/// Everything a reviewer asks for is already in the client: the replay id and
/// its link, the map, the mode, when it was played, and this account's own
/// faction and rating in that game. What is left for the player is the only
/// part they alone can answer, which is what they want help with.
fn draft_for(
    state: &AppState,
    own: Option<&MatchmakerPlayerProfile>,
    replay_uid: Option<i32>,
    local_path: Option<&str>,
) -> ReviewRequestDraft {
    let profile = profile_from(state, own);
    let base = ReviewRequestDraft {
        player: profile.player.clone(),
        rating: profile.rating.map(|r| r.to_string()).unwrap_or_default(),
        ..ReviewRequestDraft::default()
    };

    if let Some(path) = local_path.filter(|path| !path.is_empty()) {
        if let Some(replay) = state.replays.local.iter().find(|entry| entry.path == path) {
            return from_local(replay, &profile, base);
        }
    }
    if let Some(uid) = replay_uid {
        if let Some(replay) = state
            .replays
            .local
            .iter()
            .find(|entry| entry.uid == Some(uid))
        {
            return from_local(replay, &profile, base);
        }
        if let Some(replay) = state.replays.vault.iter().find(|entry| entry.uid == uid) {
            return from_vault(replay, &profile, base);
        }
        // Named but not listed: the id and its link are still the two things
        // that matter most, and losing them because the row has scrolled out
        // of the vault page would be worse than a partly filled form.
        return ReviewRequestDraft {
            replay_id: Some(uid),
            replay_link: replay_link(uid),
            ..base
        };
    }
    base
}

fn from_local(
    replay: &LocalReplay,
    profile: &TrainingProfile,
    base: ReviewRequestDraft,
) -> ReviewRequestDraft {
    // This account's own row, and nobody else's. A replay downloaded to watch
    // has no such row, and the request is then about a game the player was
    // not in: naming them as its player, with their rating, would send a
    // reviewer to watch the wrong army.
    let mine = own_row(replay, &profile.player);

    let game_mode = faf_domain::state::game_mode_of(replay.num_players, &replay.mod_name);

    ReviewRequestDraft {
        replay_id: replay.uid,
        replay_link: replay.uid.map(replay_link).unwrap_or_default(),
        replay_file: replay.file_name.clone(),
        player: mine.map(|player| player.name.clone()).unwrap_or_default(),
        // The rating recorded in the header beats the account's current one:
        // it is what this player was when they played this game, which is the
        // number a reviewer needs. Failing that, the rating for *this game's*
        // mode rather than the account's headline one: telling a reviewer
        // "1800" about a ladder game played at 1200 sends them to watch for
        // the wrong mistakes.
        rating: match mine {
            None => String::new(),
            Some(mine) => mine
                .rating
                .filter(|rating| *rating > 0)
                .map(|rating| rating.to_string())
                .or_else(|| profile.rating_in(&game_mode).map(|r| r.to_string()))
                .unwrap_or_else(|| base.rating.clone()),
        },
        game_mode: game_mode.clone(),
        // The name a reviewer reads rather than the folder the header records.
        map: official_map_name(&replay.map)
            .map(str::to_string)
            .unwrap_or_else(|| replay.map.clone()),
        faction: mine
            .and_then(|player| player.faction)
            .and_then(faction_label)
            .unwrap_or_default(),
        played_at: String::new(),
        ..base
    }
}

fn from_vault(
    replay: &VaultReplay,
    profile: &TrainingProfile,
    base: ReviewRequestDraft,
) -> ReviewRequestDraft {
    let game_mode = faf_domain::state::game_mode_of(
        replay
            .teams
            .iter()
            .map(|team| team.players.len() as i32)
            .sum(),
        &replay.mod_name,
    );
    // The same rule as `from_local`: the player is named only in a game they
    // played in. The vault lists accounts by their current name, which is the
    // one the profile carries.
    let mine = (!profile.player.is_empty())
        .then(|| {
            replay
                .teams
                .iter()
                .flat_map(|team| team.players.iter())
                .find(|player| player.name.eq_ignore_ascii_case(&profile.player))
        })
        .flatten();

    ReviewRequestDraft {
        replay_id: Some(replay.uid),
        replay_link: replay_link(replay.uid),
        player: mine.map(|player| player.name.clone()).unwrap_or_default(),
        // The rating the listing recorded for this player in this game, and
        // failing that the account's rating in the mode the game was played
        // in. Still better than the headline one, for the reason `from_local`
        // gives.
        rating: match mine {
            None => String::new(),
            Some(mine) => mine
                .rating
                .filter(|rating| *rating > 0)
                .map(|rating| rating.to_string())
                .or_else(|| profile.rating_in(&game_mode).map(|r| r.to_string()))
                .unwrap_or_else(|| base.rating.clone()),
        },
        game_mode: game_mode.clone(),
        map: replay.map.clone(),
        faction: mine
            .and_then(|player| player.faction)
            .and_then(faction_label)
            .unwrap_or_default(),
        // The vault listing states when the game started, and a reviewer reads
        // it to know whether the request is about current form.
        played_at: replay.start_time.clone(),
        ..base
    }
}

/// The shareable replay link. Mirrors `ui/src/shared/replayLinks.ts`, which is
/// where the same address is built for the copy-link button.
fn replay_link(uid: i32) -> String {
    format!("https://replay.faforever.com/{uid}")
}

fn faction_label(faction: i32) -> Option<String> {
    match faction {
        1 => Some("UEF"),
        2 => Some("Aeon"),
        3 => Some("Cybran"),
        4 => Some("Seraphim"),
        5 => Some("Random"),
        _ => None,
    }
    .map(|name| name.to_string())
}

/// Whether the tab has anything loaded. Used by the view's first-open guard,
/// kept here so the condition is stated once.
pub fn is_loaded(status: &TrainingStatus) -> bool {
    !matches!(status, TrainingStatus::Idle)
}

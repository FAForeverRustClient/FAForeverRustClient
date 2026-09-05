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
//!
//! 3. **Compose a way out.** A replay review request and a content submission
//!    both end as a forum post the *player* sends. The client's contribution is
//!    knowing which replay, which map, which rating and which category, so that
//!    the player is not asked for any of it.

use faf_domain::state::{
    compose_contribution, compose_review_request, compose_submission, profile_from_state,
    recommend, AppState, ContributionDraft, GuidesEvent, LocalReplay, ReplayCommand,
    ReviewRequestDraft, Trainer, TrainingCommand, TrainingEvent, TrainingProfile, TrainingStatus,
    VaultReplay, VaultStatus, RECOMMENDED_LIMIT,
};

use crate::runtime::{EventSink, ServiceCtx};

/// How many local replays the profile is read from, and therefore how many the
/// scan is asked for when nobody has asked yet.
///
/// Matches [`faf_domain::state::PROFILE_REPLAY_WINDOW`]: reading headers is the
/// expensive part of that scan, and there is no reason to pay for more of them
/// than the recommendation looks at.
const PROFILE_REPLAY_REQUEST: u32 = faf_domain::state::PROFILE_REPLAY_WINDOW as u32;

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
            let draft = out.with_state(|state| draft_for(state, replay_uid, local_path.as_deref()));
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
        TrainingCommand::ComposeContribution { draft } => {
            // A post that has just been composed has not been submitted, and
            // the last submission's result is about a different guide. Said
            // here rather than remembered in the component, because the stale
            // value lives in the backend's state.
            out.emit(GuidesEvent::SubmitReset);
            out.emit(TrainingEvent::ContributionChanged { draft });
            let composed = out.with_state(|state| {
                let draft = state.training.contribution.as_ref()?;
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
/// Load this account's ratings, if nobody has.
///
/// Skipped when the card already holds them, because the player card is shared
/// with the play tab and a second fetch of the same thing would only cost a
/// request. A failure is silent: recommendations without a rating are still
/// recommendations, and a rating is not worth an error banner on a tab that
/// works without one.
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

async fn ask_for_ratings(ctx: &ServiceCtx, out: &EventSink) {
    let wanted = out.with_state(|state| {
        let me = state.auth.player.as_ref()?;
        let already = state
            .player_card
            .matchmaker_profile
            .as_ref()
            .is_some_and(|profile| profile.player_id == me.id);
        (!already).then(|| (me.id, me.name.clone()))
    });

    let Some((player_id, login)) = wanted else {
        return;
    };
    super::player_card::handle(
        faf_domain::state::PlayerCardCommand::LoadMatchmakerProfile { player_id, login },
        ctx,
        out,
    )
    .await;
}

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
    let url = out.with_state(|state| {
        state
            .training
            .resource(&resource_id)
            .filter(|resource| resource.readable)
            .map(|resource| resource.url.clone())
    });
    let Some(url) = url else {
        out.emit(TrainingEvent::GuideFailed {
            resource_id,
            reason: "that entry is a link rather than a guide this client holds".into(),
        });
        return;
    };

    out.emit(TrainingEvent::GuideReading {
        resource_id: resource_id.clone(),
    });
    match ctx.ports.training.read_guide(url).await {
        Ok(markdown) => out.emit(TrainingEvent::GuideRead {
            resource_id,
            markdown,
        }),
        Err(reason) => out.emit(TrainingEvent::GuideFailed {
            resource_id,
            reason,
        }),
    }
}

async fn load(ctx: &ServiceCtx, out: &EventSink) {
    out.emit(TrainingEvent::Loading);

    // The five ratings come from the matchmaker profile, and until now only the
    // play tab ever asked for it. So opening training first left the profile
    // with no ratings at all, and opening it after a visit to play left it with
    // whatever that visit happened to load. Both produced the same symptom: one
    // number standing in for five, which is exactly the thing per-mode ratings
    // exist to stop.
    ask_for_ratings(ctx, out).await;
    ask_for_map_previews(ctx, out).await;

    let catalogue = match ctx.ports.training.list_catalogue().await {
        Ok(catalogue) => catalogue,
        Err(reason) => {
            out.emit(TrainingEvent::LoadFailed { reason });
            return;
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
    recompute_recommendations(out);
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

fn recompute_recommendations(out: &EventSink) {
    let (ids, profile) = out.with_state(|state| {
        let profile = profile_from_state(state);
        let ids = recommend(&state.training.resources, &profile, RECOMMENDED_LIMIT);
        (ids, profile)
    });
    out.emit(TrainingEvent::Recommended {
        resource_ids: ids,
        profile: Box::new(profile),
    });
}

/// Fill in a review request from whichever replay the caller named.
///
/// Everything a reviewer asks for is already in the client: the replay id and
/// its link, the map, the mode, when it was played, and this account's own
/// faction and rating in that game. What is left for the player is the only
/// part they alone can answer, which is what they want help with.
fn draft_for(
    state: &AppState,
    replay_uid: Option<i32>,
    local_path: Option<&str>,
) -> ReviewRequestDraft {
    let profile = profile_from_state(state);
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
    let me = if profile.player.is_empty() {
        replay.recorder.clone()
    } else {
        profile.player.clone()
    };
    let mine = replay
        .teams
        .iter()
        .flat_map(|team| team.players.iter())
        .find(|player| player.name.eq_ignore_ascii_case(&me));

    let game_mode = faf_domain::state::game_mode_of(replay.num_players, &replay.mod_name);

    ReviewRequestDraft {
        replay_id: replay.uid,
        replay_link: replay.uid.map(replay_link).unwrap_or_default(),
        replay_file: replay.file_name.clone(),
        player: me,
        // The rating recorded in the header beats the account's current one:
        // it is what this player was when they played this game, which is the
        // number a reviewer needs. Failing that, the rating for *this game's*
        // mode rather than the account's headline one: telling a reviewer
        // "1800" about a ladder game played at 1200 sends them to watch for
        // the wrong mistakes.
        rating: mine
            .and_then(|player| player.rating)
            .filter(|rating| *rating > 0)
            .map(|rating| rating.to_string())
            .or_else(|| profile.rating_in(&game_mode).map(|r| r.to_string()))
            .unwrap_or_else(|| base.rating.clone()),
        game_mode: game_mode.clone(),
        map: replay.map.clone(),
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

    ReviewRequestDraft {
        replay_id: Some(replay.uid),
        replay_link: replay_link(replay.uid),
        // The vault listing carries no per-player rating, so this is the
        // account's rating in the mode the game was played in. Still better
        // than the headline one, for the reason `from_local` gives.
        rating: profile
            .rating_in(&game_mode)
            .map(|rating| rating.to_string())
            .unwrap_or_else(|| base.rating.clone()),
        game_mode: game_mode.clone(),
        map: replay.map.clone(),
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

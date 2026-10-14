//! Maps: the event's own map database, its pools and the round each pool is
//! played in, and the vetoes over them, of maps and of factions.

use faf_domain::state::{FactionVetoConfig, MapDraft, PoolDraft, TourneyAction, TourneyFaction};

use crate::runtime::{EventSink, ServiceCtx};

use super::write;

pub(super) async fn save_map(
    tournament_id: String,
    mut map: MapDraft,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    if let Some(preview) = out.with_state(|state| {
        let stored = state
            .tourney
            .open_event()
            .map(|event| event.map_db.as_slice())
            .unwrap_or_default();
        faf_domain::state::tourney::vault_preview_for_new_picture(
            &map,
            stored,
            &state.maps.vault,
            |vault| vault.display_name.as_str(),
            |vault| vault.folder_name.as_str(),
            |vault| vault.thumbnail_url_large.as_str(),
        )
        .map(str::to_owned)
    }) {
        map.image = Some(preview);
    }
    write(TourneyAction::SavingMap, ctx, out, {
        let tournament_id = tournament_id.clone();
        async move { ctx.ports.tourney_maps.save_map(&tournament_id, &map).await }
    })
    .await;
}

pub(super) async fn publish_map(
    tournament_id: String,
    map_id: String,
    published: bool,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    let action = TourneyAction::PublishingMap {
        map_id: map_id.clone(),
    };
    write(action, ctx, out, {
        let tournament_id = tournament_id.clone();
        async move {
            ctx.ports
                .tourney_maps
                .publish_map(&tournament_id, &map_id, published)
                .await
        }
    })
    .await;
}

pub(super) async fn delete_map(
    tournament_id: String,
    map_id: String,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    let action = TourneyAction::DeletingMap {
        map_id: map_id.clone(),
    };
    write(action, ctx, out, {
        let tournament_id = tournament_id.clone();
        async move {
            ctx.ports
                .tourney_maps
                .delete_map(&tournament_id, &map_id)
                .await
        }
    })
    .await;
}

pub(super) async fn save_pool(
    tournament_id: String,
    pool: PoolDraft,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    write(TourneyAction::SavingPool, ctx, out, {
        let tournament_id = tournament_id.clone();
        let pool = trimmed(pool);
        async move {
            ctx.ports
                .tourney_maps
                .save_pool(&tournament_id, &pool)
                .await
        }
    })
    .await;
}

pub(super) async fn publish_pool(
    tournament_id: String,
    pool_id: String,
    published: bool,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    let action = TourneyAction::PublishingPool {
        pool_id: pool_id.clone(),
    };
    write(action, ctx, out, {
        let tournament_id = tournament_id.clone();
        async move {
            ctx.ports
                .tourney_maps
                .publish_pool(&tournament_id, &pool_id, published)
                .await
        }
    })
    .await;
}

pub(super) async fn delete_pool(
    tournament_id: String,
    pool_id: String,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    let action = TourneyAction::DeletingPool {
        pool_id: pool_id.clone(),
    };
    write(action, ctx, out, {
        let tournament_id = tournament_id.clone();
        async move {
            ctx.ports
                .tourney_maps
                .delete_pool(&tournament_id, &pool_id)
                .await
        }
    })
    .await;
}

pub(super) async fn assign_pool(
    tournament_id: String,
    round_key: String,
    pool_id: String,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    let action = TourneyAction::AssigningPool {
        round_key: round_key.clone(),
    };
    write(action, ctx, out, {
        let tournament_id = tournament_id.clone();
        async move {
            ctx.ports
                .tourney_maps
                .assign_pool(&tournament_id, &round_key, &pool_id)
                .await
        }
    })
    .await;
}

pub(super) async fn veto_act(
    tournament_id: String,
    match_id: String,
    map_id: String,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    let action = TourneyAction::Vetoing {
        match_id: match_id.clone(),
    };
    write(action, ctx, out, {
        let tournament_id = tournament_id.clone();
        async move {
            ctx.ports
                .tourney_maps
                .veto_act(&tournament_id, &match_id, &map_id)
                .await
        }
    })
    .await;
}

pub(super) async fn veto_set_sides(
    tournament_id: String,
    match_id: String,
    team_a: String,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    let action = TourneyAction::Vetoing {
        match_id: match_id.clone(),
    };
    write(action, ctx, out, {
        let tournament_id = tournament_id.clone();
        async move {
            ctx.ports
                .tourney_maps
                .veto_set_sides(&tournament_id, &match_id, &team_a)
                .await
        }
    })
    .await;
}

pub(super) async fn veto_undo(
    tournament_id: String,
    match_id: String,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    let action = TourneyAction::Vetoing {
        match_id: match_id.clone(),
    };
    write(action, ctx, out, {
        let tournament_id = tournament_id.clone();
        async move {
            ctx.ports
                .tourney_maps
                .veto_undo(&tournament_id, &match_id)
                .await
        }
    })
    .await;
}

pub(super) async fn faction_veto(
    tournament_id: String,
    match_id: String,
    game: i32,
    faction: TourneyFaction,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    let action = TourneyAction::Vetoing {
        match_id: match_id.clone(),
    };
    write(action, ctx, out, {
        let tournament_id = tournament_id.clone();
        async move {
            ctx.ports
                .tourney_maps
                .faction_veto(&tournament_id, &match_id, game, faction)
                .await
        }
    })
    .await;
}

pub(super) async fn set_faction_veto(
    tournament_id: String,
    config: FactionVetoConfig,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    write(TourneyAction::SavingFactionVeto, ctx, out, {
        let tournament_id = tournament_id.clone();
        async move {
            ctx.ports
                .tourney_maps
                .set_faction_veto(&tournament_id, &config)
                .await
        }
    })
    .await;
}

fn trimmed(pool: PoolDraft) -> PoolDraft {
    PoolDraft {
        name: pool.name.trim().to_string(),
        ..pool
    }
}

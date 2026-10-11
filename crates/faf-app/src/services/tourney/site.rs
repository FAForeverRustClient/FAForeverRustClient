//! The tournament site's own pages and the account behind them: the site
//! documents and their reload after a site write, the hosting status, the
//! profile and its Discord handle, and the rules pages.

use faf_domain::state::{AccessKind, SiteRead, TourneyAction, TourneyEvent};

use crate::runtime::{EventSink, ServiceCtx};

use super::reads::open_series;
use super::writes::failed;

/// Whether this account may host: `TourneyRead::LoadHosting`.
pub(super) async fn load_hosting(ctx: &ServiceCtx, out: &EventSink) {
    match ctx.ports.tourney_site.hosting().await {
        Ok(hosting) => out.emit(TourneyEvent::HostingLoaded { hosting }),
        // Silent: not knowing means the create button stays hidden, which
        // is the same as not being allowed and is the safer of the two.
        Err(error) => tracing::warn!(%error, "could not read the hosting status"),
    }
}

/// The account and its Discord handle: `TourneyRead::LoadProfile`.
pub(super) async fn load_profile(ctx: &ServiceCtx, out: &EventSink) {
    // The whole account now, not the handle alone: its roles decide
    // which of the site's pages and consoles are offered.
    load_site(SiteRead::Account, ctx, out).await;
    match ctx.ports.tourney_site.profile().await {
        Ok(discord) => out.emit(TourneyEvent::DiscordLoaded { discord }),
        // Silent, like the hosting status: not knowing the handle only means
        // the signup dialog opens on an empty field, and saying so would be
        // an error banner about something nobody asked for.
        Err(error) => tracing::warn!(%error, "could not read the tournament profile"),
    }
}

/// Save the Discord handle: `TourneyRead::SetDiscord`.
pub(super) async fn set_discord(handle: String, ctx: &ServiceCtx, out: &EventSink) {
    match ctx.ports.tourney_site.set_discord(&handle).await {
        Ok(discord) => out.emit(TourneyEvent::DiscordLoaded { discord }),
        // Loud, unlike the read: somebody typed this and pressed save.
        Err(error) => out.emit(failed(TourneyAction::SavingProfile, &error)),
    }
}

/// The rules pages: `TourneyRead::LoadArticles`.
pub(super) async fn load_articles(ctx: &ServiceCtx, out: &EventSink) {
    match ctx.ports.tourney_site.articles().await {
        Ok(articles) => out.emit(TourneyEvent::ArticlesLoaded { articles }),
        // Silent: the rules pages are supporting text, and an error banner
        // over a working bracket because a FAQ did not load would be noise.
        Err(error) => tracing::warn!(%error, "could not load the tournament rules pages"),
    }
}

/// Read one of the site's documents. The account and the pending bar load
/// silently, like the hosting status; the pages say when they could not.
pub(super) async fn load_site(read: SiteRead, ctx: &ServiceCtx, out: &EventSink) {
    out.emit(TourneyEvent::SiteLoading { read });
    match ctx.ports.tourney_site.site_read(read).await {
        Ok(document) => out.emit(TourneyEvent::SiteLoaded { document }),
        Err(error) => {
            tracing::warn!(%error, ?read, "could not read the tournament site");
            out.emit(TourneyEvent::SiteLoadFailed {
                read,
                reason: error.to_string(),
                kind: error.kind(),
            });
        }
    }
}

/// After a site write: the account and the pending bar always, the hosting
/// status, and the console and the open series where they are on screen.
pub(super) async fn reload_site(ctx: &ServiceCtx, out: &EventSink) {
    load_site(SiteRead::Account, ctx, out).await;
    load_site(SiteRead::Pending, ctx, out).await;
    load_site(
        SiteRead::Access {
            kind: AccessKind::Host,
        },
        ctx,
        out,
    )
    .await;
    let (console, series) = out.with_state(|state| {
        (
            state.tourney.site.console.is_some(),
            state
                .tourney
                .open_series
                .as_ref()
                .map(|series| series.id.clone()),
        )
    });
    if console {
        load_site(SiteRead::Console, ctx, out).await;
    }
    if let Some(series) = series {
        open_series(&series, ctx, out).await;
    }
}

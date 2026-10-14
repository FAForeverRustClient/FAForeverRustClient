//! The site write: one change to the tournament site's own pages and
//! consoles, the event an import opens or the path of an uploaded picture it
//! answers with, and the reload of the console it touched.

use faf_domain::state::{SiteWrite, TourneyAction, TourneyEvent};

use crate::runtime::{EventSink, ServiceCtx};
use crate::services::tourney::site::reload_site;

use super::write_selecting;

pub(super) async fn site_write(write: SiteWrite, ctx: &ServiceCtx, out: &EventSink) {
    // An import names the tournament it made, which then opens; a
    // picture upload names its path, which the editor inserts.
    let answer = std::sync::Arc::new(std::sync::Mutex::new(None::<String>));
    let held = answer.clone();
    let sent = write.clone();
    write_selecting(TourneyAction::SiteWriting, ctx, out, async move {
        let (opened, image) = ctx.ports.tourney_site.site_write(&sent).await?;
        if let Ok(mut slot) = held.lock() {
            *slot = image;
        }
        Ok(opened)
    })
    .await;
    let image = answer.lock().ok().and_then(|mut slot| slot.take());
    if let Some(url) = image {
        out.emit(TourneyEvent::ArticleImageUploaded { url });
    }
    if write.touches_console() {
        reload_site(ctx, out).await;
    }
}

//! Which URLs the window may load, and how a link leaves the client.
//!
//! The embeds (News Hub, the unit database) run in sandboxed iframes with
//! permission to navigate the top frame and to open popups, so every link a
//! user follows out of them reaches the two hooks in [`crate::window`]. This
//! module is the decision those hooks make; keeping it apart from the window
//! builder is what lets the decision be unit tested without a webview.

use tauri_plugin_opener::OpenerExt;

// The News Hub creates most article cards after page load. WebView popup hooks
// do not receive every target="_blank" click from a sandboxed iframe, so mirror
// the Java client's approach: capture every current and future News Hub anchor
// and ask the trusted top-level UI to open it externally. The UI validates the
// frame origin, message source, and final HTTPS URL before invoking the opener.
pub(crate) const NEWS_EXTERNAL_LINK_SCRIPT: &str = r##"
(() => {
  const host = window.location.hostname.toLowerCase();
  const isNewsHub =
    (host === "www.faforever.com" || host === "faforever.com") &&
    (window.location.pathname === "/newshub" ||
      window.location.pathname.startsWith("/newshub/"));
  if (!isNewsHub) return;

  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0) return;

    const target = event.target instanceof Element
      ? event.target
      : event.target?.parentElement;
    const anchor = target?.closest("a[href]");
    if (!anchor) return;

    const rawHref = anchor.getAttribute("href")?.trim();
    if (!rawHref || rawHref.startsWith("#")) return;

    let candidate = rawHref;
    if (/^youtube\.com\//i.test(candidate)) {
      candidate = `https://www.${candidate}`;
    } else if (/^youtu\.be\//i.test(candidate)) {
      candidate = `https://${candidate}`;
    }

    let resolved;
    try {
      resolved = new URL(candidate, document.baseURI);
    } catch {
      return;
    }
    if (resolved.protocol !== "https:") return;

    event.preventDefault();
    event.stopImmediatePropagation();
    window.top.postMessage(
      { type: "faf:open-external-link", url: resolved.href },
      "*",
    );
  }, true);
})();
"##;

/// Where the client's own pages live. Tauri does not serve them from one origin:
/// Windows serves the bundle over `http://tauri.localhost`, macOS and Linux over
/// the custom `tauri://` scheme, and a development build over the Vite server on
/// localhost. Miss one and the hooks below hand the app's own first navigation to
/// the OS browser, leaving an empty window behind.
pub(crate) fn is_app_origin(url: &tauri::Url) -> bool {
    match url.scheme() {
        "tauri" => true,
        // The url crate lowercases hosts, so an exact match is enough here, and
        // it is what keeps `http://localhost.example.com` from passing as ours.
        "http" | "https" => matches!(
            url.host_str(),
            Some("localhost" | "tauri.localhost" | "ipc.localhost" | "asset.localhost")
        ),
        _ => false,
    }
}

/// The app's own pages plus the two site roots the client embeds. Anything else
/// is a link the user followed out of an embed and belongs in their browser.
pub(crate) fn is_internal_navigation(url: &tauri::Url) -> bool {
    let url_str = url.as_str();
    is_app_origin(url)
        || url_str == "https://www.faforever.com/newshub"
        || url_str == "https://faforever.com/newshub"
        || url_str.starts_with("https://www.faforever.com/dist/")
        || url_str.starts_with("https://faforever.github.io/spooky-db")
}

/// The link to hand the operating system, or `None` for one it must never see.
///
/// Two jobs, together because they are one decision. News Hub video links
/// arrive with the destination pasted onto the hub's own path, so those are
/// unwrapped; and the scheme is checked, because the opener starts whatever
/// Windows has registered for it.
///
/// The scheme check used to exist only on `on_new_window`. `on_navigation`
/// passed anything that was not an internal page straight through, so a
/// top-level navigation out of an embedded page to `file:`, `ms-msdt:`,
/// `search-ms:` or any other registered protocol would have been opened by the
/// shell. The embeds run with `allow-top-navigation-by-user-activation`, so
/// that navigation is reachable from a compromised newshub or spooky-db, and
/// the `opener:allow-open-url` capability scope does not apply here: it gates
/// the JavaScript command, not this Rust-side call.
pub(crate) fn external_target(url: &tauri::Url) -> Option<String> {
    if !matches!(url.scheme(), "http" | "https") {
        tracing::warn!(scheme = url.scheme(), "refusing to open a non-web link");
        return None;
    }
    let url_str = url.as_str();
    Some(
        if let Some(stripped) =
            url_str.strip_prefix("https://www.faforever.com/newshub/youtube.com/")
        {
            format!("https://www.youtube.com/{stripped}")
        } else if let Some(stripped) =
            url_str.strip_prefix("https://www.faforever.com/newshub/youtu.be/")
        {
            format!("https://youtu.be/{stripped}")
        } else {
            url_str.to_string()
        },
    )
}

/// Hand a link to the OS browser, if it is one the OS may be given.
pub(crate) fn open_externally<R: tauri::Runtime>(handle: &tauri::AppHandle<R>, url: &tauri::Url) {
    if let Some(target) = external_target(url) {
        let _ = handle.opener().open_url(target, None::<&str>);
    }
}

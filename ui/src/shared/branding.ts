// The repository's canonical FAF mark, in one place, so the webview and the
// native bundle cannot silently drift to different marks again. The file lives
// in `ui/public/assets` and is served verbatim in development and in the
// production bundle; `scripts/generate-app-icon.mjs` renders the same file into
// the native icon set, so there is a single piece of artwork.
export const FAF_LOGO_URL = "/assets/faflogo.svg";

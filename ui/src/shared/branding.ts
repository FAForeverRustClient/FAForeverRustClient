// Import the repository's canonical app icon so the webview and native bundle
// cannot silently drift to different marks again. Vite fingerprints the image
// into the production bundle and serves it directly during development.
import fafLogoUrl from "../../../app-icon.png";

export const FAF_LOGO_URL = fafLogoUrl;

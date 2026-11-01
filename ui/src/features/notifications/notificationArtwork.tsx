import type { AppState, ClientNotification } from "../../ipc/bindings";
import { mapPresentation } from "../../shared/mapPresentation";

/** Use the same already-announced avatar/map artwork as the regular lists. */
export function notificationArtwork(item: ClientNotification, state: AppState): string | null {
  const action = item.action;
  let image: string | undefined;
  if (action?.type === "openChat") {
    image = state.social.players.find((p) => p.login.toLowerCase() === action.payload.channel.toLowerCase())?.avatarUrl;
  } else {
    const map = action?.type === "openGame" ? state.lobby.games.find((g) => g.id === action.payload.gameId)?.map
      : action?.type === "watchLive" || action?.type === "watchLiveWhenReady" ? action.payload.target.map : undefined;
    if (map) image = mapPresentation(state.maps.vault, map, state.coop.missions).thumbnailUrl;
  }
  if (!image) return null;
  if (image.startsWith("/assets/") && !image.includes("\\")) return image;
  try {
    const url = new URL(image);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function NotificationArtwork({ url }: { url: string | null }) {
  return url ? <img className="notification-artwork" src={url} alt="" decoding="async" draggable={false}
    onError={(event) => { event.currentTarget.hidden = true; }} /> : null;
}

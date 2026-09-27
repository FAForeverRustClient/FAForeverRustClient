// The pioneer mark in a lobby title, read for display.
//
// Twin of `PIONEER_TITLE_TAG` and `title_marks_pioneer` in the domain's
// `state/lobby.rs`: a lobby hosted on the Go ICE adapter carries "[pioneer]"
// in its title, because nothing the server sends names the host's adapter and
// the two adapters cannot connect to each other. The backend reads the mark to
// pick the adapter; this reads it to show a "Pioneer" chip instead of the raw
// tag. Other clients show the tag as typed, which is how their players learn
// the lobby needs Go.

export const PIONEER_TITLE_TAG = "[pioneer]";

/** The title as it should be shown, and whether it carried the mark. */
export function splitPioneerTitle(title: string): { title: string; pioneer: boolean } {
  const at = title.toLowerCase().indexOf(PIONEER_TITLE_TAG);
  if (at < 0) return { title, pioneer: false };
  const shown = `${title.slice(0, at)}${title.slice(at + PIONEER_TITLE_TAG.length)}`
    .replace(/\s{2,}/g, " ")
    .trim();
  return { title: shown, pioneer: true };
}

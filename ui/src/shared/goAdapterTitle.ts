// The Go-adapter mark in a lobby title, read for display.
//
// Twin of `GO_ADAPTER_TITLE_TAG` and `title_marks_go_adapter` in the domain's
// `state/lobby.rs`: a lobby hosted on the Go ICE adapter carries "[go-adapter]"
// in its title, because nothing the server sends names the host's adapter and
// the two adapters cannot connect to each other. The backend reads the mark to
// pick the adapter; this reads it to show a "Go adapter" chip instead of the
// raw tag. Other clients show the tag as typed, which is how their players learn
// the lobby needs Go.

export const GO_ADAPTER_TITLE_TAG = "[go-adapter]";
export const EXP_JAVA_ADAPTER_TITLE_TAG = "[exp-java-adapter]";

/** The title as it should be shown, and whether it carried the mark. */
export function splitGoAdapterTitle(title: string): { title: string; goAdapter: boolean; expJavaAdapter: boolean } {
  const atGo = title.toLowerCase().indexOf(GO_ADAPTER_TITLE_TAG);
  if (atGo >= 0) {
    const shown = `${title.slice(0, atGo)}${title.slice(atGo + GO_ADAPTER_TITLE_TAG.length)}`
      .replace(/\s{2,}/g, " ")
      .trim();
    return { title: shown, goAdapter: true, expJavaAdapter: false };
  }
  const atExp = title.toLowerCase().indexOf(EXP_JAVA_ADAPTER_TITLE_TAG);
  if (atExp >= 0) {
    const shown = `${title.slice(0, atExp)}${title.slice(atExp + EXP_JAVA_ADAPTER_TITLE_TAG.length)}`
      .replace(/\s{2,}/g, " ")
      .trim();
    return { title: shown, goAdapter: false, expJavaAdapter: true };
  }
  return { title, goAdapter: false, expJavaAdapter: false };
}

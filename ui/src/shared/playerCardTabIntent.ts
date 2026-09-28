// Which tab a player card should open on, when the opener has an opinion.
//
// The card's section tab is component state and resets to "Overview" every
// time a profile loads, which is right for the usual case: you clicked a name
// and you want the name's page. Somewhere else in the client, though, the
// click already says what it is for. "View results on profile" from the
// matchmaker's recent games (issue 361) is a request for one specific tab, and
// landing on Overview makes the reader click again.
//
// Handed over in the renderer rather than through the backend, the same way
// `replaySearchIntent` hands over a vault query and for the same reason: this
// is a message between two pieces of the frontend.

/** The card's own tab ids. Kept as a string union so a typo does not compile. */
export type PlayerCardTabIntent =
  | "overview"
  | "ratings"
  | "statistics"
  | "maps"
  | "results"
  | "achievements"
  | "names"
  | "clan";

let wanted: PlayerCardTabIntent | null = null;

/** Ask the next player card that opens to show this tab. */
export function requestPlayerCardTab(tab: PlayerCardTabIntent) {
  wanted = tab;
}

/**
 * The tab that was asked for, once. Clearing it on read is the point: a
 * request that survived would hijack the next card opened from anywhere else.
 */
export function takePlayerCardTab(): PlayerCardTabIntent | null {
  const tab = wanted;
  wanted = null;
  return tab;
}

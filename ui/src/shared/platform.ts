// What the client can tell about the machine it is running on.
//
// The backend knows this properly and could send it, but nothing in the state
// needs it: the only question the interface asks is whether Forged Alliance
// has to be started through Wine, and that is decided by the user agent of the
// webview the client is drawn in, which is the operating system's own.

/**
 * Whether the game on this machine is a Windows executable that needs a
 * wrapper to run.
 *
 * True everywhere except Windows. FAF ships no native build of the engine, so
 * on Linux (and on macOS, where the same is true) a launch has to go through
 * Wine or Proton, and the two settings that describe one are worth showing.
 * On Windows they are noise, because the answer is always "run it directly".
 *
 * Deliberately a negative test: an unfamiliar user agent shows the settings
 * rather than hiding them, and a setting nobody needs is a smaller failure
 * than a setting somebody needs and cannot reach.
 */
export function gameNeedsALaunchWrapper(): boolean {
  const agent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  return !/Windows/i.test(agent);
}

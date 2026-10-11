// The player's clock: 24-hour (`18:30`) or 12-hour (`6:30 PM`) (issue 425).
//
// The preference is stored with the chat settings, where its switch lives, but
// it is the client's clock and not the chat's: every time of day the client
// prints goes through `hourCycleOptions`. Before this, only the chat honoured
// it, and the notification centre, replays, events, tournaments and the
// leaderboard kept the 12-hour clock of their hardcoded `en-US` (or the clock
// of the selected language) whatever the switch said.

import { useAppStore } from "../../store/store";

/** The current preference, read at call time, for code outside React. */
export function uses24HourClock(): boolean {
  return useAppStore.getState().state.settings.chat.use24HourTime;
}

/**
 * The same preference as a subscription, for a component that stays mounted
 * while the switch is flipped (the notification centre) and has to redraw.
 */
export function useClockPreference(): boolean {
  return useAppStore((state) => state.state.settings.chat.use24HourTime);
}

/**
 * The `Intl.DateTimeFormat` option that applies the preference.
 *
 * `hourCycle` rather than `hour12: false`: the latter lets some engines pick
 * `h24` for `en-US` and print midnight as `24:05`. It combines with
 * `timeStyle` as well as with explicit `hour`/`minute` fields, and overrides
 * whichever clock the locale would have chosen.
 */
export function hourCycleOptions(
  use24HourTime: boolean = uses24HourClock(),
): Pick<Intl.DateTimeFormatOptions, "hourCycle"> {
  return { hourCycle: use24HourTime ? "h23" : "h12" };
}

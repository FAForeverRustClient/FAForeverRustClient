// A player's flag in a replay lineup, when Settings, Appearance asks for it
// (#328).
//
// Off by default: a lineup already carries faction, rating and result, and
// "at some point it becomes too many icons" was the first answer in the
// thread. The people who want flags are mostly preparing casts, and they can
// switch them on.
//
// Where the country comes from, in order: the replay file on disk, whose army
// table records it, then the lobby's player list for somebody online right
// now. The API has no country for an account, so an online replay of players
// who are offline and not downloaded shows none, which is also what the Java
// client does.

import type { ReplayPlayer } from "../../ipc/bindings";
import { flagSrc } from "../../shared/countryFlags";
import { useCountryLabel } from "../../shared/hooks/useCountryLabel";
import { findPlayer } from "../../store/reducer";
import { useAppStore } from "../../store/store";

export function ReplayPlayerFlag({ player }: { player: ReplayPlayer }) {
  const enabled = useAppStore((state) => state.state.settings.appearance.replayFlags);
  const online = useAppStore((state) =>
    enabled && !player.country ? findPlayer(state.state.social, player.name)?.country ?? "" : "",
  );
  const countryOf = useCountryLabel();
  const country = player.country || online;
  if (!enabled || !country) return null;
  const label = countryOf(country);
  return (
    <img
      className="replay-player-flag"
      src={flagSrc(country)}
      alt={label}
      title={label}
      width={16}
      height={16}
      decoding="async"
      draggable={false}
    />
  );
}

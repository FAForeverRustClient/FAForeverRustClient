import { useEffect, useState } from "react";
import { native, type UnitIcons } from "../ipc/native";

const EMPTY: UnitIcons = { units: {}, strategic: {} };
let iconsRequest: Promise<UnitIcons> | null = null;
let loadedIcons: UnitIcons | null = null;

/** Share the game's icon catalogue across readers, including the first render
 * after returning to a tab. Unknown artwork does not need a catalogue request. */
export function useUnitIcons(enabled = true): UnitIcons | null {
  const [icons, setIcons] = useState<UnitIcons | null>(() => loadedIcons);
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    iconsRequest ??= native.readUnitIcons().catch(() => EMPTY).then((loaded) => {
      loadedIcons = loaded;
      return loaded;
    });
    void iconsRequest.then((loaded) => {
      if (current) setIcons(loaded);
    });
    return () => { current = false; };
  }, [enabled]);
  return enabled ? icons ?? loadedIcons : null;
}

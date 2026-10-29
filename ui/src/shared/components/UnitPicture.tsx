// A unit's build icon, shared by the Changelog's unit history and a replay's
// build order: from the installed game (the backend's `unit_icons`, decoded
// from its texture archives), else from the patch notes' icon set, else the
// unit's id.

import { useEffect, useState } from "react";
import type { UnitSummary } from "../../ipc/bindings";
import { native, type UnitIcons } from "../../ipc/native";
import "./unit-picture.css";

/** The game's pictures, asked for once per session and shared by every tile. */
let iconsRequest: Promise<UnitIcons | null> | null = null;

export function useUnitIcons(): UnitIcons | null {
  const [icons, setIcons] = useState<UnitIcons | null>(null);
  useEffect(() => {
    let current = true;
    iconsRequest ??= native.readUnitIcons().catch(() => null);
    void iconsRequest.then((loaded) => {
      if (current) setIcons(loaded);
    });
    return () => {
      current = false;
    };
  }, []);
  return icons;
}

export function UnitPicture({ unit, icons, size }: { unit: UnitSummary; icons: UnitIcons | null; size: number }) {
  const local = icons?.units[unit.id];
  const [failed, setFailed] = useState(false);
  const source = local ?? (failed ? null : unit.iconUrl);
  if (!source) return <span className="unit-picture-id">{unit.id}</span>;
  return (
    <img
      className="unit-picture"
      src={source}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

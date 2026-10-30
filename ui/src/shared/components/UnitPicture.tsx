// A unit's build icon, shared by the Changelog's unit history and a replay's
// build order: from the installed game (the backend's `unit_icons`, decoded
// from its texture archives), else from the patch notes' icon set, else the
// unit's id.

import { useState } from "react";
import type { UnitSummary } from "../../ipc/bindings";
import type { UnitIcons } from "../../ipc/native";
import "./unit-picture.css";

export { useUnitIcons } from "../useUnitIcons";

export function UnitPicture({ unit, icons, size }: { unit: UnitSummary; icons: UnitIcons | null; size: number }) {
  // Each picture that does not load gives way to the next.
  const [failed, setFailed] = useState(0);
  // Nothing until the installed game has answered: the website's picture
  // first would load hundreds of icons only to swap each one a moment later.
  if (!icons) return <span className="unit-picture-pending" style={{ width: size, height: size }} />;
  const sources = [icons.units[unit.id], unit.iconUrl].filter((source): source is string => Boolean(source));
  const source = sources[failed];
  if (!source) return <span className="unit-picture-id">{unit.id}</span>;
  return (
    <img
      key={source}
      className="unit-picture"
      src={source}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      draggable={false}
      onError={() => setFailed(failed + 1)}
    />
  );
}

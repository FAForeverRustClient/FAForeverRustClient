import type { ChangelogIllustration as Illustration } from "../historicalChangelogIcons";
import { ChangelogIcon } from "./ChangelogIcon";
import { FactionIcon } from "./FactionIcon";

/** Shared by the original caption and its contents link; the caption supplies the label. */
export function ChangelogIllustration({ illustration, className, size }: {
  illustration: Illustration; className: string; size: number;
}) {
  return illustration.type === "faction"
    ? <FactionIcon faction={illustration.faction} size={size} className={className} aria-hidden="true" aria-label={undefined} role="presentation" />
    : <ChangelogIcon source={illustration.iconUrl} title={illustration.type === "unit" ? illustration.unitId : undefined} className={className} size={size} />;
}

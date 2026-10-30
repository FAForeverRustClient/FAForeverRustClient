import type { ChangelogIllustration as Illustration } from "../historicalChangelogIcons";
import { changelogUnitIconUrl } from "../changelogUnitIcons";
import { FactionIcon } from "./FactionIcon";

/** Shared by the original caption and its contents link; the caption supplies the label. */
export function ChangelogIllustration({ illustration, className, size }: {
  illustration: Illustration; className: string; size: number;
}) {
  return illustration.type === "faction"
    ? <FactionIcon faction={illustration.faction} size={size} className={className} aria-hidden="true" aria-label={undefined} role="presentation" />
    : <img src={changelogUnitIconUrl(illustration.iconUrl)} alt="" title={illustration.type === "unit" ? illustration.unitId : undefined} className={className} loading="lazy" draggable={false}
        onLoad={event => event.currentTarget.classList.remove("is-missing")}
        onError={event => event.currentTarget.classList.add("is-missing")} />;
}

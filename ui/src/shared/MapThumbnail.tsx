import { useEffect, useMemo, useState } from "react";
import { Icon } from "../design-system/Icon";
import type { VaultMap } from "../ipc/bindings";
import { mapPresentation, mapThumbnailCandidates } from "./mapPresentation";

interface Props {
  mapName: string;
  vault: VaultMap[];
  className?: string;
  placeholderClassName?: string;
  large?: boolean;
}

/** Map art with ordered fallbacks for stale, missing, and not-yet-loaded vault data. */
export function MapThumbnail({
  mapName,
  vault,
  className,
  placeholderClassName,
  large = false,
}: Props) {
  const presentation = mapPresentation(vault, mapName);
  const candidates = useMemo(
    () => mapThumbnailCandidates(vault, mapName, large),
    [large, mapName, vault],
  );
  const [candidateIndex, setCandidateIndex] = useState(0);

  useEffect(() => setCandidateIndex(0), [candidates]);

  const url = candidates[candidateIndex];
  if (!url) {
    return (
      <span className={placeholderClassName} aria-label={`${presentation.displayName} preview unavailable`}>
        <Icon name="maps" size={large ? 34 : 18} />
      </span>
    );
  }

  return (
    <img
      className={className}
      src={url}
      alt={`${presentation.displayName} preview`}
      loading="lazy"
      decoding="async"
      onError={() => setCandidateIndex((index) => index + 1)}
    />
  );
}

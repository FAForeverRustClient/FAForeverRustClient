// The picture a tournament map is drawn with.
//
// `tourneyMapImage` (a pinned rule, so pure) knows two sources: the
// organiser's own upload and FAF's vault. A generated map is in neither: its
// name, `neroxis_map_generator_<version>_<seed>_<options>`, names a map that
// only exists once somebody generates it, so every one of them read "No
// picture" while the Play tab, the replays and the lobby show the generator's
// own art for the same name. This adds what they do: the preview rendered when
// this client generated the map, else the generator's placeholder.

import type { TourneyMap, VaultMap } from "../../ipc/bindings";
import {
  GENERATED_MAP_PLACEHOLDER_URL,
  isGeneratedMap,
  isGeneratedMapPlaceholderUrl,
  mapThumbnailCandidates,
} from "../../shared/mapPresentation";
import { tourneyMapImage } from "../../shared/rules/tourneyRules";

/** The map's picture, or "" when there is none to show. */
export function tourneyMapPicture(map: TourneyMap, assetBase: string, vault: VaultMap[]): string {
  const picture = tourneyMapImage(map, assetBase, vault);
  if (picture !== "" || !isGeneratedMap(map.name)) return picture;
  return mapThumbnailCandidates(vault, map.name)[0] ?? GENERATED_MAP_PLACEHOLDER_URL;
}

/**
 * Whether a picture is worth opening at full size. The generator's placeholder
 * is the same picture for every generated map, so enlarging it shows nothing
 * about the map.
 */
export function canEnlargeMapPicture(picture: string): boolean {
  return picture !== "" && !isGeneratedMapPlaceholderUrl(picture);
}

// The replay's map, as the detail panel needs it: which map it really is,
// whether it is on disk, and the actions that get it there. A generated map
// is resolved from the replay's header, decoded for its size and rebuilt from
// its seed; a vault map is downloaded.

import { useEffect, useMemo } from "react";
import type { LocalReplay, VaultReplay } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { useTranslation } from "../../i18n/useTranslation";
import {
  extractGeneratedMapSeed,
  effectiveReplayMapName,
  findVaultMap,
  isGeneratedMap,
  mapSize,
} from "../../shared/mapPresentation";
import { useAppStore } from "../../store/store";
import { replayMapPresentation } from "./coopReplayMap";
import {
  generatedPreviewFor,
  generatorProgress as describeGeneratorProgress,
  heatmapPreviewUrl as heatmapBackdrop,
  isGeneratorRunning,
  isMapInstalled,
} from "./replayDetailPresentation";

interface Options {
  replay: VaultReplay;
  /** The local file that is this replay, if there is one. */
  localMatch: LocalReplay | undefined;
}

export function useReplayMapPreparation({ replay, localMatch }: Options) {
  const { t } = useTranslation();
  const vault = useAppStore((state) => state.state.maps.vault);
  const installedMaps = useAppStore((state) => state.state.maps.installed);
  const missions = useAppStore((state) => state.state.coop.missions);
  const mapGenStatus = useAppStore((state) => state.state.mapGenerator.status);
  // Subscribed, not read once: the answer arrives from the vault after the
  // panel is already open, and the map is what the header of it says.
  const resolvedMap = useAppStore((state) => state.state.replays.resolvedMaps?.[replay.uid]);

  // The vault names a generated map only generically, so the technical name,
  // seed and all, comes from the replay's own header: the downloaded file's,
  // or the first bytes of it read without saving anything (`resolveMaps`).
  const effectiveMap = effectiveReplayMapName(replay.map, localMatch?.map ?? resolvedMap);
  const isGenerated = isGeneratedMap(effectiveMap);
  const seed = extractGeneratedMapSeed(effectiveMap);
  // The picture of a generated map, once the generator has built one.
  const generatedPreview = useAppStore((state) => isGenerated
    ? generatedPreviewFor(state.state.mapGenerator.previews, effectiveMap)
    : undefined);
  // A generated map's size is in its name, and decoding the name is one
  // command for the one replay this panel shows, as the live panel does. Only
  // once the whole name is known: a bare generator placeholder has no size.
  const decodedMap = useAppStore((state) => state.state.mapGenerator.decoded?.[effectiveMap]);
  useEffect(() => {
    if (!seed || decodedMap) return;
    ipc.send({
      kind: "MapGenerator",
      command: { type: "decodeNames", payload: { mapNames: [effectiveMap] } },
    });
  }, [seed, decodedMap, effectiveMap]);
  // Memoised for the facts row, which is memoised on it.
  const decodedSize = decodedMap?.mapSize;
  const size = useMemo(() => mapSize(vault, effectiveMap, decodedSize), [vault, effectiveMap, decodedSize]);

  const installed = isMapInstalled(installedMaps, effectiveMap);
  const isGeneratingThisMap = isGeneratorRunning(mapGenStatus);
  const generatorProgress = describeGeneratorProgress(mapGenStatus, t);
  const vaultMap = findVaultMap(vault, effectiveMap);
  const presentation = replayMapPresentation(
    vault,
    missions,
    { map: effectiveMap, title: replay.title, modName: replay.modName },
    resolvedMap,
  );

  // The header alone, not the replay (#395). This used to download the whole
  // file into the local replay folder, so opening any online game on a
  // generated map put it in the player's own library as if they had played
  // it. Java's local list is the replays folder, which only the client's own
  // recordings go into (`ReplayFileWriterImpl`).
  const resolvingMap = isGenerated && !seed && replay.replayAvailable && !localMatch && resolvedMap === undefined;
  useEffect(() => {
    if (!resolvingMap || replay.uid <= 0) return;
    ipc.send({ kind: "Replays", command: { type: "resolveMaps", payload: { uids: [replay.uid] } } });
  }, [resolvingMap, replay.uid]);

  // Rebuilding a generated map from its seed, which is how a generated map is
  // obtained: there is nothing to download. Its own value because two places
  // offer it: the thumbnail, while the map is not on disk, and the heatmap,
  // which can still have no picture to draw its cells over after that.
  const generateAction = isGenerated
    ? {
        icon: isGeneratingThisMap ? "refresh" : "plus",
        label: isGeneratingThisMap
          ? t("lobby.details.generatingMap")
          : resolvingMap
            ? t("replays.detail.resolvingMap")
            : t("lobby.details.generateMap"),
        // Without a seed there is nothing to generate from; the header lookup
        // above is what finds one, and a failed lookup leaves nothing to try.
        disabled: isGeneratingThisMap || !seed,
        run: () => {
          if (seed) {
            ipc.send({ kind: "MapGenerator", command: { type: "generateNamed", payload: { mapName: effectiveMap } } });
          }
        },
      }
    : null;
  // The generate button sits in the thumbnail's corner, as it does on every
  // other generated-map thumbnail in the client: building the map is what
  // replaces the placeholder there.
  const thumbGenerateAction = installed ? null : generateAction;
  // A vault map that is not on disk is fetched from the line naming it.
  const downloadMap = !installed && !isGenerated && vaultMap
    ? () =>
        ipc.send({
          kind: "Maps",
          command: { type: "installMap", payload: { folderName: vaultMap.folderName, downloadUrl: vaultMap.downloadUrl } },
        })
    : null;
  // What the heatmap draws its cells over, and what to press when there is
  // nothing to draw them over yet.
  const heatmapPreviewUrl = heatmapBackdrop(generatedPreview, replay.mapThumbnailUrl);
  const heatmapMapAction = !heatmapPreviewUrl && generateAction
    ? {
        label: generateAction.label,
        disabled: generateAction.disabled,
        busy: isGeneratingThisMap,
        run: generateAction.run,
      }
    : undefined;

  return {
    mapGenStatus,
    effectiveMap,
    seed,
    size,
    isGeneratingThisMap,
    generatorProgress,
    presentation,
    thumbGenerateAction,
    downloadMap,
    heatmapPreviewUrl,
    heatmapMapAction,
  };
}

export type ReplayMapPreparation = ReturnType<typeof useReplayMapPreparation>;

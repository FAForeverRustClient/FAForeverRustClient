// Mirrors crates/faf-domain/src/state/map_generator.rs.

import type { MapGeneratorEvent, MapGeneratorState } from "../../ipc/bindings";

/** Twin of `MAX_KEPT_PREVIEWS` in the Rust slice. */
const MAX_KEPT_PREVIEWS = 64;

export function reduceMapGenerator(
  state: MapGeneratorState,
  event: MapGeneratorEvent,
): MapGeneratorState {
  switch (event.type) {
    case "statusChanged":
      return { ...state, status: event.payload.status };
    case "versionResolved":
      return {
        ...state,
        latestVersion: event.payload.version,
        selectedVersion: event.payload.version,
      };
    case "versionsLoaded":
      return {
        ...state,
        latestVersion: state.latestVersion || event.payload.versions[0] || "",
        availableVersions: event.payload.versions,
      };
    case "optionListLoaded": {
      // Each query fills its own list; the key mapping matches the Rust
      // `GeneratorOptionLists::set`.
      const key = {
        symmetries: "symmetries",
        styles: "styles",
        terrainStyles: "terrainStyles",
        textureStyles: "textureStyles",
        resourceStyles: "resourceStyles",
        propStyles: "propStyles",
      }[event.payload.query] as keyof MapGeneratorState["optionLists"];
      return {
        ...state,
        optionLists: { ...state.optionLists, [key]: event.payload.values },
      };
    }
    case "optionsChanged":
      return {
        ...state,
        selectedVersion: event.payload.options.version ?? state.selectedVersion,
        options: event.payload.options,
      };
    case "previewsLoaded": {
      // Twin of the Rust arm, cap and all: a preview is a whole PNG spelled as
      // base64 text, and keeping every one of them for the life of the session
      // is what ended with the page reporting "Out of Memory" after a sitting
      // of twenty or thirty generated maps.
      const held = state.previews ?? {};
      const kept =
        Object.keys(held).length + Object.keys(event.payload.previews).length > MAX_KEPT_PREVIEWS
          ? {}
          : held;
      return { ...state, previews: { ...kept, ...event.payload.previews } };
    }
    case "validationChanged":
      return { ...state, validation: event.payload.issues };
    case "namePredicted":
      return { ...state, predictedName: event.payload.mapName };
    case "namesDecoded":
      return { ...state, decoded: { ...state.decoded, ...event.payload.decoded } };
    case "helpLoaded":
      return { ...state, helpText: event.payload.text };
    case "presetsLoaded":
      return { ...state, presets: event.payload.presets };
  }
}

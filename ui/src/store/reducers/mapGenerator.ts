// Mirrors crates/faf-domain/src/state/map_generator.rs.

import type { MapGeneratorEvent, MapGeneratorState } from "../../ipc/bindings";

export function reduceMapGenerator(
  state: MapGeneratorState,
  event: MapGeneratorEvent,
): MapGeneratorState {
  switch (event.type) {
    case "statusChanged":
      return { ...state, status: event.payload.status };
    case "versionResolved":
      return { ...state, latestVersion: event.payload.version };
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
      return { ...state, options: event.payload.options };
  }
}

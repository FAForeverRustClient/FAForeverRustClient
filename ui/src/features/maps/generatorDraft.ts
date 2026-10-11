import type { GeneratorOptions } from "../../ipc/bindings";
import { nearestLegalSpawnCount } from "../../shared/generatorPresentation";

type Action =
  | { type: "patch"; patch: Partial<GeneratorOptions> }
  | { type: "replace"; options: GeneratorOptions }
  | { type: "teams"; numTeams: number };

export function generatorDraftReducer(form: GeneratorOptions, action: Action): GeneratorOptions {
  switch (action.type) {
    case "patch": return { ...form, ...action.patch };
    case "replace": return action.options;
    case "teams": return {
      ...form, numTeams: action.numTeams,
      spawnCount: nearestLegalSpawnCount(form.spawnCount ?? 6, action.numTeams)
    };
  }
}

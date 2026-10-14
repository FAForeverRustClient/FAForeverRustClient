import type { GeneratorDialogModel } from "./useGeneratorDialog";
import { Row } from "./GenerateMapControls";
import { Select } from "../../design-system/Select";
import { NumberInput } from "../../design-system/NumberInput";
import { MAX_MAPS_PER_RUN, issueKey, describeIssue } from "../../shared/generatorPresentation";
import { loadOptions } from "./generatorCommands";

export function GeneratorBasicOptions({ model }: {
  model: Pick<GeneratorDialogModel,
    | "t"
    | "form"
    | "set"
    | "reproducing"
    | "versionOptions"
    | "mapSizeOptions"
    | "teams"
    | "teamOptions"
    | "changeTeams"
    | "spawnSelectOptions"
    | "seedPinsOneMap"
    | "generationTypeOptions"
    | "blocking"
    | "advisory"
    | "rawOverrides"
  >
}) {
  const { t, form, set, reproducing, versionOptions, mapSizeOptions, teams, teamOptions, changeTeams, spawnSelectOptions, seedPinsOneMap, generationTypeOptions, blocking, advisory, rawOverrides } = model;
  return (
    <fieldset className="generate-map-fieldset" disabled={reproducing}>
      <div className="generate-map-grid-2col">
        <Row label={t("maps.generate.generatorVersion")}>
          <Select
            label={t("maps.generate.generatorVersion")}
            value={form.version ?? ""}
            options={versionOptions}
            onChange={(value) => {
              const version = value || null;
              set("version", version);
              void loadOptions(version);
            }}
          />
        </Row>

        <Row label={t("maps.generate.mapSize")}>
          <Select
            label={t("maps.generate.mapSize")}
            value={form.mapSize ?? 512}
            options={mapSizeOptions}
            onChange={(v) => set("mapSize", Number(v))}
          />
        </Row>

        <Row label={t("maps.generate.teams")}>
          <Select
            label={t("maps.generate.teams")}
            value={teams}
            options={teamOptions}
            onChange={(v) => changeTeams(Number(v))}
          />
        </Row>

        <Row label={t("maps.generate.spawns")}>
          <Select
            label={t("maps.generate.spawns")}
            value={form.spawnCount ?? 6}
            options={spawnSelectOptions}
            onChange={(v) => set("spawnCount", Number(v))}
          />
        </Row>

        <Row
          label={t("maps.generate.count")}
          hint={seedPinsOneMap ? t("maps.generate.seedPinsOneMap") : undefined}
        >
          <NumberInput
            className="generate-map-control"
            min={1}
            max={MAX_MAPS_PER_RUN}
            disabled={seedPinsOneMap}
            value={seedPinsOneMap ? 1 : (form.numToGenerate ?? 1)}
            onChange={(count) => set("numToGenerate", count)}
          />
        </Row>

        <Row label={t("maps.generate.styleOfGame")}>
          <Select
            label={t("maps.generate.styleOfGame")}
            value={form.generationType}
            options={generationTypeOptions}
            onChange={(v) => set("generationType", v)}
          />
        </Row>
      </div>

      {(blocking.length > 0 || advisory.length > 0) && !rawOverrides && (
        <div className="generate-map-issues">
          {blocking.map((issue) => (
            <p key={issueKey(issue)} className="generate-map-issue is-blocking">
              <span>{describeIssue(issue, t)}</span>
            </p>
          ))}
          {advisory.map((issue) => (
            <p key={issueKey(issue)} className="generate-map-issue is-advisory">
              <span>{describeIssue(issue, t)}</span>
            </p>
          ))}
        </div>
      )}
    </fieldset>


  );
}

import type { GeneratorDialogModel } from "./useGeneratorDialog";
import { Row } from "./GenerateMapControls";
import { MultiSelect } from "../../design-system/MultiSelect";
import { RangeSlider } from "../../design-system/RangeSlider";
import { DENSITY_BINS, densityPercent } from "../../shared/generatorPresentation";

export function GeneratorStyleOptions({ model }: {
  model: Pick<GeneratorDialogModel,
    | "t"
    | "form"
    | "set"
    | "lists"
    | "styleOverrides"
  >
}) {
  const { t, form, set, lists, styleOverrides } = model;
  return (
    <div className="generate-map-grid-2col">
      <Row label={t("maps.generate.symmetries")} className="generate-map-row-symmetries">
        <MultiSelect
          label={t("maps.generate.symmetries")}
          options={lists.symmetries.map((s) => ({ value: s, label: s }))}
          selected={form.symmetries ?? []}
          onChange={(symmetries) => set("symmetries", symmetries)}
          anyLabel={t("maps.generate.randomAny")}
        />
      </Row>

      {/* The four rows below pick one generator each; a map
                        style picks all four at once and the generator ignores
                        the individual flags when it is set (see
                        `protocol::map_generator`). The explanation is always
                        on, because "how do these differ" is the question the
                        two overlapping lists actually raise. */}
      <Row
        label={t("maps.generate.mapStyles")}
        hint={t("maps.generate.mapStyleHint")}
      >
        <MultiSelect
          label={t("maps.generate.mapStyles")}
          options={lists.styles.map((s) => ({ value: s, label: s }))}
          selected={form.styles ?? []}
          onChange={(styles) => set("styles", styles)}
          anyLabel={t("maps.generate.ownStyle")}
        />
      </Row>

      <Row
        label={t("maps.generate.terrainStyles")}
        superseded={styleOverrides}
      >
        <MultiSelect
          label={t("maps.generate.terrainStyles")}
          options={lists.terrainStyles.map((s) => ({ value: s, label: s }))}
          selected={form.terrainStyles ?? []}
          onChange={(terrainStyles) => set("terrainStyles", terrainStyles)}
          anyLabel={t("maps.generate.randomAny")}
        />
      </Row>

      <Row
        label={t("maps.generate.textureStyles")}
        superseded={styleOverrides}
      >
        <MultiSelect
          label={t("maps.generate.textureStyles")}
          options={lists.textureStyles.map((s) => ({ value: s, label: s }))}
          selected={form.textureStyles ?? []}
          onChange={(textureStyles) => set("textureStyles", textureStyles)}
          anyLabel={t("maps.generate.randomAny")}
        />
      </Row>

      <Row
        label={t("maps.generate.resourceStyles")}
        superseded={styleOverrides}
      >
        <MultiSelect
          label={t("maps.generate.resourceStyles")}
          options={lists.resourceStyles.map((s) => ({ value: s, label: s }))}
          selected={form.resourceStyles ?? []}
          onChange={(resourceStyles) => set("resourceStyles", resourceStyles)}
          anyLabel={t("maps.generate.randomAny")}
        />
      </Row>

      <Row
        label={t("maps.generate.propStyles")}
        superseded={styleOverrides}
      >
        <MultiSelect
          label={t("maps.generate.propStyles")}
          options={lists.propStyles.map((s) => ({ value: s, label: s }))}
          selected={form.propStyles ?? []}
          onChange={(propStyles) => set("propStyles", propStyles)}
          anyLabel={t("maps.generate.randomAny")}
        />
      </Row>

      <Row label={t("maps.generate.resourceDensity")} className="generate-map-row-density">
        <RangeSlider
          label={t("maps.generate.resourceDensity")}
          min={0}
          max={DENSITY_BINS}
          low={form.resourceDensityMin ?? null}
          high={form.resourceDensityMax ?? null}
          format={(v) => `${densityPercent(v / DENSITY_BINS)}%`}
          closedScale
          onChange={(low, high) => {
            set("resourceDensityMin", low);
            set("resourceDensityMax", high);
          }}
        />
      </Row>

      <Row label={t("maps.generate.reclaimDensity")} className="generate-map-row-density">
        <RangeSlider
          label={t("maps.generate.reclaimDensity")}
          min={0}
          max={DENSITY_BINS}
          low={form.reclaimDensityMin ?? null}
          high={form.reclaimDensityMax ?? null}
          format={(v) => `${densityPercent(v / DENSITY_BINS)}%`}
          closedScale
          onChange={(low, high) => {
            set("reclaimDensityMin", low);
            set("reclaimDensityMax", high);
          }}
        />
      </Row>
    </div>


  );
}

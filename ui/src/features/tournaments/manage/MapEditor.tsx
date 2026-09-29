// One map of the tournament's own database, being added or edited.
//
// The website's editor, field for field: the name, the spawn information as
// four rows of numbered chips and a size, a free note, a picture of the event's
// own, and whether players can see it. The spawn rows are what casters and
// captains read before a veto ("Spawns Team 1: 1, 3"), so they are typed here
// rather than left to the note.
//
// `map_save` replaces every field the save sends and some it does not, so the
// draft always carries all of them: leaving the spawn information out would
// delete it, and leaving the note out would clear it.

import { useRef, useState } from "react";
import { Button } from "../../../design-system/Button";
import type { MapDraft, MapSpec } from "../../../ipc/bindings";
import type { MessageKey } from "../../../i18n";
import { useTranslation } from "../../../i18n/useTranslation";
import { mapIsSubmittable } from "../../../shared/rules/tourneyRules";

/** `MAP_SPAWN_MAX` on the service: spawn numbers run from 1 to 16. */
const SPAWNS = Array.from({ length: 16 }, (_, index) => index + 1);
/** The sizes `cleanMapSpec` keeps; anything else it stores as none. */
const SIZES = ["5x5", "10x10", "20x20", "40x40", "81x81"];
/** `MAX_IMG_BYTES` on the service. */
const MAX_BYTES = 5 * 1024 * 1024;
/** The formats `saveMapImage` keeps. */
const ACCEPTED = ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp", "image/bmp"];

type SpawnRow = "team1Spawns" | "team2Spawns" | "closedSpawns" | "closedMexSpawns";

const ROWS: [SpawnRow, MessageKey][] = [
  ["team1Spawns", "tournaments.maps.editSpawnsTeam1"],
  ["team2Spawns", "tournaments.maps.editSpawnsTeam2"],
  ["closedSpawns", "tournaments.maps.editClosedSpawns"],
  ["closedMexSpawns", "tournaments.maps.editClosedMex"],
];

const EMPTY_SPEC: MapSpec = {
  team1Spawns: [],
  team2Spawns: [],
  closedSpawns: [],
  closedMexSpawns: [],
  size: "",
};

/** The spec as the service would store it: `null` once nothing is set. */
export function normalisedSpec(spec: MapSpec): MapSpec | null {
  const empty =
    spec.team1Spawns.length === 0 &&
    spec.team2Spawns.length === 0 &&
    spec.closedSpawns.length === 0 &&
    spec.closedMexSpawns.length === 0 &&
    spec.size === "";
  return empty ? null : spec;
}

/** One number switched in or out of a row, kept ascending as the service does. */
export function toggledSpawn(slots: number[], slot: number): number[] {
  return slots.includes(slot)
    ? slots.filter((held) => held !== slot)
    : [...slots, slot].sort((left, right) => left - right);
}

interface MapEditorProps {
  draft: MapDraft;
  /** The picture the map has now, if any, for the preview. */
  currentImage: string;
  busy: boolean;
  onChange: (draft: MapDraft) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

export function MapEditor({ draft, currentImage, busy, onChange, onSubmit, onCancel }: MapEditorProps) {
  const { t } = useTranslation();
  const picker = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const spec = draft.spec ?? EMPTY_SPEC;
  const setSpec = (next: MapSpec) => onChange({ ...draft, spec: normalisedSpec(next) });

  const pickImage = (file: File) => {
    if (!ACCEPTED.includes(file.type)) {
      setProblem("tournaments.images.wrongType");
      return;
    }
    if (file.size > MAX_BYTES) {
      setProblem("tournaments.images.tooLarge");
      return;
    }
    setProblem(null);
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        onChange({ ...draft, image: reader.result, removeImage: false });
      }
    };
    reader.onerror = () => setProblem("tournaments.maps.imageUnreadable");
    reader.readAsDataURL(file);
  };

  // Both are optional on the wire, where absent means "keep the picture".
  const image = draft.image ?? null;
  const removeImage = draft.removeImage ?? false;
  const preview = image ?? (removeImage ? "" : currentImage);

  return (
    <form
      className="tournament-map-editor surface"
      onSubmit={(submitted) => {
        submitted.preventDefault();
        if (mapIsSubmittable(draft)) onSubmit();
      }}
    >
      <strong>{t(draft.id === "" ? "tournaments.maps.addTitle" : "tournaments.maps.editTitle")}</strong>
      <label className="tournament-field">
        <span>{t("tournaments.maps.name")}</span>
        <input
          value={draft.name}
          autoFocus
          maxLength={60}
          placeholder={t("tournaments.maps.namePlaceholder")}
          onChange={(changed) => onChange({ ...draft, name: changed.target.value })}
        />
      </label>

      {ROWS.map(([row, label]) => (
        <fieldset className="tournament-spawn-row" key={row}>
          <legend>
            {t(label)} <span className="muted">{t("tournaments.maps.optional")}</span>
          </legend>
          <div className="tournament-spawn-chips">
            {SPAWNS.map((slot) => {
              const on = spec[row].includes(slot);
              return (
                <button
                  key={slot}
                  type="button"
                  className={on ? "tournament-spawn-chip is-on" : "tournament-spawn-chip"}
                  aria-pressed={on}
                  onClick={() => setSpec({ ...spec, [row]: toggledSpawn(spec[row], slot) })}
                >
                  {slot}
                </button>
              );
            })}
          </div>
        </fieldset>
      ))}

      <label className="tournament-field">
        <span>
          {t("tournaments.maps.sizeLabel")} <span className="muted">{t("tournaments.maps.optional")}</span>
        </span>
        <select value={spec.size} onChange={(changed) => setSpec({ ...spec, size: changed.target.value })}>
          <option value="">{t("tournaments.maps.sizeUnset")}</option>
          {SIZES.map((size) => (
            <option key={size} value={size}>
              {t("tournaments.maps.sizeOption", { size })}
            </option>
          ))}
        </select>
      </label>

      <label className="tournament-field">
        <span>
          {t("tournaments.maps.description")}{" "}
          <span className="muted">{t("tournaments.maps.descriptionHint")}</span>
        </span>
        <textarea
          rows={6}
          maxLength={1000}
          value={draft.description}
          onChange={(changed) => onChange({ ...draft, description: changed.target.value })}
        />
      </label>

      <div className="tournament-field">
        <span>
          {t("tournaments.maps.image")} <span className="muted">{t("tournaments.maps.imageHint")}</span>
        </span>
        {preview !== "" && <img className="tournament-map-editor-preview" src={preview} alt="" />}
        {currentImage !== "" && image === null && (
          <label className="tournament-checkbox">
            <input
              type="checkbox"
              checked={removeImage}
              onChange={(changed) => onChange({ ...draft, removeImage: changed.target.checked })}
            />
            <span>{t("tournaments.maps.removeImage")}</span>
          </label>
        )}
        <input
          ref={picker}
          type="file"
          accept={ACCEPTED.join(",")}
          hidden
          onChange={(changed) => {
            const file = changed.target.files?.[0];
            changed.target.value = "";
            if (file !== undefined) pickImage(file);
          }}
        />
        <div className="tournament-detail-actions">
          <Button type="button" disabled={busy} onClick={() => picker.current?.click()}>
            {t(preview === "" ? "tournaments.maps.chooseImage" : "tournaments.maps.replaceImage")}
          </Button>
          {image !== null && (
            <Button type="button" disabled={busy} onClick={() => onChange({ ...draft, image: null })}>
              {t("tournaments.maps.discardImage")}
            </Button>
          )}
        </div>
        {problem !== null && <p className="tournament-form-hint">{t(problem)}</p>}
      </div>

      <label className="tournament-checkbox">
        <input
          type="checkbox"
          checked={draft.published}
          onChange={(changed) => onChange({ ...draft, published: changed.target.checked })}
        />
        <span>{t("tournaments.maps.publishedLabel")}</span>
      </label>

      <div className="tournament-detail-actions">
        <Button type="submit" variant="primary" disabled={busy || !mapIsSubmittable(draft)}>
          {t("tournaments.maps.save")}
        </Button>
        <Button type="button" disabled={busy} onClick={onCancel}>
          {t("tournaments.maps.cancel")}
        </Button>
      </div>
    </form>
  );
}

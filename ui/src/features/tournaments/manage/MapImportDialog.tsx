// Importing maps and pools from another event this account organises
// (`copy_maps`), the website's "Import from another tourney".
//
// The source's maps are read without opening it, so the event being built
// stays the open one. A map already here, matched by name, is not copied
// twice; the list says which those are before anything is sent, which is the
// question an organiser has when looking at last season's pool.

import { useEffect, useState } from "react";
import { Button } from "../../../design-system/Button";
import { Modal } from "../../../design-system/Modal";
import type {
  CopySource,
  CopySourceMaps,
  MapPick,
  Tourney,
  TourneyLoadStatus,
} from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";

/** The import's reads, handed down from the view as one piece. */
export interface MapImport {
  sources: CopySource[];
  sourcesStatus: TourneyLoadStatus;
  source: CopySourceMaps | null;
  sourceStatus: TourneyLoadStatus;
  onLoadSources: () => void;
  onLoadSource: (tournamentId: string) => void;
}

/** The events worth offering: someone else's, ours to copy, with something in it. */
export function importCandidates(sources: CopySource[], eventId: string): CopySource[] {
  return sources.filter(
    (source) => source.id !== eventId && source.mayCopy && (source.mapCount > 0 || source.poolCount > 0),
  );
}

interface MapImportDialogProps {
  event: Tourney;
  imports: MapImport;
  busy: boolean;
  /** `null` for everything the source has. */
  onImport: (sourceId: string, picked: MapPick | null) => void;
  onClose: () => void;
}

export function MapImportDialog({ event, imports, busy, onImport, onClose }: MapImportDialogProps) {
  const { t } = useTranslation();
  const [chosen, setChosen] = useState("");
  const [search, setSearch] = useState("");
  const [pools, setPools] = useState<string[]>([]);
  const [maps, setMaps] = useState<string[]>([]);

  // Asked once, when the dialog opens: the list is this account's own events,
  // and it does not change while the dialog is up.
  useEffect(() => {
    imports.onLoadSources();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const candidates = importCandidates(imports.sources, event.id);
  const selected = chosen !== "" ? chosen : (candidates[0]?.id ?? "");

  useEffect(() => {
    if (selected === "") return;
    setPools([]);
    setMaps([]);
    imports.onLoadSource(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const source = imports.source !== null && imports.source.tournamentId === selected ? imports.source : null;
  const have = new Set(event.mapDb.map((held) => held.name.trim().toLowerCase()));
  const needle = search.trim().toLowerCase();
  const shownMaps = (source?.maps ?? []).filter((map) => needle === "" || map.name.toLowerCase().includes(needle));
  const toggle = (list: string[], id: string, on: boolean) =>
    on ? [...list, id] : list.filter((held) => held !== id);

  return (
    <Modal onClose={onClose} className="tournament-import-dialog" ariaLabel={t("tournaments.maps.importTitle")}>
      <h3>{t("tournaments.maps.importTitle")}</h3>
      <p className="muted">{t("tournaments.maps.importHint")}</p>

      {imports.sourcesStatus.type === "loading" && <p className="muted">{t("tournaments.maps.importLoading")}</p>}
      {imports.sourcesStatus.type === "failed" && (
        <p className="tournament-refusal">{imports.sourcesStatus.payload.reason}</p>
      )}
      {imports.sourcesStatus.type === "ready" && candidates.length === 0 && (
        <p className="muted">{t("tournaments.maps.importNothing")}</p>
      )}

      {candidates.length > 0 && (
        <label className="tournament-field">
          <span>{t("tournaments.maps.importSource")}</span>
          <select value={selected} onChange={(changed) => setChosen(changed.target.value)}>
            {candidates.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {t("tournaments.maps.importSourceOption", {
                  name: candidate.name,
                  maps: candidate.mapCount,
                  pools: candidate.poolCount,
                })}
              </option>
            ))}
          </select>
        </label>
      )}

      {selected !== "" && imports.sourceStatus.type === "loading" && (
        <p className="muted">{t("tournaments.maps.importLoading")}</p>
      )}
      {selected !== "" && imports.sourceStatus.type === "failed" && (
        <p className="tournament-refusal">{imports.sourceStatus.payload.reason}</p>
      )}

      {source !== null && (
        <div className="tournament-import-body">
          <input
            type="search"
            value={search}
            placeholder={t("tournaments.maps.importSearch")}
            onChange={(changed) => setSearch(changed.target.value)}
          />
          {source.pools.length > 0 && (
            <>
              <h6>{t("tournaments.maps.importPools")}</h6>
              {source.pools.map((pool) => (
                <label className="tournament-checkbox" key={pool.id}>
                  <input
                    type="checkbox"
                    checked={pools.includes(pool.id)}
                    onChange={(changed) => setPools((held) => toggle(held, pool.id, changed.target.checked))}
                  />
                  <span>
                    {pool.name}{" "}
                    <span className="muted">
                      {t("tournaments.maps.importPoolFacts", { count: pool.mapIds.length, bo: pool.bestOf ?? 1 })}
                    </span>
                  </span>
                </label>
              ))}
            </>
          )}
          <h6>{t("tournaments.maps.importMaps")}</h6>
          {shownMaps.length === 0 && <p className="muted">{t("tournaments.maps.importNoMaps")}</p>}
          {shownMaps.map((map) => (
            <label className="tournament-checkbox" key={map.id}>
              <input
                type="checkbox"
                checked={maps.includes(map.id)}
                onChange={(changed) => setMaps((held) => toggle(held, map.id, changed.target.checked))}
              />
              <span>
                {map.name.trim() === "" ? t("tournaments.maps.importUnnamed") : map.name}
                {have.has(map.name.trim().toLowerCase()) && (
                  <span className="tournament-badge" title={t("tournaments.maps.importHaveTitle")}>
                    {t("tournaments.maps.importHave")}
                  </span>
                )}
              </span>
            </label>
          ))}
        </div>
      )}

      <div className="tournament-form-actions">
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button
          disabled={busy || source === null || (pools.length === 0 && maps.length === 0)}
          onClick={() => onImport(selected, { poolIds: pools, mapIds: maps })}
        >
          {t("tournaments.maps.importSelected")}
        </Button>
        <Button variant="primary" disabled={busy || source === null} onClick={() => onImport(selected, null)}>
          {t("tournaments.maps.importAll")}
        </Button>
      </div>
    </Modal>
  );
}

// The tournament's own map database.
//
// Not FAF's vault: a list the organiser keeps per event, holding whatever names
// they intend to play on. A name here is matched against the vault for a preview
// (`matchVaultMap`), but a map that was never uploaded is still a legal entry,
// which is why the field is free text rather than a vault picker.
//
// Publishing is the load-bearing part. The service hides an unpublished map from
// players, so an organiser who builds a pool and never publishes has a round
// whose maps nobody can read. The list says so per row rather than leaving it to
// be discovered.

import { useState } from "react";
import { Button } from "../../../design-system/Button";
import { Icon } from "../../../design-system/Icon";
import type {
  MapDraft,
  MapListStatus,
  Tourney,
  TourneyAdmin,
  VaultMap,
} from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";
import {
  mapIsSubmittable,
  matchVaultMap,
  tourneyMapImage,
} from "../../../shared/rules/tourneyRules";
import { MapSpec } from "../detail/MapsPanel";
import { MapEditor } from "./MapEditor";
import { MapVaultPicker } from "./MapVaultPicker";
import { MapImportDialog, type MapImport } from "./MapImportDialog";

interface MapDbPanelProps {
  event: Tourney;
  vault: VaultMap[];
  vaultStatus: MapListStatus;
  /** Where the service lives, for the organisers' uploaded map pictures. */
  assetBase: string;
  busy: boolean;
  onSave: (map: MapDraft) => void;
  onPublish: (mapId: string, published: boolean) => void;
  onDelete: (mapId: string) => void;
  /** Secret maps: one at a time, or the whole database at once. */
  onAdmin: (change: TourneyAdmin) => void;
  /** Taking maps and pools over from another event this account runs. */
  imports: MapImport;
}


export function MapDbPanel(props: MapDbPanelProps) {
  const { event, vault, busy } = props;
  const { t } = useTranslation();
  /** The row being edited, or a blank draft while adding by hand. */
  const [draft, setDraft] = useState<MapDraft | null>(null);
  const [picking, setPicking] = useState(false);
  const [importing, setImporting] = useState(false);

  const submit = () => {
    if (draft === null || !mapIsSubmittable(draft)) return;
    props.onSave(draft);
    setDraft(null);
  };

  const editing = draft === null ? undefined : event.mapDb.find((held) => held.id === draft.id);
  const editor =
    draft === null ? null : (
      <MapEditor
        draft={draft}
        // The event's own upload only: a vault preview is not this map's
        // picture to remove.
        currentImage={editing === undefined ? "" : tourneyMapImage(editing, props.assetBase, [])}
        busy={busy}
        onChange={setDraft}
        onSubmit={submit}
        onCancel={() => setDraft(null)}
      />
    );

  return (
    <section className="tournament-map-db">
      <div className="tournament-map-db-head">
        <h5>{t("tournaments.maps.heading")}</h5>
        <Button disabled={busy} onClick={() => setImporting(true)}>
          {t("tournaments.maps.importOpen")}
        </Button>
      </div>
      {importing && (
        <MapImportDialog
          event={event}
          imports={props.imports}
          busy={busy}
          onImport={(sourceId, picked) => {
            props.onAdmin({ type: "copyMaps", payload: { sourceId, picked } });
            setImporting(false);
          }}
          onClose={() => setImporting(false)}
        />
      )}

      {event.mapDb.length === 0 && <p className="muted">{t("tournaments.maps.none")}</p>}

      {/* Secret is not hidden. A hidden map is one players cannot see at all;
          a secret one they can see exists, as "Hidden Map 3" with a blank tile,
          and the service withholds its name until it is going to be played.
          The veto grid still works on it, because every id is intact. */}
      {event.mapDb.length > 0 && (
        <div className="tournament-detail-actions">
          <span className="muted">{t("tournaments.maps.secretHint")}</span>
          <Button
            disabled={busy}
            onClick={() => props.onAdmin({ type: "mapSecret", payload: { mapId: null, secret: true } })}
          >
            {t("tournaments.maps.secretAll")}
          </Button>
          <Button
            disabled={busy}
            onClick={() => props.onAdmin({ type: "mapSecret", payload: { mapId: null, secret: false } })}
          >
            {t("tournaments.maps.revealAll")}
          </Button>
        </div>
      )}

      <ul className="tournament-map-list">
        {event.mapDb.map((held) => {
          const vaultMap = matchVaultMap(held, vault);
          // FAF's own preview first: it is the picture players already know
          // from the maps tab. The event's own copy is for maps never uploaded.
          const preview = tourneyMapImage(held, props.assetBase, vault);
                  return (
            <li className="tournament-map-row" key={held.id}>
              {preview ? (
                <img src={preview} alt="" loading="lazy" aria-hidden />
              ) : (
                <span className="tournament-pool-map-blank" aria-hidden />
              )}
              <div className="tournament-map-names">
                <span>{vaultMap?.displayName ?? held.name}</span>
                <MapSpec map={held} />
                {held.description !== "" && <span className="muted">{held.description}</span>}
                {vaultMap === null && (
                  <span className="muted" title={t("tournaments.pools.notInVaultHint")}>
                    {t("tournaments.pools.notInVault")}
                  </span>
                )}
              </div>
              {!held.published && (
                <span className="tournament-hidden-mark" title={t("tournaments.maps.hiddenHint")}>
                  {t("tournaments.maps.hidden")}
                </span>
              )}
              {held.secret && (
                <span className="tournament-hidden-mark" title={t("tournaments.maps.secretHint")}>
                  {t("tournaments.maps.secret")}
                </span>
              )}
              <div className="tournament-detail-actions">
                <Button
                  disabled={busy}
                  onClick={() =>
                    props.onAdmin({
                      type: "mapSecret",
                      payload: { mapId: held.id, secret: !held.secret },
                    })
                  }
                >
                  {t(held.secret ? "tournaments.maps.reveal" : "tournaments.maps.makeSecret")}
                </Button>
                <Button
                  disabled={busy}
                  onClick={() => props.onPublish(held.id, !held.published)}
                >
                  {t(held.published ? "tournaments.maps.hide" : "tournaments.maps.publish")}
                </Button>
                <Button
                  disabled={busy}
                  onClick={() =>
                    setDraft({
                      id: held.id,
                      name: held.name,
                      description: held.description,
                      published: held.published,
                      // Carried unchanged: the service replaces the stored
                      // spawn information with whatever the save sends.
                      spec: held.spec,
                      image: null,
                      removeImage: false,
                    })
                  }
                >
                  {t("tournaments.maps.edit")}
                </Button>
                <Button disabled={busy} onClick={() => props.onDelete(held.id)}>
                  {t("tournaments.maps.delete")}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>

      {/* Two ways in, and the vault one comes first because it is the one that
          resolves: a picked map carries a name the previews and the pool tiles
          can match. Typing one is for a map that was never uploaded. */}
      {picking && (
        <MapVaultPicker
          vault={vault}
          vaultStatus={props.vaultStatus}
          taken={event.mapDb.map((held) => held.name)}
          busy={busy}
          onAdd={(names) => {
            // One `map_save` per map: the service takes a single map per call.
            // They queue behind each other on the write lock, and each starting
            // write clears the previous one's error, which would matter if a
            // middle one could fail on its own. It cannot: a new map with a
            // name and no image is refused only for want of organiser rights,
            // and that refuses all of them, so the last error still stands.
            for (const name of names) {
              props.onSave({
                id: "",
                name,
                description: "",
                published: true,
                spec: null,
                image: null,
                removeImage: false,
              });
            }
            setPicking(false);
          }}
          onCancel={() => setPicking(false)}
        />
      )}

      {editor}

      {/* One way in: FAF's own vault. Typing a name by hand was the second
          button, and it produced the one kind of entry that cannot show a
          preview, cannot be matched to a real map and cannot be checked for
          spelling. The editor below still opens for a map already in the list,
          which is where a name typed on the website gets corrected. */}
      {draft === null && !picking && (
        <div className="tournament-detail-actions">
          <Button variant="primary" disabled={busy} onClick={() => setPicking(true)}>
            <Icon name="search" size={16} /> {t("tournaments.maps.addFromVault")}
          </Button>
        </div>
      )}
    </section>
  );
}

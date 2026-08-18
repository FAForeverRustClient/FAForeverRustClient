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
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import type { MapDraft, MapListStatus, Tourney, VaultMap } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";
import { mapIsSubmittable, matchVaultMap } from "../../shared/tourneyRules";
import { MapVaultPicker } from "./MapVaultPicker";

interface MapDbPanelProps {
  event: Tourney;
  vault: VaultMap[];
  vaultStatus: MapListStatus;
  busy: boolean;
  onSave: (map: MapDraft) => void;
  onPublish: (mapId: string, published: boolean) => void;
  onDelete: (mapId: string) => void;
}

const BLANK: MapDraft = { id: "", name: "", description: "", published: false };

export function MapDbPanel(props: MapDbPanelProps) {
  const { event, vault, busy } = props;
  const { t } = useTranslation();
  /** The row being edited, or a blank draft while adding by hand. */
  const [draft, setDraft] = useState<MapDraft | null>(null);
  const [picking, setPicking] = useState(false);

  const submit = () => {
    if (draft === null || !mapIsSubmittable(draft)) return;
    props.onSave(draft);
    setDraft(null);
  };

  const editor = (
    <form
      className="tournament-map-editor surface"
      onSubmit={(submitted) => {
        submitted.preventDefault();
        submit();
      }}
    >
      <label className="tournament-field">
        <span>{t("tournaments.maps.name")}</span>
        <input
          value={draft?.name ?? ""}
          autoFocus
          placeholder={t("tournaments.maps.namePlaceholder")}
          onChange={(changed) =>
            setDraft((held) => ({ ...(held ?? BLANK), name: changed.target.value }))
          }
        />
      </label>
      <label className="tournament-field">
        <span>{t("tournaments.maps.description")}</span>
        <input
          value={draft?.description ?? ""}
          onChange={(changed) =>
            setDraft((held) => ({ ...(held ?? BLANK), description: changed.target.value }))
          }
        />
      </label>
      <label className="tournament-checkbox">
        <input
          type="checkbox"
          checked={draft?.published ?? false}
          onChange={(changed) =>
            setDraft((held) => ({ ...(held ?? BLANK), published: changed.target.checked }))
          }
        />
        <span>{t("tournaments.maps.publishedLabel")}</span>
      </label>
      <div className="tournament-detail-actions">
        <Button
          type="submit"
          variant="primary"
          disabled={busy || draft === null || !mapIsSubmittable(draft)}
        >
          {t("tournaments.maps.save")}
        </Button>
        <Button type="button" disabled={busy} onClick={() => setDraft(null)}>
          {t("tournaments.maps.cancel")}
        </Button>
      </div>
    </form>
  );

  return (
    <section className="tournament-map-db">
      <h5>{t("tournaments.maps.heading")}</h5>

      {event.mapDb.length === 0 && <p className="muted">{t("tournaments.maps.none")}</p>}

      <ul className="tournament-map-list">
        {event.mapDb.map((held) => {
          const vaultMap = matchVaultMap(held, vault);
          // FAF's own preview first: it is the picture players already know
          // from the maps tab. The event's own copy is for maps never uploaded.
          const preview = vaultMap?.thumbnailUrl || held.imageUrl;
                  return (
            <li className="tournament-map-row" key={held.id}>
              {preview ? (
                <img src={preview} alt="" loading="lazy" aria-hidden />
              ) : (
                <span className="tournament-pool-map-blank" aria-hidden />
              )}
              <div className="tournament-map-names">
                <span>{vaultMap?.displayName ?? held.name}</span>
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
              <div className="tournament-detail-actions">
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
              props.onSave({ id: "", name, description: "", published: true });
            }
            setPicking(false);
          }}
          onCancel={() => setPicking(false)}
        />
      )}

      {draft !== null && editor}

      {draft === null && !picking && (
        <div className="tournament-detail-actions">
          <Button variant="primary" disabled={busy} onClick={() => setPicking(true)}>
            <Icon name="search" size={16} /> {t("tournaments.maps.addFromVault")}
          </Button>
          <Button disabled={busy} onClick={() => setDraft(BLANK)}>
            <Icon name="plus" size={16} /> {t("tournaments.maps.add")}
          </Button>
        </div>
      )}
    </section>
  );
}

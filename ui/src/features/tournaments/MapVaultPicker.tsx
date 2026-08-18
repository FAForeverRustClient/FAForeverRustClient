// Choosing maps for the event out of FAF's own vault.
//
// The reason this exists rather than a text field: the tournament service
// stores a map as nothing but a **name**, and a name typed by hand is a guess
// that only fails later, when the preview does not resolve and players see a
// round whose maps they cannot recognise. Here the organiser searches the
// vault, sees the picture, the size and the player count, and picks.
//
// The free-text field stays beside this on purpose: a map that was never
// uploaded is still a legal entry in a tournament's database, and refusing one
// would be a rule the service does not have.
//
// It reuses the Maps tab's own `MapPreview` and `sizeLabel` rather than drawing
// its own card, so a map looks here exactly as it looks there, CDN fallback
// included.

import { useMemo, useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import type { MapListStatus, VaultMap } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";
import { MapPreview, sizeLabel } from "../maps/MapVaultComponents";
import { mapKey } from "../../shared/tourneyRules";

/**
 * How many results the grid shows at once.
 *
 * The vault is the whole catalogue, several thousand maps. Rendering it would
 * cost seconds for a list nobody reads past the first row; the search is what
 * narrows it, and this is the ceiling while it is still wide.
 */
const SHOWN = 60;

interface MapVaultPickerProps {
  vault: VaultMap[];
  vaultStatus: MapListStatus;
  /** Names already in the event's database, so a map cannot be added twice. */
  taken: string[];
  busy: boolean;
  onAdd: (names: string[]) => void;
  onCancel: () => void;
}

export function MapVaultPicker(props: MapVaultPickerProps) {
  const { vault, vaultStatus, busy } = props;
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string[]>([]);

  // Compared on the folded key rather than the raw name, the same way
  // `matchVaultMap` resolves one: an entry typed as `scmp_009` is the same map
  // as `Seton's Clutch` and must not be offered again.
  const takenKeys = useMemo(() => new Set(props.taken.map(mapKey)), [props.taken]);

  const results = useMemo(() => {
    const wanted = query.trim().toLocaleLowerCase();
    if (wanted === "") return [];
    return vault
      .filter(
        (map) =>
          map.displayName.toLocaleLowerCase().includes(wanted) ||
          map.folderName.toLocaleLowerCase().includes(wanted),
      )
      .slice(0, SHOWN);
  }, [vault, query]);

  const toggle = (name: string) =>
    setPicked((held) =>
      held.includes(name) ? held.filter((other) => other !== name) : [...held, name],
    );

  return (
    <div className="tournament-map-picker surface">
      <label className="tournament-field">
        <span>{t("tournaments.maps.search")}</span>
        <input
          value={query}
          autoFocus
          placeholder={t("tournaments.maps.searchPlaceholder")}
          onChange={(changed) => setQuery(changed.target.value)}
        />
      </label>

      {/* The vault is loaded once per session and shared with the Maps tab.
          Saying it is still arriving is the difference between "no results"
          and "not yet". */}
      {vaultStatus.type === "loading" && <p className="muted">{t("tournaments.maps.vaultLoading")}</p>}
      {vaultStatus.type === "failed" && (
        <p className="tournament-refusal">{vaultStatus.payload.reason}</p>
      )}
      {vaultStatus.type === "ready" && query.trim() !== "" && results.length === 0 && (
        <p className="muted">{t("tournaments.maps.searchEmpty")}</p>
      )}
      {query.trim() === "" && vaultStatus.type === "ready" && (
        <p className="muted">{t("tournaments.maps.searchHint", { count: String(vault.length) })}</p>
      )}

      <div className="tournament-map-grid">
        {results.map((map) => {
          const already = takenKeys.has(mapKey(map.displayName));
          const chosen = picked.includes(map.displayName);
          return (
            <button
              type="button"
              key={map.folderName}
              className={
                chosen
                  ? "tournament-map-tile surface-panel is-picked"
                  : "tournament-map-tile surface-panel"
              }
              disabled={busy || already}
              aria-pressed={chosen}
              onClick={() => toggle(map.displayName)}
            >
              <MapPreview map={map} />
              <span className="tournament-map-tile-name">{map.displayName}</span>
              <span className="muted">
                {sizeLabel(map)} · {t("tournaments.maps.players", { count: String(map.maxPlayers) })}
              </span>
              {already && <span className="muted">{t("tournaments.maps.alreadyAdded")}</span>}
            </button>
          );
        })}
      </div>

      <div className="tournament-detail-actions">
        <Button
          type="button"
          variant="primary"
          disabled={busy || picked.length === 0}
          onClick={() => {
            props.onAdd(picked);
            setPicked([]);
            setQuery("");
          }}
        >
          <Icon name="plus" size={16} />{" "}
          {t("tournaments.maps.addPicked", { count: String(picked.length) })}
        </Button>
        <Button type="button" disabled={busy} onClick={props.onCancel}>
          {t("tournaments.maps.cancel")}
        </Button>
      </div>
    </div>
  );
}

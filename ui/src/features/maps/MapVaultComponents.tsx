import { useEffect, useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { Modal } from "../../design-system/Modal";
import { VaultFeaturedBadge } from "../../design-system/VaultFeaturedBadge";
import type { MapInstallStatus, VaultMap } from "../../ipc/bindings";
import { formatShortDate } from "../../shared/dates";
import { openReviews } from "../reviews/openReviews";
import { t } from "../../i18n";
import { useLocale } from "../../i18n/useTranslation";
import { clientIntlTag } from "../../shared/dates";

export function installNote(status: MapInstallStatus): string | null {
  switch (status.type) {
    case "idle":
      return null;
    case "installing":
      return t("maps.vault.working", { folder: status.payload.folderName });
    case "failed":
      return t("maps.vault.operationFailed", { reason: status.payload.reason });
  }
}

export function sizeLabel(map: Pick<VaultMap, "width" | "height">): string {
  return `${(map.width / 51.2).toFixed(0)} × ${(map.height / 51.2).toFixed(0)} km`;
}

function ratingLabel(map: VaultMap): string {
  return map.reviews > 0 ? `${(map.ratingTenths / 10).toFixed(1)} (${map.reviews})` : t("maps.vault.notRated");
}

function formatCount(value: number): string {
  return new Intl.NumberFormat(clientIntlTag(), {
    notation: value >= 10_000 ? "compact" : "standard",
  }).format(value);
}

function cleanDescription(value: string): string {
  return value.replace(/^<LOC\s+[^>]+>/i, "").trim();
}

export function isOfficialMap(folderName: string): boolean {
  const match = /^(scmp|x1mp)_(\d{3})$/i.exec(folderName);
  if (!match) return false;
  const number = Number(match[2]);
  return match[1].toLocaleLowerCase() === "scmp"
    ? number >= 1 && number <= 40
    : (number >= 1 && number <= 12) || number === 14 || number === 17;
}

export function mapInstalled(map: VaultMap, installedFolders: Set<string>): boolean {
  return isOfficialMap(map.folderName) || installedFolders.has(map.folderName.toLocaleLowerCase());
}

export function MapPreview({ map, large = false }: { map: VaultMap; large?: boolean }) {
  const url = large ? map.thumbnailUrlLarge || map.thumbnailUrl : map.thumbnailUrl;
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);

  if (!url || failed) {
    return (
      <span
        className={
          large
            ? "map-vault-preview map-vault-preview-empty"
            : "map-vault-thumb map-vault-preview-empty"
        }
        aria-hidden="true"
      >
        <Icon name="maps" size={large ? 34 : 24} />
      </span>
    );
  }
  return (
    <img
      className={large ? "map-vault-preview" : "map-vault-thumb"}
      src={url}
      alt={`${map.displayName} preview`}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

export function MapCard({
  map,
  active,
  installed,
  busy,
  onSelect,
  onInstall,
  favorite,
  onToggleFavorite,
}: {
  map: VaultMap;
  active: boolean;
  installed: boolean;
  busy: boolean;
  onSelect: () => void;
  onInstall: () => void;
  favorite: boolean;
  onToggleFavorite: () => void;
}) {
  useLocale();
  const installState = installed
    ? { label: t(isOfficialMap(map.folderName) ? "maps.vault.builtIn" : "maps.vault.installed"), tone: "ok" as const }
    : { label: t("maps.vault.notInstalled"), tone: "muted" as const };

  return (
    <article className={active ? "map-vault-card surface-panel active" : "map-vault-card surface-panel"}>
      <button
        className="map-vault-card-main"
        onClick={onSelect}
        aria-label={`View ${map.displayName}`}
      >
        <span className="map-vault-image-wrap">
          <MapPreview map={map} />
          {map.recommended && <VaultFeaturedBadge />}
        </span>
        <span className="map-vault-card-copy">
          <strong title={map.displayName}>{map.displayName}</strong>
          <small>
            {map.author ? t("maps.vault.byAuthor", { author: map.author }) : t("maps.vault.unknownAuthor")}
            {map.version ? ` · v${map.version}` : ""}
          </small>
        </span>
        <span className="map-vault-card-facts">
          <span className={map.ranked ? "map-vault-type ranked" : "map-vault-type unranked"}>
            {t(map.ranked ? "maps.vault.ranked" : "maps.vault.unranked")}
          </span>
          <span className="map-vault-fact" title={t("maps.vault.maxPlayersTitle", { count: map.maxPlayers || t("maps.vault.unknown") })}>
            <Icon name="users" size={13} /> {map.maxPlayers || "N/A"}
          </span>
          <span className="map-vault-fact" title={`Map dimensions: ${sizeLabel(map)}`}>
            {sizeLabel(map).replace(" km", "")}
          </span>
          <span
            className="map-vault-fact is-rating"
            title={map.reviews ? t("maps.vault.ratingTitle", { score: (map.ratingTenths / 10).toFixed(1), reviews: map.reviews }) : t("maps.vault.noReviews")}
          >
            <Icon name="star" size={12} />
            {map.reviews ? (map.ratingTenths / 10).toFixed(1) : "N/A"}
          </span>
        </span>
      </button>
      <div className="map-vault-card-action">
        <span className={`map-vault-state is-${installState.tone}`}>{installState.label}</span>
        <span className="map-vault-card-buttons">
          <Button
            className={favorite ? "map-favorite-button active" : "map-favorite-button"}
            aria-label={favorite ? `Remove ${map.displayName} from favorites` : `Add ${map.displayName} to favorites`}
            aria-pressed={favorite}
            title={t(favorite ? "maps.vault.removeFavorite" : "maps.vault.addFavorite")}
            onClick={onToggleFavorite}
          >
            <Icon name="star" size={14} fill={favorite ? "currentColor" : "none"} />
          </Button>
          {!installed && (
            <Button variant="primary" disabled={busy || !map.downloadUrl} onClick={onInstall}>
              {t(busy ? "maps.vault.installing" : "maps.vault.install")}
            </Button>
          )}
        </span>
      </div>
    </article>
  );
}

export function MapDetailPanel({
  map,
  installed,
  busy,
  onInstall,
  onUninstall,
  onPreview,
  favorite,
  onToggleFavorite,
}: {
  map: VaultMap;
  installed: boolean;
  busy: boolean;
  onInstall: () => void;
  onUninstall: () => void;
  onPreview: () => void;
  favorite: boolean;
  onToggleFavorite: () => void;
}) {
  useLocale();
  const description = cleanDescription(map.description);
  const removable = installed && !isOfficialMap(map.folderName);
  return (
    <aside className="map-vault-details surface-panel">
      <button
        className="map-vault-detail-preview"
        onClick={onPreview}
        aria-label={`Enlarge ${map.displayName} preview`}
      >
        <MapPreview map={map} large />
        {(map.thumbnailUrlLarge || map.thumbnailUrl) && <span>{t("maps.vault.openPreview")}</span>}
      </button>
      <div className="map-vault-detail-body">
        <div className="map-vault-detail-kicker">
          <span>{map.mapType || t("maps.vault.mapType")}</span>
          <span className={map.ranked ? "ranked" : "unranked"}>
            {t(map.ranked ? "maps.vault.ranked" : "maps.vault.unranked")}
          </span>
          {map.recommended && <span>{t("maps.vault.featured")}</span>}
        </div>
        <h2>{map.displayName}</h2>
        <p className="map-vault-byline">
          {map.author ? t("maps.vault.createdBy", { author: map.author }) : t("maps.vault.unknownAuthor")}
          {map.version ? ` · Version ${map.version}` : ""}
        </p>
        <dl className="map-vault-summary">
          <div><dt>{t("maps.vault.dimensions")}</dt><dd>{sizeLabel(map)}</dd></div>
          <div><dt>{t("maps.vault.maxPlayers")}</dt><dd>{map.maxPlayers || "N/A"}</dd></div>
          <div><dt>{t("maps.vault.allTimePlays")}</dt><dd>{formatCount(map.gamesPlayed)}</dd></div>
          <div><dt>{t("maps.vault.versionPlays")}</dt><dd>{formatCount(map.versionGamesPlayed)}</dd></div>
          <div><dt>{t("maps.vault.communityRating")}</dt><dd>{ratingLabel(map)}</dd></div>
          <div><dt>{t("maps.vault.uploaded")}</dt><dd>{formatShortDate(map.createdAt)}</dd></div>
          <div><dt>{t("maps.vault.mapId")}</dt><dd>{map.mapId ? `#${map.mapId}` : "N/A"}</dd></div>
          <div><dt>{t("maps.vault.folder")}</dt><dd title={map.folderName}>{map.folderName}</dd></div>
        </dl>
        <section className="map-vault-description">
          <h3>{t("maps.vault.description")}</h3>
          <p>{description || t("maps.vault.noDescription")}</p>
        </section>
        <div className="map-vault-detail-actions">
          <Button
            className={favorite ? "map-favorite-button active" : "map-favorite-button"}
            aria-pressed={favorite}
            onClick={onToggleFavorite}
          >
            <Icon name="star" size={14} fill={favorite ? "currentColor" : "none"} />
            {t(favorite ? "maps.vault.favorited" : "maps.vault.favorite")}
          </Button>
          <Button onClick={() => void openReviews("map", map.mapId, map.displayName)}>
            {t("maps.vault.reviews")}
          </Button>
          {removable && (
            <Button className="map-vault-uninstall" disabled={busy} onClick={onUninstall}>
              {t("maps.vault.uninstall")}
            </Button>
          )}
          <Button variant="primary" disabled={busy || installed || !map.downloadUrl} onClick={onInstall}>
            {busy
              ? t("maps.vault.installing")
              : installed
                ? isOfficialMap(map.folderName)
                  ? t("maps.vault.builtIn")
                  : t("maps.vault.installed")
                : t("maps.vault.installMap")}
          </Button>
        </div>
      </div>
    </aside>
  );
}

export function MapUninstallDialog({
  mapName,
  onCancel,
  onConfirm,
}: {
  mapName: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useLocale();
  return (
    <Modal onClose={onCancel}>
      <div className="map-uninstall-dialog">
        <h2>{t("maps.vault.uninstallTitle")}</h2>
        <p>“{mapName}” will be permanently removed from your user maps folder.</p>
        <div>
          <Button onClick={onCancel}>{t("maps.vault.cancel")}</Button>
          <Button className="map-vault-uninstall-confirm" onClick={onConfirm}>{t("maps.vault.uninstallConfirm")}</Button>
        </div>
      </div>
    </Modal>
  );
}

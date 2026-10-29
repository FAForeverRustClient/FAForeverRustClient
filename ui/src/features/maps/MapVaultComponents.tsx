import { useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { ipc } from "../../ipc/client";
import { native } from "../../ipc/native";
import { ConfirmDialog } from "../../design-system/ConfirmDialog";
import { FactsStrip } from "../../design-system/FactsStrip";
import { VaultFeaturedBadge } from "../../design-system/VaultFeaturedBadge";
import type { VaultMap } from "../../ipc/bindings";
import { clientIntlTag, formatShortDate } from "../../shared/format/dates";
import { openReviews } from "../../shared/openReviews";
import { ReportDialog } from "../../shared/components/ReportDialog";
import { VaultDescription } from "../../shared/components/VaultDescription";
import { t } from "../../i18n";
import { useLocale } from "../../i18n/useTranslation";
import { isOfficialMap, ratingLabel, sizeLabel } from "../../shared/mapPresentation";
import { MapPreview } from "../../shared/components/MapPreview";
import { EMPTY_REPLAY_QUERY } from "../../shared/replayQuery";
import { requestReplaySearch } from "../../shared/replaySearchIntent";

function formatCount(value: number): string {
  return new Intl.NumberFormat(clientIntlTag(), {
    notation: value >= 10_000 ? "compact" : "standard",
  }).format(value);
}

/** The Replays tab's online vault, searched for games on this map. */
function showReplaysOn(displayName: string) {
  requestReplaySearch({ ...EMPTY_REPLAY_QUERY, map: displayName });
  ipc.send({ kind: "Nav", command: { type: "selectReplaysSection", payload: { section: "online" } } });
  ipc.send({ kind: "Nav", command: { type: "select", payload: { tab: "replays" } } });
}

function cleanDescription(value: string): string {
  return value.replace(/^<LOC\s+[^>]+>/i, "").trim();
}

/**
 * The community verdict on a map, for a card's top-right corner: a star, the
 * average score and, in brackets, how many reviews it rests on ("4.3 (128)").
 *
 * Renders nothing for a map nobody has reviewed, or one the vault has no
 * record of. A corner reading "no reviews" down most of a long installed list
 * would be the same repeated word the ranked chip it replaces was (#416), so
 * the empty state is silence; the detail panel still says "Not rated".
 */
export function MapRating({ map }: { map: Pick<VaultMap, "ratingTenths" | "reviews"> | undefined }) {
  useLocale();
  if (!map || map.reviews <= 0) return null;
  const score = (map.ratingTenths / 10).toFixed(1);
  const label = t("maps.vault.ratingTitle", { score, reviews: map.reviews });
  return (
    <span className="map-rating" title={label} aria-label={label}>
      <Icon name="star" size={12} fill="currentColor" />
      <span>{score}</span>
      <span className="map-rating-count">({formatCount(map.reviews)})</span>
    </span>
  );
}

export function MapCard({
  map,
  active,
  installed,
  busy,
  onSelect,
  onInstall,
  onUninstall,
  favorite,
  onToggleFavorite,
}: {
  map: VaultMap;
  active: boolean;
  installed: boolean;
  busy: boolean;
  onSelect: () => void;
  onInstall: () => void;
  onUninstall?: () => void;
  favorite: boolean;
  onToggleFavorite: () => void;
}) {
  useLocale();
  const builtIn = installed && isOfficialMap(map.folderName);

  return (
    <article
      className={[
        "map-vault-card surface-panel",
        // On disk already: the mods tab's "in use" tint, quieter, so a page of
        // results says at a glance which of them need no download.
        installed && "is-installed",
        active && "active",
      ].filter(Boolean).join(" ")}
    >
      <button
        className="map-vault-card-main"
        onClick={onSelect}
        aria-label={t("maps.vault.viewMap", { name: map.displayName })}
      >
        <span className="map-vault-image-wrap">
          <MapPreview map={map} />
          {/* Only the endorsement rides on the art, as on a mod card. */}
          {map.recommended && <VaultFeaturedBadge />}
        </span>
        {/* The name with its version at the line's end, and who made it under
            them: the mod card's order. */}
        <span className="map-vault-card-copy">
          <span className="map-vault-name-row">
            <strong className="map-vault-name" title={map.displayName}>{map.displayName}</strong>
            {map.version && <span className="map-vault-version">{t("common.version", { version: map.version })}</span>}
          </span>
          <small className="map-vault-author">
            {map.author ? t("maps.vault.byAuthor", { author: map.author }) : t("maps.vault.unknownAuthor")}
          </small>
        </span>
        <span className="map-vault-card-facts">
          {/* "My maps", or the vault's own "Withdrawn versions: Shown". Every
              other search asks the API to leave these out and the tab drops
              any that arrive anyway, so reaching this badge is deliberate. */}
          {map.hidden && (
            <span className="map-vault-type is-hidden" title={t("maps.vault.hiddenTitle")}>
              {t("maps.vault.hidden")}
            </span>
          )}
          {/* No ranked chip (#416): the installed list's copy of it read
              "Unranked" for every map it could not look up, and the detail
              panel still states it for the map that is selected. */}
          <span className="map-vault-fact" title={t("maps.vault.maxPlayersTitle", { count: map.maxPlayers || t("maps.vault.unknown") })}>
            <Icon name="users" size={13} /> {map.maxPlayers || t("common.notAvailable")}
          </span>
          <span className="map-vault-fact" title={t("maps.vault.dimensionsTitle", { size: sizeLabel(map) })}>
            {sizeLabel(map)}
          </span>
          <span className="map-vault-fact-end">
            <MapRating map={map} />
          </span>
        </span>
      </button>
      {/* The star at the start, the one thing to do with the map at the end:
          install it, or remove it again as an icon. "Uninstall" in red words
          was the loudest thing on a card whose subject is the map. */}
      <div className="map-vault-card-action">
        <button
          type="button"
          className={favorite ? "map-favorite-button active" : "map-favorite-button"}
          aria-label={t(favorite ? "maps.vault.removeFavoriteAria" : "maps.vault.addFavoriteAria", {
            name: map.displayName,
          })}
          aria-pressed={favorite}
          title={t(favorite ? "maps.vault.removeFavorite" : "maps.vault.addFavorite")}
          onClick={onToggleFavorite}
        >
          <Icon name="star" size={15} fill={favorite ? "currentColor" : "none"} />
        </button>
        <span className="map-vault-card-buttons">
          {builtIn ? (
            <span className="map-vault-state">{t("maps.vault.builtIn")}</span>
          ) : installed ? (
            <>
              <span className="map-vault-state is-ok">
                <Icon name="check" size={13} /> {t("maps.vault.installed")}
              </span>
              <Button
                className="map-vault-uninstall is-icon"
                disabled={busy}
                aria-label={t("maps.view.uninstallNamed", { name: map.displayName })}
                title={t(busy ? "maps.view.removing" : "maps.view.uninstall")}
                onClick={onUninstall}
              >
                <Icon name="trash" size={14} />
              </Button>
            </>
          ) : (
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
  favorite,
  mine,
  visibilityBusy,
  onInstall,
  onUninstall,
  onHide,
  onUnhide,
  onPreview,
  onToggleFavorite,
  onAnalyse,
}: {
  map: VaultMap;
  installed: boolean;
  busy: boolean;
  favorite: boolean;
  /** Whether the signed-in player uploaded this map, by author id. */
  mine: boolean;
  visibilityBusy: boolean;
  onInstall: () => void;
  onUninstall: () => void;
  onHide: () => void;
  onUnhide: () => void;
  onPreview: () => void;
  onToggleFavorite: () => void;
  /** Opens the map's pathing and reclaim, which are read from its files. */
  onAnalyse: () => void;
}) {
  useLocale();
  const description = cleanDescription(map.description);
  const builtIn = installed && isOfficialMap(map.folderName);
  const removable = installed && !builtIn;
  const [reporting, setReporting] = useState(false);
  return (
    <aside className="map-detail-panel surface-panel">
      {reporting && (
        <ReportDialog
          kind={t("maps.vault.reportKind")}
          name={map.displayName}
          details={[
            { label: t("maps.vault.reportAuthor"), value: map.author ?? "" },
            { label: t("maps.vault.reportVersion"), value: map.version },
            { label: t("maps.vault.reportFolder"), value: map.folderName },
          ]}
          onClose={() => setReporting(false)}
        />
      )}
      <button
        className="map-detail-preview"
        onClick={onPreview}
        aria-label={t("maps.preview.enlarge", { name: map.displayName })}
      >
        <MapPreview map={map} large />
        {(map.thumbnailUrlLarge || map.thumbnailUrl) && (
          <span className="map-detail-preview-hint">
            <Icon name="search" size={13} /> {t("maps.vault.openPreview")}
          </span>
        )}
      </button>
      <div className="map-detail-body">
        {/* The name large, the way the mod panel and the leaderboard's player
            panel open, who made it under it, then what kind of map it is. */}
        <header className="map-detail-head">
          <div className="map-detail-name-row">
            <h2 className="map-detail-name">{map.displayName}</h2>
            {/* Beside the name and icon-only: reporting something is rare,
                and a full-size button would sit in front of everybody for the
                sake of the few who ever press it. */}
            <button
              type="button"
              className="map-detail-report"
              aria-label={t("vault.report.action")}
              title={t("vault.report.action")}
              onClick={() => setReporting(true)}
            >
              <Icon name="flag" size={13} />
            </button>
          </div>
          <p className="map-detail-byline">
            {map.author ? t("maps.vault.createdBy", { author: map.author }) : t("maps.vault.unknownAuthor")}
          </p>
          <div className="map-detail-tags">
            <span className="map-vault-type">{map.mapType || t("maps.vault.mapType")}</span>
            <span className={map.ranked ? "map-vault-type ranked" : "map-vault-type unranked"}>
              {t(map.ranked ? "maps.vault.ranked" : "maps.vault.unranked")}
            </span>
            {map.recommended && <span className="map-vault-type featured">{t("maps.vault.featured")}</span>}
            {/* To the author only, the way both reference clients do it: to
                anyone else every listed version is visible by definition. */}
            {mine && (
              <span className={map.hidden ? "map-vault-type is-hidden" : "map-vault-type"} title={t("maps.vault.inVault")}>
                {t(map.hidden ? "maps.vault.withdrawn" : "maps.vault.listed")}
              </span>
            )}
          </div>
        </header>

        {/* What the map is, then how it has fared: the training overview's
            facts strip, two to a row as the mod panel has it, because three
            cut the longer labels short. */}
        <FactsStrip
          className="map-detail-facts"
          columns={2}
          groups={[
            {
              facts: [
                { label: t("maps.vault.dimensions"), value: sizeLabel(map) },
                {
                  label: t("maps.vault.maxPlayers"),
                  value: map.maxPlayers || t("common.notAvailable"),
                  unknown: !map.maxPlayers,
                },
              ],
            },
            {
              facts: [
                // "Reviews", as the mod panel labels its rating: "Community
                // rating" did not fit the column in German.
                { label: t("maps.vault.reviews"), value: ratingLabel(map), unknown: map.reviews <= 0 },
                { label: t("maps.vault.allTimePlays"), value: formatCount(map.gamesPlayed) },
                {
                  label: t("maps.vault.reportVersion"),
                  value: map.version ? t("common.version", { version: map.version }) : t("common.notAvailable"),
                  unknown: !map.version,
                },
                { label: t("maps.vault.uploaded"), value: formatShortDate(map.createdAt) },
              ],
            },
          ]}
        />

        <VaultDescription
          className="map-vault-description"
          title={t("maps.vault.description")}
          description={description}
          empty={t("maps.vault.noDescription")}
        />

        {/* One action to a line, icon first, and the one the panel is for
            last: installing the map, or what its state is once it is here. */}
        <div className="map-detail-actions">
          <div className="map-detail-action-list">
            <Button
              variant="ghost"
              className={favorite ? "map-detail-favorite is-active" : "map-detail-favorite"}
              aria-pressed={favorite}
              onClick={onToggleFavorite}
            >
              <Icon name="star" size={15} fill={favorite ? "currentColor" : "none"} />
              {t(favorite ? "maps.vault.favorited" : "maps.vault.favorite")}
            </Button>
            <Button variant="ghost" onClick={() => void openReviews("map", map.mapId, map.displayName)}>
              <Icon name="chat" size={15} />
              {t("maps.vault.reviews")}
            </Button>
            {/* The games played on it are the Replays tab's, searched by the
                map's name, rather than a list of their own here. */}
            <Button variant="ghost" onClick={() => showReplaysOn(map.displayName)}>
              <Icon name="replays" size={15} />
              {t("maps.vault.replaysOnMap")}
            </Button>
            {/* Read from the map's own files, so only once it is here. */}
            {installed && (
              <Button variant="ghost" onClick={onAnalyse}>
                <Icon name="grid" size={15} />
                {t("maps.analysis.open")}
              </Button>
            )}
            {mine && (
              map.hidden ? (
                <Button
                  variant="ghost"
                  disabled={visibilityBusy}
                  title={t("maps.vault.unhideTitle")}
                  onClick={onUnhide}
                >
                  <Icon name="eye" size={15} />
                  {t(visibilityBusy ? "maps.vault.visibilityWorking" : "maps.vault.unhide")}
                </Button>
              ) : (
                // Withdrawing a version is the one the author cannot undo, so
                // it reads like uninstalling rather than like a toggle.
                <Button
                  variant="ghost"
                  className="map-detail-danger"
                  disabled={visibilityBusy}
                  title={t("maps.vault.hideTitle")}
                  onClick={onHide}
                >
                  <Icon name="lock" size={15} />
                  {t(visibilityBusy ? "maps.vault.visibilityWorking" : "maps.vault.hide")}
                </Button>
              )
            )}
            {removable && (
              <Button variant="ghost" onClick={() => void native.openInstalledFolder("maps", map.folderName)}>
                <Icon name="folder" size={15} />
                {t("common.openFolder")}
              </Button>
            )}
            {removable && (
              <Button variant="ghost" className="map-detail-danger" disabled={busy} onClick={onUninstall}>
                <Icon name="trash" size={15} />
                {t("maps.vault.uninstall")}
              </Button>
            )}
          </div>

          {installed ? (
            <Button variant="ghost" className="map-detail-state" disabled>
              <Icon name="check" size={15} />
              {t(builtIn ? "maps.vault.builtIn" : "maps.vault.installed")}
            </Button>
          ) : (
            <Button variant="primary" disabled={busy || !map.downloadUrl} onClick={onInstall}>
              <Icon name="download" size={15} />
              {t(busy ? "maps.vault.installing" : "maps.vault.installMap")}
            </Button>
          )}
        </div>
      </div>
    </aside>
  );
}

/**
 * Confirms withdrawing a version, and says up front that it is a one-way door.
 *
 * The Python client's dialog carries the same warning in the same place, for the
 * same reason: FAF's API lets the author set `hidden` to `true` and only a map
 * administrator set it back, so this is the last moment the warning is useful.
 */
export function MapHideDialog({
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
    <ConfirmDialog
      title={t("maps.vault.hideTitle")}
      body={t("maps.vault.hideBody", { map: mapName })}
      warning={t("maps.vault.hideWarning")}
      confirmLabel={t("maps.vault.hideConfirm")}
      danger
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
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
    <ConfirmDialog
      title={t("maps.vault.uninstallTitle")}
      body={t("maps.vault.uninstallBody", { map: mapName })}
      confirmLabel={t("maps.vault.uninstallConfirm")}
      danger
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

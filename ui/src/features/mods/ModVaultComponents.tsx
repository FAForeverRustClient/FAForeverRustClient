import { useEffect, useState } from "react";

import { ReportDialog } from "../../shared/components/ReportDialog";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { ConfirmDialog } from "../../design-system/ConfirmDialog";
import { FactsStrip } from "../../design-system/FactsStrip";
import { VaultFeaturedBadge } from "../../design-system/VaultFeaturedBadge";
import { openReviews } from "../../shared/openReviews";
import { plainError } from "../../shared/plainError";
import type {
  InstalledMod,
  ModInstallStatus,
  ModToggleStatus,
  VaultMod,
} from "../../ipc/bindings";
import { formatShortDate } from "../../shared/format/dates";
import { VaultDescription } from "../../shared/components/VaultDescription";
import { modUpdateAvailable } from "./modVersions";
import { t } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";

export function installNote(status: ModInstallStatus): string | null {
  switch (status.type) {
    case "idle": return null;
    case "installing": return t("mods.vault.working", { uid: status.payload.uid });
    case "failed": return t("mods.vault.installFailed", { reason: plainError(status.payload.reason) });
  }
}

export function toggleNote(status: ModToggleStatus): string | null {
  switch (status.type) {
    case "idle": return null;
    case "toggling": return t("mods.vault.updating", { uid: status.payload.uid });
    case "failed": return t("mods.vault.toggleFailed", { reason: plainError(status.payload.reason) });
  }
}

export function cleanDescription(value: string): string {
  return value
    .replace(/^<LOC\s+[^>]+>/i, "")
    .trim()
    // Lua long-string brackets left on the text. `mod_info.lua` writes a long
    // description as `[[ ... ]]`, and a parser that reads it a line at a time
    // keeps only the opening `[[`: the vault itself serves "[[" as the whole
    // description of some mods, which the details dialog printed as is.
    .replace(/^\[=*\[/, "")
    .replace(/\]=*\]$/, "")
    .trim();
}

/**
 * The description worth showing: the vault's when it says anything once
 * cleaned, otherwise the one in the installed `mod_info.lua`, which the
 * client parses itself and may have read whole where the vault did not.
 */
export function bestDescription(vault: string | undefined, local: string): string {
  return cleanDescription(vault ?? "") || cleanDescription(local);
}

function ratingLabel(mod: VaultMod): string {
  return mod.reviews > 0
    ? t("mods.vault.ratingSummary", {
        rating: (mod.ratingTenths / 10).toFixed(1),
        reviews: mod.reviews,
      })
    : t("mods.vault.notRated");
}

export function ModPreview({ mod, large = false }: { mod: VaultMod; large?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [mod.thumbnailUrl]);
  if (!mod.thumbnailUrl || failed) {
    return <span className={large ? "mod-vault-preview mod-vault-preview-empty" : "mod-vault-thumb mod-vault-preview-empty"} aria-hidden="true"><Icon name="mods" size={large ? 34 : 25} /></span>;
  }
  return <img className={large ? "mod-vault-preview" : "mod-vault-thumb"} src={mod.thumbnailUrl} alt={t("mods.vault.preview", { name: mod.displayName })} loading="lazy" decoding="async" onError={() => setFailed(true)} />;
}

export function ModCard({
  mod,
  installed,
  active,
  favorite,
  busy,
  working,
  onSelect,
  onInstall,
  onUpdate,
  onToggle,
  onUninstall,
  onToggleFavorite,
}: {
  mod: VaultMod;
  installed: InstalledMod | undefined;
  active: boolean;
  favorite?: boolean;
  busy: boolean;
  working: boolean;
  onSelect: () => void;
  onInstall: () => void;
  /// Replace the installed copy in one step. Separate from `onInstall`
  /// because an install refuses a folder that already exists.
  onUpdate?: () => void;
  /// Switch the installed copy on or off, as the installed list's card does.
  onToggle?: () => void;
  onUninstall?: () => void;
  onToggleFavorite?: () => void;
}) {
  const { t } = useTranslation();
  const updateAvailable = Boolean(installed && modUpdateAvailable(installed.version, mod.version));

  return (
    <article
      className={[
        "mod-vault-card surface-panel",
        // The tag alone was easy to miss in a grid of cards; the tint is what
        // makes "I am playing with this" visible without reading.
        installed?.enabled && "is-in-use",
        active && "active",
      ].filter(Boolean).join(" ")}
    >
      <button className="mod-vault-card-main" onClick={onSelect} aria-label={t("mods.vault.view", { name: mod.displayName })}>
        <span className="mod-vault-image-wrap">
          <ModPreview mod={mod} />
          {/* Only the endorsement rides on the art now. The mod type moved down
              to the facts line, where it sits beside the other things you
              compare between cards rather than covering the logo. */}
          {mod.recommended && <VaultFeaturedBadge />}
        </span>

        <span className="mod-vault-card-copy">
          <strong title={mod.displayName}>{mod.displayName}</strong>
          <small>{mod.author ? t("mods.vault.byAuthor", { author: mod.author }) : t("mods.vault.unknownAuthor")}{mod.version ? ` · ${t("common.version", { version: mod.version })}` : ""}</small>
        </span>

        {/* One line instead of a three-column ruled table: the values are a
            number, a count and a date, and the rules cost more attention than
            the facts did. */}
        <span className="mod-vault-card-facts">
          <span className="mod-vault-facts-row">
            <span className={`mod-vault-type ${mod.modType}`}>{t(mod.modType === "ui" ? "mods.vault.typeBadge.ui" : "mods.vault.typeBadge.sim")}</span>
            {mod.modType === "sim" && (
              <span className={`mod-vault-type ${mod.ranked ? "ranked" : "unranked"}`}>
                {t(mod.ranked ? "mods.vault.state.ranked" : "mods.vault.state.unranked")}
              </span>
            )}
            {/* Installed says only that the folder is there. Enabled is the
                one that answers "am I playing with this right now", which
                nothing in the vault used to say. */}
            {installed?.enabled && (
              <span className="mod-vault-type in-use" title={t("mods.vault.inUseHint")}>
                {t("mods.vault.inUse")}
              </span>
            )}
          </span>
          <span className="mod-vault-facts-row mod-vault-facts-sub">
            <span className="mod-vault-fact is-date" title={t("mods.vault.lastUpdated")}>
              {formatShortDate(mod.updatedAt || mod.createdAt)}
            </span>
            <span
              className="mod-vault-fact is-rating"
              title={mod.reviews
                ? t("mods.vault.ratingTooltip", { rating: (mod.ratingTenths / 10).toFixed(1), reviews: mod.reviews })
                : t("mods.vault.noReviews")}
            >
              <Icon name="star" size={12} />
              {mod.reviews ? t("mods.vault.ratingSummary", { rating: (mod.ratingTenths / 10).toFixed(1), reviews: mod.reviews }) : t("common.notAvailable")}
            </span>
          </span>
        </span>
      </button>

      {/* The installed list's row of controls, in the same order: the star,
          the switch or the update, and remove as an icon. "Uninstall" in red
          words was the loudest thing on a card whose subject is the mod. */}
      <div className="mod-vault-card-action">
        {onToggleFavorite && (
          <button
            type="button"
            className={favorite ? "mod-favorite-button active" : "mod-favorite-button"}
            aria-label={t(favorite ? "mods.vault.removeFavoriteAria" : "mods.vault.addFavoriteAria", {
              name: mod.displayName,
            })}
            aria-pressed={favorite}
            title={t(favorite ? "mods.vault.removeFavorite" : "mods.vault.addFavorite")}
            onClick={onToggleFavorite}
          >
            <Icon name="star" size={15} fill={favorite ? "currentColor" : "none"} />
          </button>
        )}
        <span className="mod-vault-card-buttons">
          {installed ? (
            <>
              {updateAvailable ? (
                <Button variant="primary" disabled={busy || !mod.downloadUrl} onClick={onUpdate ?? onInstall}>
                  {t(working ? "mods.vault.busy" : "mods.vault.update")}
                </Button>
              ) : onToggle ? (
                <Button disabled={busy} onClick={onToggle}>
                  {t(working ? "mods.vault.busy" : installed.enabled ? "mods.vault.disable" : "mods.vault.enable")}
                </Button>
              ) : null}
              <Button
                className="mod-vault-uninstall is-icon"
                disabled={busy}
                aria-label={t("mods.installed.uninstallNamed", { name: mod.displayName })}
                title={t("mods.vault.uninstall")}
                onClick={onUninstall}
              >
                <Icon name="trash" size={14} />
              </Button>
            </>
          ) : (
            <Button variant="primary" disabled={busy || !mod.downloadUrl} onClick={onInstall}>
              {t(working ? "mods.vault.busy" : "mods.vault.install")}
            </Button>
          )}
        </span>
      </div>
    </article>
  );
}

export function ModDetailPanel({
  mod,
  installed,
  favorite,
  busy,
  installing,
  toggling,
  mine = false,
  onInstall,
  onUpdate,
  onToggle,
  onUninstall,
  onToggleFavorite,
  onRename,
}: {
  mod: VaultMod;
  installed: InstalledMod | undefined;
  favorite?: boolean;
  busy: boolean;
  installing: boolean;
  toggling: boolean;
  /** Whether the signed-in account is this mod's uploader. */
  mine?: boolean;
  onInstall: () => void;
  /// See `ModCard`'s. The panel's "Install update" is the same one step.
  onUpdate?: () => void;
  onToggle: () => void;
  onUninstall: () => void;
  onToggleFavorite?: () => void;
  onRename?: () => void;
}) {
  const { t } = useTranslation();
  const description = cleanDescription(mod.description);
  const updateAvailable = Boolean(installed && modUpdateAvailable(installed.version, mod.version));
  const [reporting, setReporting] = useState(false);
  const toggleLabel = t(toggling ? "mods.vault.toggling" : installed?.enabled ? "mods.vault.disable" : "mods.vault.enable");
  return (
    <aside className="mod-detail-panel surface-panel">
      {reporting && (
        <ReportDialog
          kind={t("mods.vault.reportKind")}
          name={mod.displayName}
          details={[
            { label: t("mods.vault.author"), value: mod.author },
            { label: t("mods.vault.version"), value: t("common.version", { version: mod.version }) },
            { label: t("mods.vault.uid"), value: mod.uid },
          ]}
          onClose={() => setReporting(false)}
        />
      )}
      <div className="mod-detail-preview">
        <ModPreview mod={mod} large />
      </div>
      <div className="mod-detail-body">
        {/* The name large, the way the leaderboard's player panel opens, with
            who made it under it and then what kind of mod it is. */}
        <header className="mod-detail-head">
          <div className="mod-detail-name-row">
            <h2 className="mod-detail-name">{mod.displayName}</h2>
            {/* Beside the name and icon-only: reporting something is rare,
                and a full-size button would sit in front of everybody for the
                sake of the few who ever press it. */}
            <button
              type="button"
              className="mod-detail-report"
              aria-label={t("vault.report.action")}
              title={t("vault.report.action")}
              onClick={() => setReporting(true)}
            >
              <Icon name="flag" size={13} />
            </button>
          </div>
          <p className="mod-detail-byline">
            {mod.author ? t("mods.vault.authoredBy", { author: mod.author }) : t("mods.vault.unknownAuthor")}
            {mod.uploader && mod.uploader !== mod.author ? ` · ${t("mods.vault.uploadedBy", { uploader: mod.uploader })}` : ""}
          </p>
          <div className="mod-detail-tags">
            <span className={`mod-vault-type ${mod.modType}`}>
              {t(mod.modType === "ui" ? "mods.vault.uiMod" : "mods.vault.simMod")}
            </span>
            {mod.modType === "sim" && (
              <span className={`mod-vault-type ${mod.ranked ? "ranked" : "unranked"}`}>
                {t(mod.ranked ? "mods.vault.state.ranked" : "mods.vault.state.unranked")}
              </span>
            )}
            {mod.recommended && <span className="mod-vault-type featured">{t("mods.vault.featured")}</span>}
            {installed?.enabled && (
              <span className="mod-vault-type in-use" title={t("mods.vault.inUseHint")}>
                {t("mods.vault.inUse")}
              </span>
            )}
          </div>
        </header>

        {/* What the vault knows about it, as the training overview's facts
            strip: the version and its reviews, then when it appeared and
            when it last changed. */}
        <FactsStrip
          className="mod-detail-facts"
          columns={2}
          groups={[{
            facts: [
              {
                label: t("mods.vault.version"),
                value: mod.version ? t("common.version", { version: mod.version }) : t("common.notAvailable"),
                unknown: !mod.version,
              },
              { label: t("mods.vault.reviews"), value: ratingLabel(mod), unknown: mod.reviews === 0 },
              { label: t("mods.vault.published"), value: formatShortDate(mod.createdAt) },
              { label: t("mods.vault.updated"), value: formatShortDate(mod.updatedAt || mod.createdAt) },
            ],
          }]}
        />

        <VaultDescription
          className="mod-vault-description"
          title={t("mods.vault.description")}
          description={description}
          empty={t("mods.vault.noDescription")}
        />

        {/* One action to a line, icon first, and the one the panel is for
            last: install, update, or switch the mod on or off. */}
        <div className="mod-detail-actions">
          <div className="mod-detail-action-list">
            {onToggleFavorite && (
              <Button
                variant="ghost"
                className={favorite ? "mod-detail-favorite is-active" : "mod-detail-favorite"}
                aria-pressed={favorite}
                onClick={onToggleFavorite}
              >
                <Icon name="star" size={15} fill={favorite ? "currentColor" : "none"} />
                {t(favorite ? "mods.vault.favorited" : "mods.vault.favorite")}
              </Button>
            )}
            <Button variant="ghost" onClick={() => void openReviews("mod", mod.modId, mod.displayName)}>
              <Icon name="chat" size={15} />
              {t("mods.vault.reviews")}
            </Button>
            {/* Only on your own upload, and only with the folder to hand: a
                rename is a fresh publish of the local files with `mod_info.lua`
                rewritten, so there is nothing to send without them. Drawn
                disabled rather than hidden when the folder is missing, because
                "why can I not rename my own mod" is the question a missing
                button would leave. */}
            {mine && onRename && (
              <Button
                variant="ghost"
                disabled={busy || !installed}
                title={t(installed ? "mods.rename.action" : "mods.rename.needsInstall")}
                onClick={onRename}
              >
                <Icon name="edit" size={15} />
                {t("mods.rename.action")}
              </Button>
            )}
            {installed && updateAvailable && (
              <Button variant="ghost" disabled={busy} onClick={onToggle}>
                <Icon name={installed.enabled ? "close" : "check"} size={15} />
                {toggleLabel}
              </Button>
            )}
            {installed && (
              <Button variant="ghost" className="mod-detail-uninstall" disabled={busy} onClick={onUninstall}>
                <Icon name="trash" size={15} />
                {t("mods.vault.uninstall")}
              </Button>
            )}
          </div>

          {updateAvailable ? (
            <Button variant="primary" disabled={busy || !mod.downloadUrl} onClick={onUpdate ?? onInstall}>
              <Icon name="download" size={15} />
              {t(installing ? "mods.vault.busy" : "mods.vault.installUpdate")}
            </Button>
          ) : installed ? (
            <Button variant={installed.enabled ? "ghost" : "primary"} disabled={busy} onClick={onToggle}>
              <Icon name={installed.enabled ? "close" : "check"} size={15} />
              {toggleLabel}
            </Button>
          ) : (
            <Button variant="primary" disabled={busy || !mod.downloadUrl} onClick={onInstall}>
              <Icon name="download" size={15} />
              {t(installing ? "mods.vault.busy" : "mods.vault.installMod")}
            </Button>
          )}
        </div>
      </div>
    </aside>
  );
}

export function UninstallDialog({
  modName,
  onCancel,
  onConfirm,
}: {
  modName: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <ConfirmDialog
      title={t("mods.vault.confirmUninstall")}
      body={t("mods.vault.confirmUninstallBody", { name: modName })}
      confirmLabel={t("mods.vault.confirmUninstallAction")}
      danger
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

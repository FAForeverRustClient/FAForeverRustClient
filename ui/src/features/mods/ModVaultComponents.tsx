import { useEffect, useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { Modal } from "../../design-system/Modal";
import { VaultFeaturedBadge } from "../../design-system/VaultFeaturedBadge";
import { openReviews } from "../reviews/openReviews";
import type {
  InstalledMod,
  ModInstallStatus,
  ModToggleStatus,
  VaultMod,
} from "../../ipc/bindings";
import { formatShortDate } from "../../shared/dates";
import { t } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";

export function installNote(status: ModInstallStatus): string | null {
  switch (status.type) {
    case "idle": return null;
    case "installing": return t("mods.vault.working", { uid: status.payload.uid });
    case "failed": return t("mods.vault.installFailed", { reason: status.payload.reason });
  }
}

export function toggleNote(status: ModToggleStatus): string | null {
  switch (status.type) {
    case "idle": return null;
    case "toggling": return t("mods.vault.updating", { uid: status.payload.uid });
    case "failed": return t("mods.vault.toggleFailed", { reason: status.payload.reason });
  }
}

function cleanDescription(value: string): string {
  return value.replace(/^<LOC\s+[^>]+>/i, "").trim();
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
  busy,
  working,
  onSelect,
  onInstall,
}: {
  mod: VaultMod;
  installed: InstalledMod | undefined;
  active: boolean;
  busy: boolean;
  working: boolean;
  onSelect: () => void;
  onInstall: () => void;
}) {
  const { t } = useTranslation();
  const updateAvailable = Boolean(installed && installed.version !== mod.version);
  // What the card says about your relationship to the mod, which outranks the
  // ranked-safety note once you actually have it installed.
  const state = updateAvailable
    ? { label: t("mods.vault.state.updateAvailable"), tone: "warn" as const }
    : installed
      ? { label: t(installed.enabled ? "mods.vault.state.enabled" : "mods.vault.state.installed"), tone: "ok" as const }
      : mod.ranked
        ? { label: t("mods.vault.state.ranked"), tone: "ok" as const }
        : { label: t("mods.vault.state.unranked"), tone: "muted" as const };

  return (
    <article className={active ? "mod-vault-card surface-panel active" : "mod-vault-card surface-panel"}>
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
          <small>{mod.author ? t("mods.vault.byAuthor", { author: mod.author }) : t("mods.vault.unknownAuthor")}{mod.version ? ` · v${mod.version}` : ""}</small>
        </span>

        {/* One line instead of a three-column ruled table: the values are a
            number, a count and a date, and the rules cost more attention than
            the facts did. */}
        <span className="mod-vault-card-facts">
          <span className={`mod-vault-type ${mod.modType}`}>{mod.modType === "ui" ? "UI" : "SIM"}</span>
          <span className="mod-vault-fact" title={mod.reviews
            ? t("mods.vault.ratingTooltip", { rating: (mod.ratingTenths / 10).toFixed(1), reviews: mod.reviews })
            : t("mods.vault.noReviews")}>
            <Icon name="star" size={12} />
            {mod.reviews ? t("mods.vault.ratingSummary", { rating: (mod.ratingTenths / 10).toFixed(1), reviews: mod.reviews }) : "N/A"}
          </span>
          <span className="mod-vault-fact" title={t("mods.vault.lastUpdated")}>
            {formatShortDate(mod.updatedAt || mod.createdAt)}
          </span>
        </span>
      </button>

      <div className="mod-vault-card-action">
        <span className={`mod-vault-state is-${state.tone}`}>{state.label}</span>
        {(!installed || updateAvailable) && (
          <Button variant="primary" disabled={busy || !mod.downloadUrl} onClick={onInstall}>
            {t(working ? "mods.vault.busy" : updateAvailable ? "mods.vault.update" : "mods.vault.install")}
          </Button>
        )}
      </div>
    </article>
  );
}

export function ModDetailPanel({
  mod,
  installed,
  busy,
  installing,
  toggling,
  onInstall,
  onToggle,
  onUninstall,
}: {
  mod: VaultMod;
  installed: InstalledMod | undefined;
  busy: boolean;
  installing: boolean;
  toggling: boolean;
  onInstall: () => void;
  onToggle: () => void;
  onUninstall: () => void;
}) {
  const { t } = useTranslation();
  const description = cleanDescription(mod.description);
  const updateAvailable = Boolean(installed && installed.version !== mod.version);
  return (
    <aside className="vault-detail-panel mod-vault-details surface-panel">
      <div className="vault-detail-preview mod-vault-detail-preview">
        <ModPreview mod={mod} large />
      </div>
      <div className="vault-detail-body mod-vault-detail-body">
        <div className="vault-detail-header">
          <div className="vault-detail-kicker mod-vault-detail-kicker">
            <span className={`vault-badge mod-badge mod-badge-${mod.modType}`}>
              {t(mod.modType === "ui" ? "mods.vault.uiMod" : "mods.vault.simMod")}
            </span>
            <span className={`vault-badge is-${mod.ranked ? "ok" : "warn"} ${mod.ranked ? "ranked" : "unranked"}`}>
              {t(mod.ranked ? "mods.vault.state.ranked" : "mods.vault.state.unranked")}
            </span>
            {mod.recommended && <span className="vault-badge is-accent">{t("mods.vault.featured")}</span>}
          </div>
          <h2 className="vault-detail-title">{mod.displayName}</h2>
          <p className="vault-detail-byline mod-vault-byline">
            <span className="vault-detail-author">
              {mod.author ? t("mods.vault.authoredBy", { author: mod.author }) : t("mods.vault.unknownAuthor")}
            </span>
            {mod.uploader ? (
              <>
                <span className="vault-detail-dot">·</span>
                <span className="vault-detail-uploader">
                  {t("mods.vault.uploadedBy", { uploader: mod.uploader })}
                </span>
              </>
            ) : null}
          </p>
        </div>

        <div className="vault-detail-props">
          <div className="vault-prop-row">
            <span className="vault-prop-label">{t("mods.vault.version")}</span>
            <span className="vault-prop-value">{mod.version ? `v${mod.version}` : "N/A"}</span>
          </div>
          <div className="vault-prop-row">
            <span className="vault-prop-label">{t("mods.vault.communityRating")}</span>
            <span className="vault-prop-value">{ratingLabel(mod)}</span>
          </div>
          <div className="vault-prop-row">
            <span className="vault-prop-label">{t("mods.vault.published")}</span>
            <span className="vault-prop-value">{formatShortDate(mod.createdAt)}</span>
          </div>
          <div className="vault-prop-row">
            <span className="vault-prop-label">{t("mods.vault.updated")}</span>
            <span className="vault-prop-value">{formatShortDate(mod.updatedAt || mod.createdAt)}</span>
          </div>
        </div>

        <section className="vault-detail-description mod-vault-description">
          <h3>{t("mods.vault.description")}</h3>
          <p>{description || t("mods.vault.noDescription")}</p>
        </section>

        <div className="vault-detail-actions mod-vault-detail-actions">
          <div className="vault-detail-actions-left">
            <Button onClick={() => void openReviews("mod", mod.modId, mod.displayName)}>
              {t("mods.vault.reviews")}
            </Button>
            {installed && (
              <Button disabled={busy} onClick={onToggle}>
                {t(toggling ? "mods.vault.toggling" : installed.enabled ? "mods.vault.disable" : "mods.vault.enable")}
              </Button>
            )}
          </div>

          <div className="vault-detail-actions-right">
            {updateAvailable ? (
              <Button variant="primary" disabled={busy || !mod.downloadUrl} onClick={onInstall}>
                {t(installing ? "mods.vault.busy" : "mods.vault.installUpdate")}
              </Button>
            ) : installed ? (
              <Button className="mod-vault-uninstall" disabled={busy} onClick={onUninstall}>
                {t("mods.vault.uninstall")}
              </Button>
            ) : (
              <Button variant="primary" disabled={busy || !mod.downloadUrl} onClick={onInstall}>
                {t(installing ? "mods.vault.busy" : "mods.vault.installMod")}
              </Button>
            )}
          </div>
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
    <Modal className="confirm-modal" onClose={onCancel}>
      <div className="confirm-dialog-content">
        <h2>{t("mods.vault.confirmUninstall")}</h2>
        <p>{t("mods.vault.confirmUninstallBody", { name: modName })}</p>
        <div className="confirm-dialog-actions">
          <Button onClick={onCancel}>{t("mods.vault.cancel")}</Button>
          <Button className="btn-danger" onClick={onConfirm}>
            {t("mods.vault.confirmUninstallAction")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

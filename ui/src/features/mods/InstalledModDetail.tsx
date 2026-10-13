// The details of one installed mod, opened from its card in the library.

import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import type { InstalledMod, VaultMod } from "../../ipc/bindings";
import { VaultDescription } from "../../shared/components/VaultDescription";
import { Modal } from "../../design-system/Modal";
import { ModPreview, bestDescription } from "./ModVaultComponents";
import { modUpdateAvailable } from "./modVersions";
import { useTranslation } from "../../i18n/useTranslation";

/// What the vault detail panel shows, for a mod that is on disk.
///
/// Not the vault panel itself: that one is a column beside a result grid and
/// its actions are install/update, which is not what someone browsing their
/// own mods is doing. The content is the same, and the vault link is right
/// here for anything this cannot show (reviews, screenshots, history).
export function InstalledModDetail({
  mod,
  metadata,
  busy,
  toggling,
  onClose,
  onToggle,
  onUpdate,
  onUninstall,
  onOpenInVault,
}: {
  mod: InstalledMod;
  metadata: VaultMod | undefined;
  busy: boolean;
  toggling: boolean;
  onClose: () => void;
  onToggle: () => void;
  /// Present only while the vault has a newer version than this folder.
  onUpdate?: () => void;
  onUninstall: () => void;
  onOpenInVault: () => void;
}) {
  const { t } = useTranslation();
  // The vault copy is the maintained one; `mod_info.lua` is what a mod that
  // was never published, or was taken down, still has.
  const description = bestDescription(metadata?.description, mod.description);
  const updateAvailable = Boolean(metadata && modUpdateAvailable(mod.version, metadata.version));
  return (
    <Modal className="installed-mod-modal" onClose={onClose} ariaLabel={mod.displayName}>
      <div className="installed-mod-detail">
        <div className="installed-mod-detail-preview">
          {metadata ? (
            <ModPreview mod={metadata} large />
          ) : (
            <span className="mod-vault-thumb mod-vault-preview-empty" aria-hidden="true">
              <Icon name="mods" size={40} />
            </span>
          )}
        </div>
        <div className="installed-mod-detail-body">
          <div className="vault-detail-kicker mod-vault-detail-kicker">
            <span className={`vault-badge mod-badge mod-badge-${mod.modType}`}>
              {t(mod.modType === "ui" ? "mods.vault.uiMod" : "mods.vault.simMod")}
            </span>
            <span className={`vault-badge is-${mod.enabled ? "ok" : "neutral"}`}>
              {t(mod.enabled ? "mods.installed.enabled" : "mods.installed.disabled")}
            </span>
            {updateAvailable && (
              <span className="vault-badge is-accent">{t("mods.view.updatesAvailable")}</span>
            )}
          </div>
          <h2 className="vault-detail-title">{mod.displayName}</h2>
          <p className="vault-detail-byline mod-vault-byline">
            {mod.author ? t("mods.vault.authoredBy", { author: mod.author }) : t("mods.vault.unknownAuthor")}
          </p>

          <div className="vault-detail-props">
            <div className="vault-prop-row">
              <span className="vault-prop-label">{t("mods.vault.version")}</span>
              <span className="vault-prop-value">
                {mod.version ? t("common.version", { version: mod.version }) : t("common.notAvailable")}
                {updateAvailable && metadata ? ` → ${t("common.version", { version: metadata.version })}` : ""}
              </span>
            </div>
            <div className="vault-prop-row">
              <span className="vault-prop-label">{t("mods.installed.folder")}</span>
              <span className="vault-prop-value">{mod.folderName}</span>
            </div>
            <div className="vault-prop-row">
              <span className="vault-prop-label">{t("mods.installed.uid")}</span>
              <span className="vault-prop-value installed-mod-uid">{mod.uid}</span>
            </div>
          </div>

          <VaultDescription
            className="mod-vault-description"
            title={t("mods.vault.description")}
            description={description}
            empty={t("mods.vault.noDescription")}
          />

          <div className="vault-detail-actions mod-vault-detail-actions">
            <div className="vault-detail-actions-left">
              {updateAvailable && onUpdate && (
                <Button variant="primary" disabled={busy || !metadata?.downloadUrl} onClick={onUpdate}>
                  {t("mods.vault.installUpdate")}
                </Button>
              )}
              <Button disabled={busy} onClick={onToggle}>
                {t(toggling ? "mods.vault.toggling" : mod.enabled ? "mods.vault.disable" : "mods.vault.enable")}
              </Button>
              {metadata && (
                <Button onClick={onOpenInVault}>{t("mods.installed.viewInVault")}</Button>
              )}
            </div>
            <div className="vault-detail-actions-right">
              <Button className="mod-vault-uninstall" disabled={busy} onClick={onUninstall}>
                {t("mods.vault.uninstall")}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}

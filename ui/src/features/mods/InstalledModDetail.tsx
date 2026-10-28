// The details of one installed mod, opened from its card in the library.

import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { native } from "../../ipc/native";
import { FactsStrip } from "../../design-system/FactsStrip";
import type { InstalledMod, VaultMod } from "../../ipc/bindings";
import { formatShortDate } from "../../shared/format/dates";
import { VaultDescription } from "../../shared/components/VaultDescription";
import { Modal } from "../../design-system/Modal";
import { ModIcon, ModPreview, bestDescription } from "./ModVaultComponents";
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
          {metadata ? <ModPreview mod={metadata} large /> : <ModIcon large />}
        </div>
        <div className="installed-mod-detail-body">
          {/* The vault panel's reading order: the name, who made it, what
              kind of mod it is, then its facts on the tinted strip. */}
          <header className="mod-detail-head">
            <h2 className="mod-detail-name">{mod.displayName}</h2>
            <p className="mod-detail-byline">
              {mod.author ? t("mods.vault.authoredBy", { author: mod.author }) : t("mods.vault.unknownAuthor")}
            </p>
            <div className="mod-detail-tags">
              <span className={`mod-vault-type ${mod.modType}`}>
                {t(mod.modType === "ui" ? "mods.vault.uiMod" : "mods.vault.simMod")}
              </span>
              {mod.enabled && (
                <span className="mod-vault-type in-use" title={t("mods.vault.inUseHint")}>
                  {t("mods.vault.inUse")}
                </span>
              )}
              {updateAvailable && (
                <span className="mod-vault-type featured">{t("mods.view.updatesAvailable")}</span>
              )}
            </div>
          </header>

          <FactsStrip
            columns={2}
            groups={[{
              facts: [
                {
                  label: t("mods.vault.version"),
                  value: mod.version
                    ? `${t("common.version", { version: mod.version })}${updateAvailable && metadata ? ` → ${t("common.version", { version: metadata.version })}` : ""}`
                    : t("common.notAvailable"),
                  unknown: !mod.version,
                },
                {
                  label: t("mods.installed.stateLabel"),
                  value: t(mod.enabled ? "mods.installed.enabled" : "mods.installed.disabled"),
                },
                ...(metadata
                  ? [
                    {
                      label: t("mods.vault.reviews"),
                      value: metadata.reviews > 0
                        ? t("mods.vault.ratingSummary", { rating: (metadata.ratingTenths / 10).toFixed(1), reviews: metadata.reviews })
                        : t("mods.vault.notRated"),
                      unknown: metadata.reviews === 0,
                    },
                    { label: t("mods.vault.updated"), value: formatShortDate(metadata.updatedAt || metadata.createdAt) },
                  ]
                  : []),
              ],
            }]}
          />

          {/* Where it is on disk, for whoever has to find it there: long
              values, so a line each rather than a cell of the strip. */}
          <dl className="installed-mod-location">
            <div>
              <dt>{t("mods.installed.folder")}</dt>
              <dd>{mod.folderName}</dd>
            </div>
            <div>
              <dt>{t("mods.installed.uid")}</dt>
              <dd className="installed-mod-uid">{mod.uid}</dd>
            </div>
          </dl>

          <VaultDescription
            className="mod-vault-description"
            title={t("mods.vault.description")}
            description={description}
            empty={t("mods.vault.noDescription")}
          />

          {/* As in the vault panel: one action to a line, and the one the
              dialog is for last. */}
          <div className="mod-detail-actions">
            <div className="mod-detail-action-list">
              {metadata && (
                <Button variant="ghost" onClick={onOpenInVault}>
                  <Icon name="globe" size={15} />
                  {t("mods.installed.viewInVault")}
                </Button>
              )}
              {updateAvailable && onUpdate && (
                <Button variant="ghost" disabled={busy} onClick={onToggle}>
                  <Icon name={mod.enabled ? "close" : "check"} size={15} />
                  {t(toggling ? "mods.vault.toggling" : mod.enabled ? "mods.vault.disable" : "mods.vault.enable")}
                </Button>
              )}
              <Button variant="ghost" onClick={() => void native.openInstalledFolder("mods", mod.folderName)}>
                <Icon name="folder" size={15} />
                {t("common.openFolder")}
              </Button>
              <Button variant="ghost" className="mod-detail-uninstall" disabled={busy} onClick={onUninstall}>
                <Icon name="trash" size={15} />
                {t("mods.vault.uninstall")}
              </Button>
            </div>
            {updateAvailable && onUpdate ? (
              <Button variant="primary" disabled={busy || !metadata?.downloadUrl} onClick={onUpdate}>
                <Icon name="download" size={15} />
                {t("mods.vault.installUpdate")}
              </Button>
            ) : (
              <Button variant={mod.enabled ? "ghost" : "primary"} disabled={busy} onClick={onToggle}>
                <Icon name={mod.enabled ? "close" : "check"} size={15} />
                {t(toggling ? "mods.vault.toggling" : mod.enabled ? "mods.vault.disable" : "mods.vault.enable")}
              </Button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

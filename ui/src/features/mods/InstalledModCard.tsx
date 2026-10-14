// One installed mod as a card in the library grid: the preview and the name,
// which open the details, remove in the top right, and the star, the update
// and the switch at the bottom right.

import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import type { InstalledMod, VaultMod } from "../../ipc/bindings";
import { formatShortDate } from "../../shared/format/dates";
import { ModIcon } from "./ModVaultComponents";
import { useTranslation } from "../../i18n/useTranslation";

interface InstalledModCardProps {
  mod: InstalledMod;
  metadata: VaultMod | undefined;
  busy: boolean;
  installing: boolean;
  toggling: boolean;
  favorite: boolean;
  onOpen: () => void;
  onToggle: () => void;
  onToggleFavorite: () => void;
  /// Present only while the vault has a newer version than this folder.
  onUpdate?: () => void;
  onUninstall: () => void;
}

export function InstalledModCard({
  mod,
  metadata,
  busy,
  installing,
  toggling,
  favorite,
  onOpen,
  onToggle,
  onToggleFavorite,
  onUpdate,
  onUninstall,
}: InstalledModCardProps) {
  const { t } = useTranslation();
  return (
    <article className={mod.enabled ? "installed-mod-card surface-panel is-enabled" : "installed-mod-card surface-panel is-disabled"}>
      {/* The description lives in the vault, and looking it up there was the
          only way to read it from this list. The card body is the link: the
          buttons stay outside it so enabling a mod is still one click. */}
      <button
        type="button"
        className="installed-mod-open"
        onClick={onOpen}
        title={t("mods.installed.openDetails")}
      >
        <ModIcon url={metadata?.thumbnailUrl} />
        <span className="installed-mod-copy">
          <span className="installed-mod-name" title={mod.uid}>
            <strong>{mod.displayName}</strong>
          </span>
          <small>
            {t(mod.modType === "ui" ? "mods.vault.uiMod" : "mods.vault.simMod")} · v{mod.version}
            {mod.author ? ` \u00b7 ${mod.author}` : ""}
          </small>
          {/* When the author last published it, from the vault's record of
              the mod. That says more about an installed mod than its uid,
              which stays on the name's tooltip; a mod the vault does not list
              has no date to give, so it keeps the uid line. */}
          {metadata ? (
            <small className="installed-mod-updated">
              {t("mods.vault.lastUpdated")} {formatShortDate(metadata.updatedAt || metadata.createdAt)}
            </small>
          ) : (
            <small title={mod.uid}>{mod.uid}</small>
          )}
        </span>
      </button>
      {/* Remove alone in the top right corner, away from the switches, so it
          is not what a quick click on enable lands on. The star, the update
          when there is one, and the switch together at the bottom right. All
          the same height; the state is the card's green edge and tint, and the
          switch says which way it goes. */}
      <div className="installed-mod-side">
        {/* An icon rather than the word, the way the Maps tab does it.
            "Uninstall" in red was the loudest thing on a row whose subject is
            the mod. */}
        <Button
          className="mod-vault-uninstall is-icon"
          disabled={busy}
          aria-label={t("mods.installed.uninstallNamed", { name: mod.displayName })}
          title={t(installing ? "mods.installed.working" : "mods.installed.uninstall")}
          onClick={onUninstall}
        >
          <Icon name="trash" size={14} />
        </Button>
        <div className="installed-mod-actions">
          {/* The same star as the vault's, on the screen where it pays: these
              are the mods the player already has, and the set they star is the
              one "Enable favourites" turns on before a game. */}
          <button
            type="button"
            className={favorite ? "mod-favorite-button active" : "mod-favorite-button"}
            aria-pressed={favorite}
            aria-label={t(favorite ? "mods.vault.removeFavoriteAria" : "mods.vault.addFavoriteAria", {
              name: mod.displayName,
            })}
            title={t(favorite ? "mods.vault.removeFavorite" : "mods.vault.addFavorite")}
            onClick={onToggleFavorite}
          >
            <Icon name="star" size={15} fill={favorite ? "currentColor" : "none"} />
          </button>
          {onUpdate && metadata && (
            <Button variant="primary" disabled={busy || !metadata.downloadUrl} onClick={onUpdate}>
              {t(installing ? "mods.installed.working" : "mods.vault.update")}
            </Button>
          )}
          <Button disabled={busy} onClick={onToggle}>
            {t(toggling ? "mods.installed.updating" : mod.enabled ? "mods.installed.disable" : "mods.installed.enable")}
          </Button>
        </div>
      </div>
    </article>
  );
}

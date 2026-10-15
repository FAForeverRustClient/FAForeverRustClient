// One installed mod as a card in the library grid, shaped like an installed
// map's: the picture and three lines that open the details, the rating in
// the corner, and the star, the update, enable or disable and remove at the
// foot.

import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import type { InstalledMod, VaultMod } from "../../ipc/bindings";
import { ModIcon, ModRating, ModToggleButton } from "./ModVaultComponents";
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
    <article className={mod.enabled ? "installed-mod-card surface-panel is-enabled" : "installed-mod-card surface-panel"}>
      {/* The description lives in the vault, and looking it up there was the
          only way to read it from this list. The picture and the text open
          the details: the controls stay outside, so switching a mod on is
          still one click. */}
      <button
        type="button"
        className="installed-mod-open"
        onClick={onOpen}
        title={t("mods.installed.openDetails")}
      >
        <ModIcon url={metadata?.thumbnailUrl} />
        {/* The installed map card's three lines: the name, who made it, and
            what kind of mod at which version. */}
        <span className="installed-mod-copy">
          <strong title={mod.uid}>{mod.displayName}</strong>
          <small>{mod.author ? t("mods.vault.byAuthor", { author: mod.author }) : t("mods.vault.unknownAuthor")}</small>
          <small>
            {t(mod.modType === "ui" ? "mods.vault.uiMod" : "mods.vault.simMod")}
            {mod.version ? ` · ${t("common.version", { version: mod.version })}` : ""}
          </small>
        </span>
      </button>
      {/* The rating in the corner, as on an installed map, and the controls
          held to the foot: the star, the update when there is one, enable or
          disable, and remove as an icon. */}
      <div className="installed-mod-side">
        <ModRating mod={metadata} />
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
            <Button
              variant="primary"
              className="installed-mod-update"
              disabled={busy || !metadata.downloadUrl}
              aria-label={`${t("mods.vault.update")}: ${mod.displayName}`}
              title={t(installing ? "mods.installed.working" : "mods.vault.update")}
              onClick={onUpdate}
            >
              <Icon name="download" size={14} />
            </Button>
          )}
          <ModToggleButton mod={mod} enabled={mod.enabled} disabled={busy || toggling} onToggle={onToggle} />
          {/* An icon rather than the word, the way the Maps tab does it.
              "Uninstall" in red was the loudest thing on a row whose subject
              is the mod. */}
          <Button
            className="mod-vault-uninstall is-icon"
            disabled={busy}
            aria-label={t("mods.installed.uninstallNamed", { name: mod.displayName })}
            title={t(installing ? "mods.installed.working" : "mods.installed.uninstall")}
            onClick={onUninstall}
          >
            <Icon name="trash" size={14} />
          </Button>
        </div>
      </div>
    </article>
  );
}

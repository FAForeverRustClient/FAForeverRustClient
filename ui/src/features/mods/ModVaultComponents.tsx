import { useEffect, useState } from "react";

import { ReportDialog } from "../../shared/components/ReportDialog";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { native } from "../../ipc/native";
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
  if (!mod.thumbnailUrl || failed) return <ModIcon large={large} />;
  return <img className={large ? "mod-vault-preview" : "mod-vault-thumb"} src={mod.thumbnailUrl} alt={t("mods.vault.preview", { name: mod.displayName })} loading="lazy" decoding="async" onError={() => setFailed(true)} />;
}

/**
 * A mod's icon: its art in a square frame, or the mods placeholder for the
 * half of the vault that ships none.
 */
const ICON_CLASS = {
  small: "mod-icon",
  large: "mod-icon is-large",
  cover: "mod-icon is-cover",
} as const;

const PLACEHOLDER_CLASS = {
  small: "mod-icon is-placeholder",
  large: "mod-icon is-large is-placeholder",
  cover: "mod-icon is-cover is-placeholder",
} as const;

const PLACEHOLDER_SIZE = { small: 25, large: 34, cover: 40 } as const;

export function ModIcon({
  url,
  large = false,
  cover = false,
}: {
  url?: string | null;
  large?: boolean;
  /** Fill a card's picture rather than sit in a frame of its own. */
  cover?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  const kind = cover ? "cover" : large ? "large" : "small";
  if (url && !failed) {
    return (
      <>
        {/* On a card, the sides of the band are a blurred, dimmed copy of
            the logo, as the training tab frames a square map preview: the
            mod's own colours rather than an empty border. */}
        {cover && <img className="mod-vault-cover-backdrop" src={url} alt="" aria-hidden="true" loading="lazy" decoding="async" />}
        <span className={ICON_CLASS[kind]}>
          <img src={url} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
        </span>
      </>
    );
  }
  return (
    <span className={PLACEHOLDER_CLASS[kind]} aria-hidden="true">
      <Icon name="mods" size={PLACEHOLDER_SIZE[kind]} />
    </span>
  );
}

/**
 * A mod's rating as the Maps tab draws a map's: the star in the reviews'
 * colour, the average, the count. A mod nobody has reviewed keeps the place,
 * as a quiet outlined star and a dash, so every card has its rating at the
 * same spot; one the vault does not list has nothing to rate and shows none.
 */
export function ModRating({ mod }: { mod: Pick<VaultMod, "ratingTenths" | "reviews"> | undefined }) {
  const { t } = useTranslation();
  if (!mod) return null;
  if (mod.reviews <= 0) {
    return (
      <span className="mod-rating is-empty" title={t("mods.vault.noReviews")} aria-label={t("mods.vault.noReviews")}>
        <Icon name="star" size={12} />
        <span>{"\u2013"}</span>
      </span>
    );
  }
  const score = (mod.ratingTenths / 10).toFixed(1);
  const label = t("mods.vault.ratingTooltip", { rating: score, reviews: mod.reviews });
  return (
    <span className="mod-rating" title={label} aria-label={label}>
      <Icon name="star" size={12} fill="currentColor" />
      <span>{score}</span>
      <span className="mod-rating-count">({mod.reviews})</span>
    </span>
  );
}

/**
 * On or off, for a mod that is installed: an ordinary button that says what a
 * press does, the same on a vault card and in the installed list. The card's
 * tint says which state the mod is in.
 */
export function ModToggleButton({
  mod,
  enabled,
  disabled,
  onToggle,
}: {
  mod: { displayName: string };
  enabled: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const label = t(enabled ? "mods.vault.disable" : "mods.vault.enable");
  return (
    <Button
      className="mod-toggle-button"
      disabled={disabled}
      aria-label={`${label}: ${mod.displayName}`}
      onClick={onToggle}
    >
      {label}
    </Button>
  );
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
        {/* The logo whole and square, in the middle of a band of the picture
            backdrop. */}
        <span className="mod-vault-cover">
          <ModIcon url={mod.thumbnailUrl} cover />
          {mod.recommended && <VaultFeaturedBadge />}
        </span>

        {/* The name with its version at the line's end, and who made it under
            them. */}
        <span className="mod-vault-card-copy">
          <span className="mod-vault-name-row">
            <strong className="mod-vault-name" title={mod.displayName}>{mod.displayName}</strong>
            {mod.version && <span className="mod-vault-version">{t("common.version", { version: mod.version })}</span>}
          </span>
          <small className="mod-vault-author">
            {mod.author ? t("mods.vault.byAuthor", { author: mod.author }) : t("mods.vault.unknownAuthor")}
          </small>
        </span>

        {/* Two rows of a fixed height each, so they sit at the same place on
            every card: the tags (what kind of mod, whether a simulation mod
            keeps a game ranked, and whether it is on), then when it was last
            published and the rating at the end. A row that has less to say
            keeps its height rather than pulling the foot up. */}
        <span className="mod-vault-card-facts">
          <span className="mod-vault-tags">
            <span className={`mod-vault-type ${mod.modType}`} title={t(mod.modType === "ui" ? "mods.vault.uiMod" : "mods.vault.simMod")}>
              {t(mod.modType === "ui" ? "mods.vault.typeBadge.ui" : "mods.vault.typeBadge.sim")}
            </span>
            {mod.modType === "sim" && (
              <span className={`mod-vault-type ${mod.ranked ? "ranked" : "unranked"}`}>
                {t(mod.ranked ? "mods.vault.state.ranked" : "mods.vault.state.unranked")}
              </span>
            )}
            {/* Installed says only that the folder is there. Enabled is the
                one that answers "am I playing with this right now". */}
            {installed?.enabled && (
              <span className="mod-vault-type in-use" title={t("mods.vault.inUseHint")}>
                {t("mods.vault.inUse")}
              </span>
            )}
          </span>
          <span className="mod-vault-facts-line">
            <span className="mod-vault-fact is-date" title={t("mods.vault.lastUpdated")}>
              {formatShortDate(mod.updatedAt || mod.createdAt)}
            </span>
            <span className="mod-vault-fact-end">
              <ModRating mod={mod} />
            </span>
          </span>
        </span>
      </button>

      {/* The map card's foot: the star at the start, and at the end the one
          thing to do with the mod: install it, or enable or disable it with
          remove beside it as an icon. "Uninstall" in red words was the
          loudest thing on a card whose subject is the mod. */}
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
                <ModToggleButton mod={mod} enabled={installed.enabled} disabled={busy} onToggle={onToggle} />
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
      {/* The card's picture, larger: the logo square and whole at the full
          height of a band across the panel, its blurred copy at the sides. */}
      <div className="mod-vault-cover mod-detail-preview">
        <ModIcon url={mod.thumbnailUrl} cover />
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
          {/* A line each (issue 635): the author is what the mod's own
              mod_info.lua declares, the uploader the account that published
              it, and the creator search matches either. */}
          <p className="mod-detail-byline">
            <span>{mod.author ? t("mods.vault.authoredBy", { author: mod.author }) : t("mods.vault.unknownAuthor")}</span>
            {mod.uploader && <span>{t("mods.vault.uploadedBy", { uploader: mod.uploader })}</span>}
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
              <Button variant="ghost" onClick={() => void native.openInstalledFolder("mods", installed.folderName)}>
                <Icon name="folder" size={15} />
                {t("common.openFolder")}
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

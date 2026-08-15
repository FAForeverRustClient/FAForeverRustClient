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

export function installNote(status: ModInstallStatus): string | null {
  switch (status.type) {
    case "idle": return null;
    case "installing": return `Working on ${status.payload.uid}…`;
    case "failed": return `Mod operation failed: ${status.payload.reason}`;
  }
}

export function toggleNote(status: ModToggleStatus): string | null {
  switch (status.type) {
    case "idle": return null;
    case "toggling": return `Updating ${status.payload.uid}…`;
    case "failed": return `Mod activation failed: ${status.payload.reason}`;
  }
}

function cleanDescription(value: string): string {
  return value.replace(/^<LOC\s+[^>]+>/i, "").trim();
}

function ratingLabel(mod: VaultMod): string {
  return mod.reviews > 0 ? `${(mod.ratingTenths / 10).toFixed(1)} (${mod.reviews})` : "Not rated";
}

export function ModPreview({ mod, large = false }: { mod: VaultMod; large?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [mod.thumbnailUrl]);
  if (!mod.thumbnailUrl || failed) {
    return <span className={large ? "mod-vault-preview mod-vault-preview-empty" : "mod-vault-thumb mod-vault-preview-empty"} aria-hidden="true"><Icon name="mods" size={large ? 34 : 25} /></span>;
  }
  return <img className={large ? "mod-vault-preview" : "mod-vault-thumb"} src={mod.thumbnailUrl} alt={`${mod.displayName} preview`} loading="lazy" onError={() => setFailed(true)} />;
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
  const updateAvailable = Boolean(installed && installed.version !== mod.version);
  // What the card says about your relationship to the mod, which outranks the
  // ranked-safety note once you actually have it installed.
  const state = updateAvailable
    ? { label: "Update available", tone: "warn" as const }
    : installed
      ? { label: installed.enabled ? "Enabled" : "Installed", tone: "ok" as const }
      : mod.ranked
        ? { label: "Ranked-safe", tone: "ok" as const }
        : { label: "Unranked", tone: "muted" as const };

  return (
    <article className={active ? "mod-vault-card surface-panel active" : "mod-vault-card surface-panel"}>
      <button className="mod-vault-card-main" onClick={onSelect} aria-label={`View ${mod.displayName}`}>
        <span className="mod-vault-image-wrap">
          <ModPreview mod={mod} />
          {/* Only the endorsement rides on the art now. The mod type moved down
              to the facts line, where it sits beside the other things you
              compare between cards rather than covering the logo. */}
          {mod.recommended && <VaultFeaturedBadge />}
        </span>

        <span className="mod-vault-card-copy">
          <strong title={mod.displayName}>{mod.displayName}</strong>
          <small>{mod.author ? `by ${mod.author}` : "Unknown author"}{mod.version ? ` · v${mod.version}` : ""}</small>
        </span>

        {/* One line instead of a three-column ruled table: the values are a
            number, a count and a date, and the rules cost more attention than
            the facts did. */}
        <span className="mod-vault-card-facts">
          <span className={`mod-vault-type ${mod.modType}`}>{mod.modType === "ui" ? "UI" : "SIM"}</span>
          <span className="mod-vault-fact" title={mod.reviews ? `${(mod.ratingTenths / 10).toFixed(1)} out of 5 from ${mod.reviews} reviews` : "No reviews yet"}>
            <Icon name="star" size={12} />
            {mod.reviews ? `${(mod.ratingTenths / 10).toFixed(1)} (${mod.reviews})` : "N/A"}
          </span>
          <span className="mod-vault-fact" title="Last updated">
            {formatShortDate(mod.updatedAt || mod.createdAt)}
          </span>
        </span>
      </button>

      <div className="mod-vault-card-action">
        <span className={`mod-vault-state is-${state.tone}`}>{state.label}</span>
        {(!installed || updateAvailable) && (
          <Button variant="primary" disabled={busy || !mod.downloadUrl} onClick={onInstall}>
            {working ? "Working…" : updateAvailable ? "Update" : "Install"}
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
  const description = cleanDescription(mod.description);
  const updateAvailable = Boolean(installed && installed.version !== mod.version);
  return (
    <aside className="mod-vault-details surface-panel">
      <div className="mod-vault-detail-preview"><ModPreview mod={mod} large /></div>
      <div className="mod-vault-detail-body">
        <div className="mod-vault-detail-kicker"><span className={mod.modType}>{mod.modType === "ui" ? "UI mod" : "Simulation mod"}</span><span className={mod.ranked ? "ranked" : "unranked"}>{mod.ranked ? "Ranked-safe" : "Unranked"}</span>{mod.recommended && <span>Featured</span>}</div>
        <h2>{mod.displayName}</h2>
        <p className="mod-vault-byline">{mod.author ? `Authored by ${mod.author}` : "Unknown author"}{mod.uploader ? ` · Uploaded by ${mod.uploader}` : ""}</p>

        <dl className="mod-vault-summary">
          <div><dt>Version</dt><dd>{mod.version || "N/A"}</dd></div>
          <div><dt>Community rating</dt><dd>{ratingLabel(mod)}</dd></div>
          <div><dt>Published</dt><dd>{formatShortDate(mod.createdAt)}</dd></div>
          <div><dt>Updated</dt><dd>{formatShortDate(mod.updatedAt || mod.createdAt)}</dd></div>
          <div><dt>Mod ID</dt><dd>{mod.modId ? `#${mod.modId}` : "N/A"}</dd></div>
          <div><dt>Version ID</dt><dd>{mod.versionId ? `#${mod.versionId}` : "N/A"}</dd></div>
          <div><dt>UID</dt><dd title={mod.uid}>{mod.uid || "N/A"}</dd></div>
          <div><dt>Filename</dt><dd title={mod.filename}>{mod.filename || "N/A"}</dd></div>
        </dl>

        <section className="mod-vault-description"><h3>Description</h3><p>{description || "No description is available for this version."}</p></section>

        <div className="mod-vault-detail-actions">
          <Button onClick={() => void openReviews("mod", mod.modId, mod.displayName)}>Reviews</Button>
          {installed && <Button disabled={busy} onClick={onToggle}>{toggling ? "Updating…" : installed.enabled ? "Disable" : "Enable"}</Button>}
          {installed && <Button className="mod-vault-uninstall" disabled={busy} onClick={onUninstall}>Uninstall</Button>}
          <Button variant="primary" disabled={busy || Boolean(installed && !updateAvailable) || !mod.downloadUrl} onClick={onInstall}>{installing ? "Working…" : updateAvailable ? "Install update" : installed ? "Installed" : "Install mod"}</Button>
        </div>
      </div>
    </aside>
  );
}

export function UninstallDialog({ modName, onCancel, onConfirm }: { modName: string; onCancel: () => void; onConfirm: () => void }) {
  return <Modal onClose={onCancel}><div className="mod-uninstall-dialog"><h2>Uninstall mod?</h2><p>“{modName}” will be permanently removed and deactivated in Forged Alliance.</p><div><Button onClick={onCancel}>Cancel</Button><Button className="mod-vault-uninstall-confirm" onClick={onConfirm}>Uninstall mod</Button></div></div></Modal>;
}

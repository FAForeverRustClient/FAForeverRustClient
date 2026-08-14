import { useEffect, useMemo, useState } from "react";
import { Button } from "../../design-system/Button";
import { openUpload } from "../uploads/UploadDialog";
import { Icon } from "../../design-system/Icon";
import type { InstalledMod, VaultMod } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { loadStatusNote } from "../../shared/loadStatusNote";
import { useAppStore } from "../../store/store";
import { ModPreview, UninstallDialog } from "./ModVaultComponents";

type ModTypeFilter = "all" | "ui" | "sim";
type EnabledFilter = "all" | "enabled" | "disabled";

const loadVault = () => ipc.send({ kind: "Mods", command: { type: "loadVault" } });
const loadInstalled = () => ipc.send({ kind: "Mods", command: { type: "loadInstalled" } });
const uninstallMod = (folderName: string, uid: string) =>
  ipc.send({
    kind: "Mods",
    command: { type: "uninstallMod", payload: { folderName, uid } },
  });
const toggleMod = (uid: string, enabled: boolean) =>
  ipc.send({ kind: "Mods", command: { type: "toggleMod", payload: { uid, enabled } } });

interface InstalledModCardProps {
  mod: InstalledMod;
  metadata: VaultMod | undefined;
  busy: boolean;
  installing: boolean;
  toggling: boolean;
  onToggle: () => void;
  onUninstall: () => void;
}

function InstalledModCard({
  mod,
  metadata,
  busy,
  installing,
  toggling,
  onToggle,
  onUninstall,
}: InstalledModCardProps) {
  return (
    <article className={mod.enabled ? "installed-mod-card surface-panel is-enabled" : "installed-mod-card surface-panel"}>
      {metadata ? (
        <ModPreview mod={metadata} />
      ) : (
        <span className="mod-vault-thumb mod-vault-preview-empty" aria-hidden="true">
          <Icon name="mods" size={25} />
        </span>
      )}
      <span className="installed-mod-copy">
        <span>
          <strong>{mod.displayName}</strong>
          <i className={`mod-state-dot ${mod.enabled ? "is-enabled" : "is-disabled"}`}>
            {mod.enabled ? "Enabled" : "Disabled"}
          </i>
        </span>
        <small>
          {mod.modType === "ui" ? "UI mod" : "Simulation mod"} · v{mod.version}
          {mod.author ? ` · ${mod.author}` : ""}
        </small>
        <small title={mod.uid}>{mod.uid}</small>
      </span>
      <div className="installed-mod-actions">
        <Button disabled={busy} onClick={onToggle}>
          {toggling ? "Updating…" : mod.enabled ? "Disable" : "Enable"}
        </Button>
        <Button
          disabled={busy}
          onClick={() => openUpload("mod", mod.folderName, mod.displayName)}
        >
          Publish
        </Button>
        <Button className="mod-vault-uninstall" disabled={busy} onClick={onUninstall}>
          {installing ? "Working…" : "Uninstall"}
        </Button>
      </div>
    </article>
  );
}

export function InstalledModsView({ busy }: { busy: boolean }) {
  const installed = useAppStore((state) => state.state.mods.installed);
  const installedStatus = useAppStore((state) => state.state.mods.installedStatus);
  const vault = useAppStore((state) => state.state.mods.vault);
  const installStatus = useAppStore((state) => state.state.mods.installStatus);
  const toggleStatus = useAppStore((state) => state.state.mods.toggleStatus);
  const [search, setSearch] = useState("");
  const [modType, setModType] = useState<ModTypeFilter>("all");
  const [enabled, setEnabled] = useState<EnabledFilter>("all");
  const [pendingUninstall, setPendingUninstall] = useState<InstalledMod | null>(null);
  const note = loadStatusNote(installedStatus, "Scanning mods folder…", "Could not scan mods folder");
  const vaultByUid = useMemo(() => new Map(vault.map((mod) => [mod.uid, mod])), [vault]);
  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return installed
      .filter((mod) => modType === "all" || mod.modType === modType)
      .filter((mod) => enabled === "all" || mod.enabled === (enabled === "enabled"))
      .filter(
        (mod) =>
          !query ||
          [mod.displayName, mod.author, mod.description, mod.uid, mod.folderName].some((value) =>
            value.toLocaleLowerCase().includes(query),
          ),
      )
      .slice()
      .sort(
        (left, right) =>
          Number(right.enabled) - Number(left.enabled) || left.displayName.localeCompare(right.displayName),
      );
  }, [enabled, installed, modType, search]);

  useEffect(() => {
    const mods = useAppStore.getState().state.mods;
    if (mods.installedStatus.type === "idle") loadInstalled();
    if (mods.vaultStatus.type === "idle") loadVault();
  }, []);

  return (
    <>
      <div className="vault-toolbar mod-vault-toolbar">
        <label className="search-field vault-search-field">
          <Icon name="search" size={15} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search installed mods"
          />
        </label>
        <select
          value={modType}
          onChange={(event) => setModType(event.target.value as ModTypeFilter)}
          aria-label="Filter installed mod type"
        >
          <option value="all">All types</option>
          <option value="ui">UI mods</option>
          <option value="sim">Simulation mods</option>
        </select>
        <select
          value={enabled}
          onChange={(event) => setEnabled(event.target.value as EnabledFilter)}
          aria-label="Filter activation state"
        >
          <option value="all">Any state</option>
          <option value="enabled">Enabled</option>
          <option value="disabled">Disabled</option>
        </select>
        <Button onClick={loadInstalled} disabled={installedStatus.type === "loading"}>
          <Icon name="refresh" size={15} /> Rescan
        </Button>
      </div>

      {note && <p className="vault-note muted">{note}</p>}
      {installedStatus.type === "ready" && filtered.length === 0 ? (
        <div className="vault-empty">
          <Icon name={installed.length === 0 ? "mods" : "search"} size={24} />
          <h3>{installed.length === 0 ? "No mods installed" : "No installed mods match"}</h3>
          <p>
            {installed.length === 0
              ? "Install a mod from the vault to see it here."
              : "Try a broader search or different filters."}
          </p>
        </div>
      ) : filtered.length > 0 ? (
        <section className="installed-mod-library">
          <div className="vault-results-head">
            <span>{filtered.length} installed {filtered.length === 1 ? "mod" : "mods"}</span>
            <span>{installed.filter((mod) => mod.enabled).length} active</span>
          </div>
          <div className="installed-mod-grid">
            {filtered.map((mod) => (
              <InstalledModCard
                key={mod.folderName}
                mod={mod}
                metadata={vaultByUid.get(mod.uid)}
                busy={busy}
                installing={installStatus.type === "installing" && installStatus.payload.uid === mod.uid}
                toggling={toggleStatus.type === "toggling" && toggleStatus.payload.uid === mod.uid}
                onToggle={() => toggleMod(mod.uid, !mod.enabled)}
                onUninstall={() => setPendingUninstall(mod)}
              />
            ))}
          </div>
        </section>
      ) : null}

      {pendingUninstall && (
        <UninstallDialog
          modName={pendingUninstall.displayName}
          onCancel={() => setPendingUninstall(null)}
          onConfirm={() => {
            uninstallMod(pendingUninstall.folderName, pendingUninstall.uid);
            setPendingUninstall(null);
          }}
        />
      )}
    </>
  );
}

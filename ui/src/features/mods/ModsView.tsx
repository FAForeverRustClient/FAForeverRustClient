// Mods tab — two sub-views mirroring the Python client's `ModVault` +
// mod manager: Vault (the FAF mod vault, browse + install) and Installed
// (a scan of the user's mods folder, with enable/disable + uninstall).
// The sub-view choice is presentation-only, so it's local component state,
// not routed through the backend Nav slice (same posture as MapsView.tsx).

import { useEffect, useState } from "react";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { Button } from "../../design-system/Button";
import type { InstalledMod, ModInstallStatus, ModListStatus, ModToggleStatus, VaultMod } from "../../ipc/bindings";

type SubView = "vault" | "installed";

const loadVault = () => ipc.dispatch({ kind: "Mods", command: { type: "loadVault" } });

const loadInstalled = () => ipc.dispatch({ kind: "Mods", command: { type: "loadInstalled" } });

const installMod = (uid: string, downloadUrl: string) =>
  ipc.dispatch({
    kind: "Mods",
    command: { type: "installMod", payload: { uid, downloadUrl } },
  });

const uninstallMod = (folderName: string) =>
  ipc.dispatch({
    kind: "Mods",
    command: { type: "uninstallMod", payload: { folderName } },
  });

const toggleMod = (uid: string, enabled: boolean) =>
  ipc.dispatch({
    kind: "Mods",
    command: { type: "toggleMod", payload: { uid, enabled } },
  });

function installNote(status: ModInstallStatus): string | null {
  switch (status.type) {
    case "idle":
      return null;
    case "installing":
      return `Working on ${status.payload.uid}…`;
    case "failed":
      return `Failed: ${status.payload.reason}`;
  }
}

function toggleNote(status: ModToggleStatus): string | null {
  switch (status.type) {
    case "idle":
      return null;
    case "toggling":
      return `Updating ${status.payload.uid}…`;
    case "failed":
      return `Failed: ${status.payload.reason}`;
  }
}

function loadNote(status: ModListStatus, loadingLabel: string, failedPrefix: string): string | null {
  switch (status.type) {
    case "idle":
    case "ready":
      return null;
    case "loading":
      return loadingLabel;
    case "failed":
      return `${failedPrefix}: ${status.payload.reason}`;
  }
}

function ModTypeBadge({ modType }: { modType: "ui" | "sim" }) {
  return <span className="muted"> · {modType === "ui" ? "UI mod" : "Sim mod"}</span>;
}

function VaultView({ busy }: { busy: boolean }) {
  const vault = useAppStore((s) => s.state.mods.vault);
  const vaultStatus = useAppStore((s) => s.state.mods.vaultStatus);
  const installed = useAppStore((s) => s.state.mods.installed);
  const installStatus = useAppStore((s) => s.state.mods.installStatus);
  const note = loadNote(vaultStatus, "Loading mod vault…", "Could not load mod vault");
  const installedUids = new Set(installed.map((m) => m.uid));

  useEffect(() => {
    if (useAppStore.getState().state.mods.vaultStatus.type === "idle") {
      loadVault();
    }
  }, []);

  return (
    <>
      {note && <p className="muted">{note}</p>}
      {vaultStatus.type === "ready" && vault.length === 0 && (
        <p className="muted">No mods found.</p>
      )}
      {vault.length > 0 && (
        <ul className="game-list">
          {vault.map((m: VaultMod) => {
            const isInstalled = installedUids.has(m.uid);
            const isBusy =
              busy || (installStatus.type === "installing" && installStatus.payload.uid === m.uid);
            return (
              <li key={m.uid} className="game-row">
                <span className="game-title">
                  {m.displayName}
                  <ModTypeBadge modType={m.modType} />
                </span>
                <span className="game-map muted">v{m.version}</span>
                <span className="game-host muted">
                  {m.author ? `by ${m.author}` : "unknown author"}
                  {!m.ranked && " · unranked"}
                </span>
                <Button
                  variant="primary"
                  disabled={isBusy || isInstalled || !m.downloadUrl}
                  onClick={() => installMod(m.uid, m.downloadUrl)}
                >
                  {isInstalled ? "Installed" : "Install"}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function InstalledView({ busy }: { busy: boolean }) {
  const installed = useAppStore((s) => s.state.mods.installed);
  const installedStatus = useAppStore((s) => s.state.mods.installedStatus);
  const installStatus = useAppStore((s) => s.state.mods.installStatus);
  const toggleStatus = useAppStore((s) => s.state.mods.toggleStatus);
  const note = loadNote(installedStatus, "Scanning mods folder…", "Could not scan mods folder");

  useEffect(() => {
    if (useAppStore.getState().state.mods.installedStatus.type === "idle") {
      loadInstalled();
    }
  }, []);

  return (
    <>
      {note && <p className="muted">{note}</p>}
      {installedStatus.type === "ready" && installed.length === 0 && (
        <p className="muted">No mods installed.</p>
      )}
      {installed.length > 0 && (
        <ul className="game-list">
          {installed.map((m: InstalledMod) => {
            const isBusy =
              busy ||
              (installStatus.type === "installing" && installStatus.payload.uid === m.uid) ||
              (toggleStatus.type === "toggling" && toggleStatus.payload.uid === m.uid);
            return (
              <li key={m.folderName} className="game-row">
                <span className="game-title">
                  {m.displayName}
                  <ModTypeBadge modType={m.modType} />
                </span>
                <span className="game-map muted">v{m.version}</span>
                <span className="game-host muted">{m.enabled ? "enabled" : "disabled"}</span>
                <Button variant="ghost" disabled={isBusy} onClick={() => toggleMod(m.uid, !m.enabled)}>
                  {m.enabled ? "Disable" : "Enable"}
                </Button>
                <Button variant="ghost" disabled={isBusy} onClick={() => uninstallMod(m.folderName)}>
                  Uninstall
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

const SUB_VIEWS: Record<SubView, { label: string; Component: (p: { busy: boolean }) => JSX.Element }> = {
  vault: { label: "Vault", Component: VaultView },
  installed: { label: "Installed", Component: InstalledView },
};

export function ModsView() {
  const [subView, setSubView] = useState<SubView>("vault");
  const installStatus = useAppStore((s) => s.state.mods.installStatus);
  const toggleStatus = useAppStore((s) => s.state.mods.toggleStatus);
  const note = installNote(installStatus) ?? toggleNote(toggleStatus);
  const busy = installStatus.type === "installing" || toggleStatus.type === "toggling";
  const { Component } = SUB_VIEWS[subView];

  return (
    <div className="lobby">
      <div className="lobby-head">
        <h2>Mods</h2>
        {note && <span className="join-note muted">{note}</span>}
      </div>

      <div className="lobby-head">
        {(Object.keys(SUB_VIEWS) as SubView[]).map((key) => (
          <Button
            key={key}
            variant={subView === key ? "primary" : "ghost"}
            onClick={() => setSubView(key)}
          >
            {SUB_VIEWS[key].label}
          </Button>
        ))}
      </div>

      <Component busy={busy} />
    </div>
  );
}

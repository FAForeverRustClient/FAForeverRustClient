// Maps tab — two sub-views mirroring the Python client's `MapVault` +
// `MapsManagerDialog`: Vault (the FAF map vault, browse + install) and
// Installed (a scan of the user's maps folder, with an uninstall action).
// The sub-view choice is presentation-only, so it's local component state,
// not routed through the backend Nav slice (same posture as ReplaysView.tsx).

import { useEffect, useState } from "react";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { Button } from "../../design-system/Button";
import type { InstalledMap, MapInstallStatus, MapListStatus, VaultMap } from "../../ipc/bindings";

type SubView = "vault" | "installed";

const loadVault = () => ipc.dispatch({ kind: "Maps", command: { type: "loadVault" } });

const loadInstalled = () => ipc.dispatch({ kind: "Maps", command: { type: "loadInstalled" } });

const installMap = (folderName: string, downloadUrl: string) =>
  ipc.dispatch({
    kind: "Maps",
    command: { type: "installMap", payload: { folderName, downloadUrl } },
  });

const uninstallMap = (folderName: string) =>
  ipc.dispatch({
    kind: "Maps",
    command: { type: "uninstallMap", payload: { folderName } },
  });

function installNote(status: MapInstallStatus): string | null {
  switch (status.type) {
    case "idle":
      return null;
    case "installing":
      return `Working on ${status.payload.folderName}…`;
    case "failed":
      return `Failed: ${status.payload.reason}`;
  }
}

function loadNote(status: MapListStatus, loadingLabel: string, failedPrefix: string): string | null {
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

function sizeLabel(map: VaultMap): string {
  return `${(map.width / 51.2).toFixed(0)} x ${(map.height / 51.2).toFixed(0)} km`;
}

function VaultView({ busy }: { busy: boolean }) {
  const vault = useAppStore((s) => s.state.maps.vault);
  const vaultStatus = useAppStore((s) => s.state.maps.vaultStatus);
  const installed = useAppStore((s) => s.state.maps.installed);
  const installStatus = useAppStore((s) => s.state.maps.installStatus);
  const note = loadNote(vaultStatus, "Loading map vault…", "Could not load map vault");
  const installedFolders = new Set(installed.map((m) => m.folderName));

  useEffect(() => {
    if (useAppStore.getState().state.maps.vaultStatus.type === "idle") {
      loadVault();
    }
  }, []);

  return (
    <>
      {note && <p className="muted">{note}</p>}
      {vaultStatus.type === "ready" && vault.length === 0 && (
        <p className="muted">No maps found.</p>
      )}
      {vault.length > 0 && (
        <ul className="game-list">
          {vault.map((m) => {
            const isInstalled = installedFolders.has(m.folderName);
            const isBusy =
              busy ||
              (installStatus.type === "installing" && installStatus.payload.folderName === m.folderName);
            return (
              <li key={m.folderName} className="game-row">
                <span className="game-title">{m.displayName}</span>
                <span className="game-map muted">{sizeLabel(m)}</span>
                <span className="game-host muted">
                  {m.author ? `by ${m.author}` : "unknown author"}
                  {!m.ranked && " · unranked"}
                </span>
                <span className="game-players">{m.maxPlayers} players</span>
                <Button
                  variant="primary"
                  disabled={isBusy || isInstalled || !m.downloadUrl}
                  onClick={() => installMap(m.folderName, m.downloadUrl)}
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
  const installed = useAppStore((s) => s.state.maps.installed);
  const installedStatus = useAppStore((s) => s.state.maps.installedStatus);
  const installStatus = useAppStore((s) => s.state.maps.installStatus);
  const note = loadNote(installedStatus, "Scanning maps folder…", "Could not scan maps folder");

  useEffect(() => {
    if (useAppStore.getState().state.maps.installedStatus.type === "idle") {
      loadInstalled();
    }
  }, []);

  return (
    <>
      {note && <p className="muted">{note}</p>}
      {installedStatus.type === "ready" && installed.length === 0 && (
        <p className="muted">No maps installed.</p>
      )}
      {installed.length > 0 && (
        <ul className="game-list">
          {installed.map((m: InstalledMap) => {
            const isBusy =
              busy ||
              (installStatus.type === "installing" && installStatus.payload.folderName === m.folderName);
            return (
              <li key={m.folderName} className="game-row">
                <span className="game-title">{m.displayName}</span>
                <span className="game-map muted">{m.folderName}</span>
                <Button variant="ghost" disabled={isBusy} onClick={() => uninstallMap(m.folderName)}>
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

export function MapsView() {
  const [subView, setSubView] = useState<SubView>("vault");
  const installStatus = useAppStore((s) => s.state.maps.installStatus);
  const note = installNote(installStatus);
  const busy = installStatus.type === "installing";
  const { Component } = SUB_VIEWS[subView];

  return (
    <div className="lobby">
      <div className="lobby-head">
        <h2>Maps</h2>
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

// Missing-install banner: slides in at the top of the workspace when the
// client cannot find Forged Alliance.
//
// Both reference clients refuse to get this far without a known install (the
// Python client's `validate_game_path`, the Java client's first-run wizard).
// This client is usable without one: chat, the vault, the leaderboard and the
// map/mod browsers are all pure API features: so instead of blocking startup
// it says what is missing and offers the one-click fix.
//
// The state is derived, not configured: the backend stats the paths on startup
// and after every change (see `faf-domain`'s install slice), so the banner also
// catches an install that was moved or uninstalled since it was configured.

import { useState } from "react";
import { ipc } from "../../ipc/client";
import { native } from "../../ipc/native";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { useAppStore } from "../../store/store";

const openSettings = () =>
  ipc.send({ kind: "Nav", command: { type: "select", payload: { tab: "settings" } } });

const checkAgain = () =>
  ipc.send({ kind: "Settings", command: { type: "checkInstalls" } });

/** Set both installs at once: the common case is one FA folder for both. */
async function pickInstall() {
  const path = await native.selectFile({
    title: "Select FAF-managed ForgedAlliance.exe",
    filters: [{ name: "ForgedAlliance.exe", extensions: ["exe"] }],
  });
  if (!path) return;
  await ipc.settle({ kind: "Settings", command: { type: "setGamePath", payload: { path } } });
  await ipc.dispatch({
    kind: "Settings",
    command: { type: "setReplayGamePath", payload: { path } },
  });
}

export function InstallBanner() {
  const install = useAppStore((s) => s.state.install);
  const [dismissed, setDismissed] = useState(false);

  // `checked` guards the startup window: before the first stat completes we
  // know nothing, and flashing a warning at every launch would train the user
  // to ignore it.
  const missing = install.checked && !install.gameReady;
  if (!missing || dismissed) return null;

  // Replays can play from a separate install, so a half-configured client gets
  // a narrower message than a completely unconfigured one.
  const replayOnly = install.replayReady;

  return (
    <div className="install-banner" role="status">
      <span className="install-banner-icon" aria-hidden="true">
        <Icon name="lock" size={16} />
      </span>
      <div className="install-banner-copy">
        <strong>
          {replayOnly
            ? "No game install configured"
            : "Forged Alliance install not found"}
        </strong>
        <span className="muted">
          {replayOnly
            ? "Replays can play, but joining and hosting games needs the game install."
            : "Chat, the vault and the leaderboard work without it: playing and watching replays do not."}
        </span>
      </div>
      <div className="install-banner-actions">
        <Button variant="primary" onClick={() => void pickInstall()}>
          Locate FAF executable
        </Button>
        <Button onClick={() => void openSettings()}>Settings</Button>
        <Button onClick={() => void checkAgain()} title="Re-check the configured paths">
          Check again
        </Button>
        <button
          type="button"
          className="install-banner-close"
          aria-label="Dismiss"
          title="Dismiss until the next launch"
          onClick={() => setDismissed(true)}
        >
          <Icon name="close" size={14} />
        </button>
      </div>
    </div>
  );
}

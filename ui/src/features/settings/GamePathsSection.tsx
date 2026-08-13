// Settings → Paths section. Lets a non-developer point the client at their
// FA installs without exporting FAF_GAME_PATH/FAF_REPLAY_GAME_PATH by hand —
// previously the only way to configure them at all. Two independent paths
// by design (see faf-domain's settings module docs): live games and replay
// playback can run different FA builds/versions.

import { open } from "@tauri-apps/plugin-dialog";
import { ipc } from "../../ipc/client";
import { Button } from "../../design-system/Button";
import { useAppStore } from "../../store/store";

async function pickExe(onPicked: (path: string) => void) {
  const path = await open({
    multiple: false,
    filters: [{ name: "ForgedAlliance.exe", extensions: ["exe"] }],
  });
  if (typeof path === "string") {
    onPicked(path);
  }
}

const setGamePath = (path: string) =>
  ipc.dispatch({ kind: "Settings", command: { type: "setGamePath", payload: { path } } });

const setReplayGamePath = (path: string) =>
  ipc.dispatch({ kind: "Settings", command: { type: "setReplayGamePath", payload: { path } } });

function PathRow({
  label,
  hint,
  path,
  onPick,
}: {
  label: string;
  hint: string;
  path: string;
  onPick: () => void;
}) {
  return (
    <div className="settings-path-row">
      <div className="settings-path-info">
        <span className="settings-path-label">{label}</span>
        <span className="muted">{hint}</span>
        <span className="settings-path-value">{path || "Not set"}</span>
      </div>
      <Button onClick={onPick}>Browse…</Button>
    </div>
  );
}

export function GamePathsSection() {
  const gamePath = useAppStore((s) => s.state.settings.gamePath);
  const replayGamePath = useAppStore((s) => s.state.settings.replayGamePath);

  return (
    <div>
      <PathRow
        label="Game install"
        hint="ForgedAlliance.exe used to join and play live games."
        path={gamePath}
        onPick={() => pickExe(setGamePath)}
      />
      <PathRow
        label="Replay install"
        hint="ForgedAlliance.exe used for replay playback — can be a different build/version than the game install."
        path={replayGamePath}
        onPick={() => pickExe(setReplayGamePath)}
      />
      <p className="muted">Changes here take effect after restarting the client.</p>
    </div>
  );
}

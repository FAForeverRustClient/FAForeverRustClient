// Settings → Paths section. Lets a non-developer point the client at their
// FA installs without exporting FAF_GAME_PATH/FAF_REPLAY_GAME_PATH by hand,
// previously the only way to configure them at all. Two independent paths
// by design (see faf-domain's settings module docs): live games and replay
// playback can run different FA builds/versions.

import { ipc } from "../../ipc/client";
import { native } from "../../ipc/native";
import { Button } from "../../design-system/Button";
import { useAppStore } from "../../store/store";
import { useTranslation } from "../../i18n/useTranslation";

function pickExe(onPicked: (path: string) => void): void {
  ipc.run(native.selectFile({
    filters: [{ name: "ForgedAlliance.exe", extensions: ["exe"] }],
  }).then((path) => {
    if (path) onPicked(path);
  }));
}

const setGamePath = (path: string) =>
  ipc.send({ kind: "Settings", command: { type: "setGamePath", payload: { path } } });

const setReplayGamePath = (path: string) =>
  ipc.send({ kind: "Settings", command: { type: "setReplayGamePath", payload: { path } } });

function PathRow({
  label,
  hint,
  path,
  ready,
  onPick,
}: {
  label: string;
  hint: string;
  path: string;
  /** Whether the configured executable actually exists (checked by the backend). */
  ready: boolean;
  onPick: () => void;
}) {
  const { t } = useTranslation();
  // Three distinct states worth telling apart: unset, set-but-gone, and fine.
  // "Set but gone" is what a user hits after moving or reinstalling the game,
  // and it looks identical to "unset" unless we say so.
  const status = !path ? "unset" : ready ? "ok" : "missing";
  const STATUS_LABEL = {
    unset: t("settings.paths.unset"),
    missing: t("settings.paths.missing"),
    ok: t("settings.paths.ok"),
  } as const;

  return (
    <div className="settings-path-row">
      <div className="settings-path-info">
        <span className="settings-path-label">{label}</span>
        <span className="muted">{hint}</span>
        <span className="settings-path-value">{path || t("settings.paths.unset")}</span>
        <span className={`settings-path-status is-${status}`}>{STATUS_LABEL[status]}</span>
      </div>
      <Button onClick={onPick}>Browse…</Button>
    </div>
  );
}

export function GamePathsSection() {
  const { t } = useTranslation();
  const gamePath = useAppStore((s) => s.state.settings.gamePath);
  const replayGamePath = useAppStore((s) => s.state.settings.replayGamePath);
  const install = useAppStore((s) => s.state.install);

  return (
    <div>
      <PathRow
        label={t("settings.paths.gameInstall")}
        hint={t("settings.paths.gameInstallHint")}
        path={gamePath}
        ready={install.gameReady}
        onPick={() => pickExe(setGamePath)}
      />
      <PathRow
        label={t("settings.paths.replayInstall")}
        hint={t("settings.paths.replayInstallHint")}
        path={replayGamePath}
        ready={install.replayReady}
        onPick={() => pickExe(setReplayGamePath)}
      />
      <p className="muted">
        Changes take effect immediately. When these are unset, an existing FAF-managed install
        from the Java or Python client is reused automatically. The original Steam/retail game is
        kept separate. Browsing the replay and map vaults works without an install; playing and
        watching do not.
      </p>
    </div>
  );
}

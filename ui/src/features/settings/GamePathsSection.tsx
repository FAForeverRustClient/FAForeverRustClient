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
  pending,
  onPick,
}: {
  label: string;
  hint: string;
  path: string;
  /** Whether the configured executable actually exists (checked by the backend). */
  ready: boolean;
  /**
   * Whether the executable is absent but the client will download it there.
   * See the install slice: this is what a machine that has never run FAF looks
   * like, and it stats identically to a path that is simply wrong.
   */
  pending: boolean;
  onPick: () => void;
}) {
  const { t } = useTranslation();
  // Four distinct states worth telling apart: unset, waiting for its first
  // download, set-but-gone, and fine. The middle two look identical on disk and
  // mean opposite things: one needs nothing from the user at all, the other
  // needs a different path.
  const status = !path ? "unset" : ready ? "ok" : pending ? "pending" : "missing";
  const STATUS_LABEL = {
    unset: t("settings.paths.unset"),
    pending: t("settings.paths.pending"),
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
        pending={install.gamePending}
        onPick={() => pickExe(setGamePath)}
      />
      <PathRow
        label={t("settings.paths.replayInstall")}
        hint={t("settings.paths.replayInstallHint")}
        path={replayGamePath}
        ready={install.replayReady}
        pending={install.replayPending}
        onPick={() => pickExe(setReplayGamePath)}
      />
      <p className="muted">{t("settings.paths.installNote")}</p>
    </div>
  );
}

// Settings → Paths section. Lets a non-developer point the client at their
// FA installs without exporting FAF_GAME_PATH/FAF_REPLAY_GAME_PATH by hand,
// previously the only way to configure them at all. Two independent managed
// paths by design (see faf-domain's settings module docs): live games and
// replay playback can run different FA builds/versions. The third path is the
// retail game itself, which is never launched but has to be mounted.

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

/** The base game is a folder, not an executable: it is mounted, never run. */
function pickDirectory(onPicked: (path: string) => void): void {
  ipc.run(native.selectDirectory().then((path) => {
    if (path) onPicked(path);
  }));
}

const setGamePath = (path: string) =>
  ipc.send({ kind: "Settings", command: { type: "setGamePath", payload: { path } } });

const setReplayGamePath = (path: string) =>
  ipc.send({ kind: "Settings", command: { type: "setReplayGamePath", payload: { path } } });

const setRetailGamePath = (path: string) =>
  ipc.send({ kind: "Settings", command: { type: "setRetailGamePath", payload: { path } } });

type PathStatus = "unset" | "missing" | "ok" | "detected";

function PathRow({
  label,
  hint,
  value,
  status,
  onPick,
}: {
  label: string;
  hint: string;
  /** The path this row is actually reporting on; empty renders as "not set". */
  value: string;
  status: PathStatus;
  onPick: () => void;
}) {
  const { t } = useTranslation();
  const STATUS_LABEL = {
    unset: t("settings.paths.unset"),
    missing: t("settings.paths.missing"),
    ok: t("settings.paths.ok"),
    detected: t("settings.paths.detected"),
  } as const;

  return (
    <div className="settings-path-row">
      <div className="settings-path-info">
        <span className="settings-path-label">{label}</span>
        <span className="muted">{hint}</span>
        <span className="settings-path-value">{value || t("settings.paths.unset")}</span>
        <span className={`settings-path-status is-${status}`}>{STATUS_LABEL[status]}</span>
      </div>
      <Button onClick={onPick}>Browse…</Button>
    </div>
  );
}

/**
 * Three distinct states worth telling apart for a managed install: unset,
 * set-but-gone, and fine. "Set but gone" is what a user hits after moving or
 * reinstalling the game, and it looks identical to "unset" unless we say so.
 */
function managedStatus(path: string, ready: boolean): PathStatus {
  if (!path) return "unset";
  return ready ? "ok" : "missing";
}

/** Windows paths differ in case and separator without differing at all. */
function samePath(a: string, b: string): boolean {
  const normalise = (path: string) => path.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
  return normalise(a) === normalise(b);
}

export function GamePathsSection() {
  const { t } = useTranslation();
  const gamePath = useAppStore((s) => s.state.settings.gamePath);
  const replayGamePath = useAppStore((s) => s.state.settings.replayGamePath);
  const retailGamePath = useAppStore((s) => s.state.settings.retailGamePath);
  const install = useAppStore((s) => s.state.install);

  // The retail row reports the folder the launcher will really use, which is
  // usually one nobody configured: the client finds it from the reference
  // clients' settings or the usual retail/Steam locations. So the row shows
  // what was resolved rather than what was typed, and "nothing resolved" is a
  // problem rather than a blank, because every launch fails without it.
  const retailStatus: PathStatus = !install.retailPath
    ? "missing"
    : retailGamePath && samePath(retailGamePath, install.retailPath)
      ? "ok"
      : "detected";

  return (
    <div>
      <PathRow
        label={t("settings.paths.gameInstall")}
        hint={t("settings.paths.gameInstallHint")}
        value={gamePath}
        status={managedStatus(gamePath, install.gameReady)}
        onPick={() => pickExe(setGamePath)}
      />
      <PathRow
        label={t("settings.paths.replayInstall")}
        hint={t("settings.paths.replayInstallHint")}
        value={replayGamePath}
        status={managedStatus(replayGamePath, install.replayReady)}
        onPick={() => pickExe(setReplayGamePath)}
      />
      {/* The base game. Nothing launches it, but every launch depends on it:
          `fa_path.lua` points the engine here so it mounts `gamedata/*.scd`.
          Without it Forged Alliance dies compiling a shader, naming a `.fx`
          file and nothing that would lead anyone back here. */}
      <PathRow
        label={t("settings.paths.retailInstall")}
        hint={t("settings.paths.retailInstallHint")}
        value={install.retailPath || retailGamePath}
        status={retailStatus}
        onPick={() => pickDirectory(setRetailGamePath)}
      />
      <p className="muted">
        Changes take effect immediately. When the two FAF installs are unset, an existing
        FAF-managed install from the Java or Python client is reused automatically. The original
        game is detected the same way and only needs setting when detection fails. Browsing the
        replay and map vaults works without an install; playing and watching do not.
      </p>
    </div>
  );
}

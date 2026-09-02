// Settings → Paths. Every location the client reads or writes, in one place.
//
// Two kinds of row. The executables at the top decide what gets launched and
// have always been settable here. The rest are the content and support
// locations - the vault and its maps and mods, replays, the generator cache,
// FA's own game.prefs, the JVM - which until now could only be moved by
// exporting a `FAF_*` variable before starting the client, which is not a
// thing to ask of anyone.
//
// Every row shows where it currently points even when nobody has set it,
// because that is the common case and "(automatic)" alone answers none of the
// questions people actually have about where their maps went. The backend
// reports those resolved locations; see `ResolvedPaths` in faf-domain.

import { Button } from "../../design-system/Button";
import { ipc } from "../../ipc/client";
import { native } from "../../ipc/native";
import type { MessageKey } from "../../i18n/catalog/en";
import { useTranslation } from "../../i18n/useTranslation";
import type { PathPreferences } from "../../ipc/bindings";
import { useAppStore } from "../../store/store";
import { GamePathsSection } from "./GamePathsSection";

/** The configurable directories, in the order the tab lists them. */
const DIRECTORY_FIELDS = [
  "vaultDir",
  "mapsDir",
  "modsDir",
  "replaysDir",
  "mapGeneratorDir",
] as const;

type DirectoryField = (typeof DIRECTORY_FIELDS)[number];
/** Locations that are a single file rather than a folder. */
type FileField = "gamePrefsPath" | "javaPath";

const LABEL = {
  vaultDir: "settings.paths.vault",
  mapsDir: "settings.paths.maps",
  modsDir: "settings.paths.mods",
  replaysDir: "settings.paths.replays",
  mapGeneratorDir: "settings.paths.mapGenerator",
  gamePrefsPath: "settings.paths.gamePrefs",
  javaPath: "settings.paths.java",
} as const satisfies Record<DirectoryField | FileField, MessageKey>;

const HINT = {
  vaultDir: "settings.paths.vaultHint",
  mapsDir: "settings.paths.mapsHint",
  modsDir: "settings.paths.modsHint",
  replaysDir: "settings.paths.replaysHint",
  mapGeneratorDir: "settings.paths.mapGeneratorHint",
  gamePrefsPath: "settings.paths.gamePrefsHint",
  javaPath: "settings.paths.javaHint",
} as const satisfies Record<DirectoryField | FileField, MessageKey>;

const setPaths = (preferences: PathPreferences) =>
  ipc.send({ kind: "Settings", command: { type: "setPaths", payload: { preferences } } });

function ContentPathRow({
  field,
  paths,
  resolved,
  pick,
}: {
  field: DirectoryField | FileField;
  paths: PathPreferences;
  resolved: string;
  pick: () => Promise<string | null>;
}) {
  const { t } = useTranslation();
  const configured = paths[field];

  const choose = () =>
    ipc.run(
      pick().then((picked) => {
        if (picked) setPaths({ ...paths, [field]: picked });
      }),
    );

  return (
    <div className="settings-path-row">
      <div className="settings-path-info">
        <span className="settings-path-label">{t(LABEL[field])}</span>
        <span className="muted">{t(HINT[field])}</span>
        {/* The resolved location, always. When it was set here it is the same
            string; when it was not, it is the only way to see where the
            fallback landed. */}
        <span className="settings-path-value">{resolved || t("settings.paths.unset")}</span>
        <span className={`settings-path-status is-${configured ? "ok" : "unset"}`}>
          {configured ? t("settings.paths.custom") : t("settings.paths.automatic")}
        </span>
      </div>
      <div className="settings-path-actions">
        <Button onClick={choose}>{t("settings.paths.browse")}</Button>
        <Button
          disabled={!configured}
          onClick={() => setPaths({ ...paths, [field]: "" })}
          title={t("settings.paths.resetHint")}
        >
          {t("settings.paths.reset")}
        </Button>
      </div>
    </div>
  );
}

export function PathsSettingsSection() {
  const { t } = useTranslation();
  const paths = useAppStore((s) => s.state.settings.paths);
  const resolved = useAppStore((s) => s.state.install.resolved);

  return (
    <div>
      {/* The executables first: nothing else here matters if the client
          cannot find a game to launch. */}
      <GamePathsSection />
      {DIRECTORY_FIELDS.map((field) => (
        <ContentPathRow
          key={field}
          field={field}
          paths={paths}
          resolved={resolved[field]}
          pick={() => native.selectDirectory(paths[field] || resolved[field] || undefined)}
        />
      ))}
      <ContentPathRow
        field="gamePrefsPath"
        paths={paths}
        resolved={resolved.gamePrefsPath}
        pick={() =>
          native.selectFile({ filters: [{ name: "game.prefs", extensions: ["prefs"] }] })
        }
      />
      <ContentPathRow
        field="javaPath"
        paths={paths}
        resolved={resolved.javaPath}
        pick={() => native.selectFile({})}
      />
      <p className="muted">{t("settings.paths.overrideNote")}</p>
    </div>
  );
}

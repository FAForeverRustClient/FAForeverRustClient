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
import type { PathPreferences, PathPreferencesPatch } from "../../ipc/bindings";
import { useAppStore } from "../../store/store";
import { GamePathsSection } from "./GamePathsSection";
import { SettingsGroup } from "./SettingControls";
import { gameNeedsALaunchWrapper } from "../../shared/platform";
import { pickOriginalGameFolder } from "../../shared/originalGame";

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
/** A directory, but only on the platforms that have one. */
type WrapperField = "winePrefix";
/**
 * The original game FAF reads movies, sounds, fonts and libraries from. Found
 * on its own in most places, but not in all, and with no fallback when it is
 * not: the row then says so rather than "Automatic".
 */
type OriginalGameField = "originalGameDir";

const LABEL = {
  vaultDir: "settings.paths.vault",
  mapsDir: "settings.paths.maps",
  modsDir: "settings.paths.mods",
  replaysDir: "settings.paths.replays",
  mapGeneratorDir: "settings.paths.mapGenerator",
  gamePrefsPath: "settings.paths.gamePrefs",
  javaPath: "settings.paths.java",
  winePrefix: "settings.paths.winePrefix",
  originalGameDir: "settings.paths.originalGame",
} as const satisfies Record<
  DirectoryField | FileField | WrapperField | OriginalGameField,
  MessageKey
>;

const setPaths = (patch: PathPreferencesPatch) =>
  ipc.send({ kind: "Settings", command: { type: "patchPaths", payload: { patch } } });

function ContentPathRow({
  field,
  paths,
  resolved,
  pick,
}: {
  field: DirectoryField | FileField | WrapperField | OriginalGameField;
  paths: PathPreferences;
  resolved: string;
  pick: () => Promise<string | null>;
}) {
  const { t } = useTranslation();
  const configured = paths[field];
  // Only the original game resolves to nothing: every other location has a
  // fallback. Nothing found is worth a warning, not "Automatic".
  const status = !resolved && field === "originalGameDir" ? "missing" : configured ? "ok" : "unset";
  const STATUS_LABEL = {
    missing: t("settings.paths.notFound"),
    ok: t("settings.paths.custom"),
    unset: t("settings.paths.automatic"),
  } as const;

  const choose = () =>
    ipc.run(
      pick().then((picked) => {
        if (picked) setPaths({ [field]: picked });
      }),
    );

  return (
    <div className="settings-path-row">
      <div className="settings-path-info">
        <span className="settings-path-label">{t(LABEL[field])}</span>
        {/* The resolved location, always. When it was set here it is the same
            string; when it was not, it is the only way to see where the
            fallback landed. */}
        <span className="settings-path-value">{resolved || t("settings.paths.unset")}</span>
        <span className={`settings-path-status is-${status}`}>{STATUS_LABEL[status]}</span>
      </div>
      <div className="settings-path-actions">
        <Button onClick={choose}>{t("settings.paths.browse")}</Button>
        <Button
          disabled={!configured}
          onClick={() => setPaths({ [field]: "" })}
          title={t("settings.paths.resetHint")}
        >
          {t("settings.paths.reset")}
        </Button>
      </div>
    </div>
  );
}

export function PathsSettingsSection() {
  const paths = useAppStore((s) => s.state.settings.paths);
  const resolved = useAppStore((s) => s.state.install.resolved);

  return (
    <SettingsGroup>
      {/* The executables first: nothing else here matters if the client
          cannot find a game to launch. */}
      <GamePathsSection />
      {/* Right below the installs: it is the other half of a playable game. */}
      <ContentPathRow
        field="originalGameDir"
        paths={paths}
        resolved={resolved.originalGameDir}
        pick={() => pickOriginalGameFolder(paths.originalGameDir || resolved.originalGameDir)}
      />
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
          native.selectFile({
            filters: [{ name: "game.prefs", extensions: ["prefs"] }],
            defaultPath: paths.gamePrefsPath || resolved.gamePrefsPath || undefined,
          })
        }
      />
      <ContentPathRow
        field="javaPath"
        paths={paths}
        resolved={resolved.javaPath}
        pick={() => native.selectFile({ defaultPath: paths.javaPath || resolved.javaPath || undefined })}
      />
      {/* Only where the game needs one. On Windows FA runs directly and a
          prefix is not a thing that exists, so the row would be a question
          with no answer. */}
      {gameNeedsALaunchWrapper() && (
        <ContentPathRow
          field="winePrefix"
          paths={paths}
          resolved={resolved.winePrefix}
          pick={() => native.selectDirectory(paths.winePrefix || resolved.winePrefix || undefined)}
        />
      )}
    </SettingsGroup>
  );
}

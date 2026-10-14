// "Check for updates" on the installed library: reload the mod catalogue, then
// say what the reload found and show the mods it found it for.

import { useEffect, useRef, useState } from "react";
import type { ModListStatus, VaultMod } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { useTranslation } from "../../i18n/useTranslation";
import type { InstalledModPreset } from "./useInstalledModFilters";

export type ModUpdateCheck = ReturnType<typeof useModUpdateCheck>;

export function useModUpdateCheck({
  vault,
  vaultStatus,
  updatableFolders,
  choosePreset,
}: {
  vault: VaultMod[];
  vaultStatus: ModListStatus;
  /** The installed folders the catalogue on screen has a newer version for. */
  updatableFolders: ReadonlySet<string>;
  choosePreset: (preset: InstalledModPreset) => void;
}) {
  const { t } = useTranslation();
  // The answer to "how do I know if a mod needs updating", which was the part
  // of the report nothing on this screen answered: the badges only appear once
  // the catalogue happens to have been reloaded, and nothing asks it to.
  const [checking, setChecking] = useState(false);
  /** Whether the reload a check asked for has been seen running yet. */
  const reloadSeen = useRef(false);
  /**
   * The catalogue on screen when the check was pressed. A reload that finished
   * always replaces it; one called off from the status bar leaves it, and has
   * found nothing to report.
   */
  const vaultAtCheck = useRef<VaultMod[] | null>(null);
  const [checkResult, setCheckResult] = useState("");

  // The catalogue reload finished: say what it found, and take the reader to
  // the mods it found it for. Silence would leave the button looking broken in
  // the common case, which is that everything is already current.
  useEffect(() => {
    if (!checking) return;
    // Only once the reload has started and then ended: the press lands while
    // the old catalogue still reads "ready", and judging that would report on
    // the very data the press was meant to replace.
    if (vaultStatus.type === "loading") {
      reloadSeen.current = true;
      return;
    }
    if (!reloadSeen.current) return;
    reloadSeen.current = false;
    setChecking(false);
    if (vaultStatus.type === "failed") {
      setCheckResult(t("mods.installed.checkFailed"));
      return;
    }
    // Called off: there is no new catalogue, and reporting on the old one
    // would answer a question the reader withdrew.
    if (vaultStatus.type === "cancelled" || vault === vaultAtCheck.current) return;
    const count = updatableFolders.size;
    setCheckResult(
      count > 0
        ? t("mods.installed.checkFound", { count })
        : t("mods.installed.checkNone"),
    );
    if (count > 0) choosePreset("updates");
    // `updatableFolders` is recomputed from the reloaded catalogue, and it is
    // the value this effect exists to read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checking, vaultStatus]);

  // The result is a note, not a state: it says what one press found and then
  // gets out of the way.
  useEffect(() => {
    if (!checkResult) return;
    const timer = window.setTimeout(() => setCheckResult(""), 6_000);
    return () => window.clearTimeout(timer);
  }, [checkResult]);

  const startCheck = () => {
    setCheckResult("");
    setChecking(true);
    vaultAtCheck.current = vault;
    // A real fetch: `loadVault` is refused once the catalogue is
    // loaded, which made this report on a stale one.
    ipc.send({ kind: "Mods", command: { type: "reloadVault" } });
  };

  return { checking, checkResult, startCheck };
}

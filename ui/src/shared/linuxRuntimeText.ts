// What the Linux runtime's status says, in words: shared by the Game settings
// and the status bar, and kept free of React so it can be tested in node.
// Mirrors crates/faf-domain/src/state/linux_runtime.rs.

import type {
  LinuxDistribution,
  LinuxPrerequisite,
  LinuxRuntimeComponent,
  LinuxRuntimeStatus,
} from "../ipc/bindings";
import type { MessageKey } from "../i18n/catalog/en";
import type { MessageValues } from "../i18n";

type Translate = (key: MessageKey, values?: MessageValues) => string;

/** Product names, the same in every language. */
const COMPONENT_NAMES: Record<LinuxRuntimeComponent, string> = {
  proton: "GE-Proton",
  steamRuntime: "Steam Linux Runtime",
  dxvk: "DXVK",
  directX: "DirectX",
};

/** The step in progress, or `null` when nothing is. */
export function linuxRuntimeStep(status: LinuxRuntimeStatus, t: Translate): string | null {
  switch (status.type) {
    case "checking":
      return t("settings.game.linuxRuntime.step.checking");
    case "downloading":
      return t("settings.game.linuxRuntime.step.downloading", {
        component: COMPONENT_NAMES[status.payload.component],
      });
    case "installing": {
      const step = status.payload.step;
      switch (step.type) {
        case "unpacking":
          return t("settings.game.linuxRuntime.step.unpacking", {
            component: COMPONENT_NAMES[step.payload.component],
          });
        case "creatingPrefix":
          return t("settings.game.linuxRuntime.step.creatingPrefix");
        case "installingDirectX":
          return t("settings.game.linuxRuntime.step.installingDirectX");
        case "installingDxvk":
          return t("settings.game.linuxRuntime.step.installingDxvk");
      }
    }
    case "notNeeded":
    case "missing":
    case "ready":
    case "failed":
      return null;
  }
}

/** A download's share in whole percent, or `null` while there is none. */
export function linuxRuntimePercent(status: LinuxRuntimeStatus): number | null {
  if (status.type !== "downloading" || status.payload.totalBytes <= 0) return null;
  return Math.min(100, Math.floor((status.payload.downloadedBytes / status.payload.totalBytes) * 100));
}

export const PREREQUISITE_KEYS: Record<LinuxPrerequisite, MessageKey> = {
  bubblewrap: "settings.game.linuxRuntime.prereq.bubblewrap",
  userNamespaces: "settings.game.linuxRuntime.prereq.userNamespaces",
  vulkan64: "settings.game.linuxRuntime.prereq.vulkan64",
  vulkan32: "settings.game.linuxRuntime.prereq.vulkan32",
  xz: "settings.game.linuxRuntime.prereq.xz",
  forgedAlliance: "settings.game.linuxRuntime.prereq.forgedAlliance",
};

type Packaged = "bubblewrap" | "xz" | "vulkan64" | "vulkan32";

/** faf-linux's README, package by package. */
const PACKAGES: Record<Exclude<LinuxDistribution, "other">, Record<Packaged, string>> = {
  debian: {
    bubblewrap: "bubblewrap",
    xz: "xz-utils",
    vulkan64: "libvulkan1:amd64",
    vulkan32: "libvulkan1:i386",
  },
  fedora: {
    bubblewrap: "bubblewrap",
    xz: "xz",
    vulkan64: "vulkan-loader.x86_64",
    vulkan32: "vulkan-loader.i686",
  },
  arch: {
    bubblewrap: "bubblewrap",
    xz: "xz",
    vulkan64: "vulkan-icd-loader",
    vulkan32: "lib32-vulkan-icd-loader",
  },
};

const PACKAGED: readonly Packaged[] = ["bubblewrap", "xz", "vulkan64", "vulkan32"];

/**
 * One command installing every missing package, or `null` when no package is
 * missing or the distribution is not one whose package names are known.
 */
export function installCommand(
  distribution: LinuxDistribution,
  missing: readonly LinuxPrerequisite[],
): string | null {
  if (distribution === "other") return null;
  const names = PACKAGED.filter((item) => missing.includes(item)).map(
    (item) => PACKAGES[distribution][item],
  );
  if (names.length === 0) return null;
  switch (distribution) {
    case "debian": {
      // A 32-bit package needs the architecture enabled first.
      const i386 = missing.includes("vulkan32") ? "sudo dpkg --add-architecture i386 && " : "";
      return `${i386}sudo apt update && sudo apt install ${names.join(" ")}`;
    }
    case "fedora":
      return `sudo dnf install ${names.join(" ")}`;
    case "arch":
      return `sudo pacman -Syu ${names.join(" ")}`;
  }
}

/** faf-linux's README for Ubuntu's AppArmor rule; a restart applies it. */
export const USER_NAMESPACES_COMMAND =
  'echo "kernel.apparmor_restrict_unprivileged_userns = 0" | sudo tee /etc/sysctl.d/99-allow-userns.conf';

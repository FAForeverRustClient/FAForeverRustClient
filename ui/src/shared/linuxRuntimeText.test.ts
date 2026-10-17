import { describe, expect, it } from "vitest";

import { translateIn } from "../i18n";
import type { MessageKey } from "../i18n/catalog/en";
import type { MessageValues } from "../i18n";
import { installCommand, linuxRuntimePercent, linuxRuntimeStep } from "./linuxRuntimeText";

const t = (key: MessageKey, values?: MessageValues) => translateIn("en", key, values);

describe("the Linux runtime's install command", () => {
  it("installs only what is missing, with the 32-bit architecture enabled first on Debian", () => {
    expect(installCommand("debian", ["vulkan32"])).toBe(
      "sudo dpkg --add-architecture i386 && sudo apt update && sudo apt install libvulkan1:i386",
    );
    expect(installCommand("debian", ["bubblewrap", "xz"])).toBe(
      "sudo apt update && sudo apt install bubblewrap xz-utils",
    );
  });

  it("names Fedora's and Arch's packages", () => {
    expect(installCommand("fedora", ["vulkan64", "vulkan32"])).toBe(
      "sudo dnf install vulkan-loader.x86_64 vulkan-loader.i686",
    );
    expect(installCommand("arch", ["bubblewrap", "vulkan32"])).toBe(
      "sudo pacman -Syu bubblewrap lib32-vulkan-icd-loader",
    );
  });

  it("has no command for what no package fixes, or for an unknown distribution", () => {
    expect(installCommand("debian", ["userNamespaces", "forgedAlliance"])).toBeNull();
    expect(installCommand("other", ["bubblewrap"])).toBeNull();
  });
});

describe("the Linux runtime's progress", () => {
  it("names the component being downloaded and its share", () => {
    const status = {
      type: "downloading",
      payload: { component: "proton", downloadedBytes: 25, totalBytes: 100 },
    } as const;
    expect(linuxRuntimeStep(status, t)).toBe("Downloading GE-Proton");
    expect(linuxRuntimePercent(status)).toBe(25);
  });

  it("names each installation step", () => {
    expect(
      linuxRuntimeStep(
        {
          type: "installing",
          payload: { step: { type: "unpacking", payload: { component: "steamRuntime" } } },
        },
        t,
      ),
    ).toBe("Unpacking Steam Linux Runtime");
    expect(linuxRuntimeStep({ type: "installing", payload: { step: { type: "creatingPrefix" } } }, t)).toBe(
      "Creating the Wine prefix",
    );
  });

  it("has nothing to say when nothing is in progress", () => {
    expect(linuxRuntimeStep({ type: "ready" }, t)).toBeNull();
    expect(linuxRuntimeStep({ type: "notNeeded" }, t)).toBeNull();
    expect(linuxRuntimePercent({ type: "checking" })).toBeNull();
  });
});

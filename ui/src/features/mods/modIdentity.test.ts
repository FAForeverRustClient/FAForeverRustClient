import { describe, expect, it } from "vitest";
import type { InstalledMod, VaultMod } from "../../ipc/bindings";
import { modCounterparts } from "./modIdentity";

function installedMod(overrides: Partial<InstalledMod>): InstalledMod {
  return {
    folderName: "roguelike",
    uid: "old-uid",
    displayName: "Roguelike Mode",
    version: "11",
    author: "Nuggets",
    description: "",
    modType: "sim",
    enabled: true,
    ...overrides,
  };
}

function vaultMod(overrides: Partial<VaultMod>): VaultMod {
  return {
    modId: 1,
    versionId: 12,
    displayName: "Roguelike Mode",
    author: "Nuggets",
    uploader: "Nuggets",
    uploaderId: 1,
    uid: "new-uid",
    version: "12",
    description: "",
    filename: "roguelike.v0012.zip",
    modType: "sim",
    ranked: false,
    recommended: false,
    ratingTenths: 0,
    reviews: 0,
    createdAt: "",
    updatedAt: "",
    downloadUrl: "https://content.faforever.com/mods/roguelike.v0012.zip",
    thumbnailUrl: "",
    ...overrides,
  };
}

describe("which installed mod a vault entry is", () => {
  it("matches the same version by uid", () => {
    const installed = installedMod({ uid: "new-uid", version: "12" });
    const vault = vaultMod({});
    const { installedFor, vaultFor } = modCounterparts([installed], [vault]);
    expect(installedFor(vault)).toBe(installed);
    expect(vaultFor(installed)).toBe(vault);
  });

  // The reported bug: every version has a uid of its own and the vault lists the
  // latest, so an older installed copy never matched its entry, the card offered
  // "Install" instead of "Update", and the install refused the existing folder.
  it("recognises an older installed version of the vault's mod", () => {
    const installed = installedMod({});
    const vault = vaultMod({});
    const { installedFor, vaultFor } = modCounterparts([installed], [vault]);
    expect(installedFor(vault)).toBe(installed);
    expect(vaultFor(installed)).toBe(vault);
  });

  it("matches name and author regardless of case and surrounding space", () => {
    const installed = installedMod({ displayName: " roguelike mode ", author: "NUGGETS" });
    const vault = vaultMod({});
    expect(modCounterparts([installed], [vault]).installedFor(vault)).toBe(installed);
  });

  it("does not match a mod of the same name by somebody else", () => {
    const installed = installedMod({ author: "Someone else" });
    const vault = vaultMod({});
    const { installedFor, vaultFor } = modCounterparts([installed], [vault]);
    expect(installedFor(vault)).toBeUndefined();
    expect(vaultFor(installed)).toBeUndefined();
  });

  // Two vault mods with one name and one author are two mods; guessing between
  // them would update the wrong one.
  it("refuses to guess when the name and author name more than one vault mod", () => {
    const installed = installedMod({});
    const first = vaultMod({ modId: 1, uid: "a" });
    const second = vaultMod({ modId: 2, uid: "b" });
    const { installedFor, vaultFor } = modCounterparts([installed], [first, second]);
    expect(vaultFor(installed)).toBeUndefined();
    expect(installedFor(first)).toBeUndefined();
    expect(installedFor(second)).toBeUndefined();
  });

  it("refuses to guess when two installed copies share the name and author", () => {
    const older = installedMod({ uid: "v10", folderName: "roguelike-10" });
    const old = installedMod({ uid: "v11", folderName: "roguelike-11" });
    const vault = vaultMod({});
    const { installedFor } = modCounterparts([older, old], [vault]);
    expect(installedFor(vault)).toBeUndefined();
  });

  it("still matches an exact uid when the name is shared", () => {
    const installed = installedMod({ uid: "a" });
    const first = vaultMod({ modId: 1, uid: "a" });
    const second = vaultMod({ modId: 2, uid: "b" });
    expect(modCounterparts([installed], [first, second]).installedFor(first)).toBe(installed);
  });
});

import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { downloadVerified } from "./download-verified.mjs";

// FAF's Go ICE adapter, fetched rather than committed. The Windows build alone
// is 16 MB, and a binary in the tree is a binary in every clone forever: the one
// this replaces was added in the first commit and had no way to be updated
// except by committing another copy beside it.
//
// Pinned to the release the committed binary was, byte for byte, so switching to
// the download changed nothing about what runs. 0.2.5 is out; bumping it is a
// decision about the adapter, not about packaging, so it wants its own change.
const version = process.env.FAF_PIONEER_VERSION || "0.2.2";
const platformAssets = {
  win32: `faf-pioneer-${version}-windows-amd64.exe`,
  darwin: `faf-pioneer-${version}-darwin-amd64`,
  linux: `faf-pioneer-${version}-linux-amd64`,
};
const pinnedDigests = {
  win32: "c3919f2555dfe64ccb3e51d1202b58ed341e9e7dc0b2776c4c8136f872072c09",
  darwin: "d13d35b363112ca8646052694b6fe13eb2470c106c2a5f3531b00a2554843c41",
  linux: "949f5dc5c09c0184f3538e4e387fb5c235fde964faa568b7a1395d73fa0ff52b",
};

// The name the client looks for, which the release assets do not use: they carry
// the version and the architecture. `infra::ice_pioneer` resolves
// `faf-pioneer[.exe]` beside the app, in `natives/`, or in `resources/`.
const localName = process.platform === "win32" ? "faf-pioneer.exe" : "faf-pioneer";
const asset = platformAssets[process.platform];
const nativeDirectory = join(process.cwd(), "natives");

await mkdir(nativeDirectory, { recursive: true });

if (!asset) {
  console.warn(
    `[faf-pioneer] No bundled asset is configured for ${process.platform}; use FAF_ICE_ADAPTER_PATH.`,
  );
  process.exit(0);
}

// The adapter only matters for a real connected game. A run that supplies its
// own binary, or opts out, or is not going near the lobby, has no use for it.
if (process.env.FAF_ICE_ADAPTER_PATH || process.env.FAF_SKIP_PIONEER_DOWNLOAD === "1") {
  process.exit(0);
}
if (process.env.FAF_FAKE_AUTH && !process.env.FAF_REAL_LOBBY) {
  process.exit(0);
}

const target = join(nativeDirectory, localName);
const url = `https://github.com/FAForever/faf-pioneer/releases/download/${version}/${asset}`;
const expectedSha256 =
  process.env.FAF_PIONEER_SHA256 || (version === "0.2.2" ? pinnedDigests[process.platform] : "");
if (!expectedSha256) {
  throw new Error(
    "FAF_PIONEER_SHA256 is required when FAF_PIONEER_VERSION overrides the pinned release",
  );
}

try {
  const downloaded = await downloadVerified({
    label: "faf-pioneer",
    url,
    target,
    expectedSha256,
  });
  if (process.platform !== "win32") {
    await chmod(target, 0o755);
  }
  console.log(
    `[faf-pioneer] ${downloaded ? "Downloaded and verified" : "Verified"} ${asset} ${version}`,
  );
} catch (error) {
  console.error(`[faf-pioneer] ${error.message}`);
  process.exitCode = 1;
}

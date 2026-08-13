import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { downloadVerified } from "./download-verified.mjs";

// Keep this in sync with the version used by the official Java client. The
// environment override is useful when FAF publishes a newer compatible build.
const version = process.env.FAF_UID_VERSION || "v4.0.7";
const platformAssets = {
  win32: "faf-uid.exe",
  darwin: "faf-uid-macos",
  linux: "faf-uid",
};
const pinnedDigests = {
  "faf-uid.exe": "b9ceaa71dad26c0eb8472c63d4dd27ab7328ffd941407c78d7bfddd90933c337",
  "faf-uid-macos": "605cde843d9728671608a737d1eac05a1aae40384d8abc90d5b17de00f197e97",
  "faf-uid": "1136d0e1cd7e61682ad375043fdac4bae690bf63d7fdd98a7a3a1fb9ccac61da",
};
const asset = platformAssets[process.platform];
const nativeDirectory = join(process.cwd(), "natives");

await mkdir(nativeDirectory, { recursive: true });

if (!asset) {
  console.warn(`[faf-uid] No bundled asset is configured for ${process.platform}; use FAF_UID_PATH.`);
  process.exit(0);
}

if (process.env.FAF_UID_PATH || process.env.FAF_SKIP_UID_DOWNLOAD === "1") {
  process.exit(0);
}

// Offline/test runs should remain usable without reaching GitHub. A real-lobby
// run explicitly opts in and will still attempt the download.
if (process.env.FAF_FAKE_AUTH && !process.env.FAF_REAL_LOBBY) {
  process.exit(0);
}

const target = join(nativeDirectory, asset);
const url = `https://github.com/FAForever/uid/releases/download/${version}/${asset}`;
const expectedSha256 = process.env.FAF_UID_SHA256
  || (version === "v4.0.7" ? pinnedDigests[asset] : "");
if (!expectedSha256) {
  throw new Error("FAF_UID_SHA256 is required when FAF_UID_VERSION overrides the pinned release");
}

try {
  const downloaded = await downloadVerified({
    label: "faf-uid",
    url,
    target,
    expectedSha256,
  });
  if (process.platform !== "win32") {
    await chmod(target, 0o755);
  }
  console.log(`[faf-uid] ${downloaded ? "Downloaded and verified" : "Verified"} ${asset} ${version}`);
} catch (error) {
  console.error(`[faf-uid] ${error.message}`);
  process.exitCode = 1;
}

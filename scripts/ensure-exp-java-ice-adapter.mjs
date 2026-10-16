import { join } from "node:path";

import { downloadVerified } from "./download-verified.mjs";

// GodFuper's WebRTC build of faf-ice-adapter, not yet an official FAForever
// release (FAForever/java-ice-adapter#91). Bundled beside the official
// adapter, which stays the default; players opt in under Settings.
const pinnedVersion = "4.0.1";
const platformAssets = {
  win32: {
    name: `faf-ice-adapter-${pinnedVersion}-win.jar`,
    sha256: "cffe6339abf58c5d46f4ae5527ec7ec0aef203e35a73c093e6dc9faac2d98e4c",
  },
  linux: {
    name: `faf-ice-adapter-${pinnedVersion}-linux.jar`,
    sha256: "ed548e7481f3cbfd103f7efd505db2f7251a3bf14d248bbb2415ae5140b3fd7b",
  },
};
const release = platformAssets[process.platform];

if (process.env.FAF_EXP_JAVA_ICE_ADAPTER_JAR || process.env.FAF_SKIP_ICE_ADAPTER_DOWNLOAD === "1") {
  process.exit(0);
}
if (process.env.FAF_FAKE_AUTH && !process.env.FAF_REAL_LOBBY) {
  process.exit(0);
}
if (!release) {
  console.warn(`[exp-java-ice] No bundled adapter artifact is configured for ${process.platform}; use FAF_EXP_JAVA_ICE_ADAPTER_JAR.`);
  process.exit(0);
}

const target = join(process.cwd(), "natives", "exp-java-ice-adapter", "faf-ice-adapter.jar");
const url = `https://github.com/GodFuper/java-ice-adapter/releases/download/${pinnedVersion}/${release.name}`;

try {
  const downloaded = await downloadVerified({
    label: "Exp Java ICE adapter",
    url,
    target,
    expectedSha256: release.sha256,
  });
  console.log(`[exp-java-ice] ${downloaded ? "Downloaded and verified" : "Verified"} ${release.name}`);
} catch (error) {
  console.error(`[exp-java-ice] ${error.message}`);
  process.exitCode = 1;
}

import { join } from "node:path";

import { downloadVerified } from "./download-verified.mjs";

const pinnedVersion = "4.0.0";
const platformAssets = {
  win32: {
    name: `faf-ice-adapter-${pinnedVersion}-win.jar`,
    sha256: "6a55b8ff88b9477495a30ac13f3d9788c7f05a90842aa2141a81a98024118994",
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

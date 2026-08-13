import { join } from "node:path";

import { downloadVerified } from "./download-verified.mjs";

// Keep this aligned with the official Java client. Platform builds include
// their native WebRTC and optional JavaFX dependencies, unlike the nojfx JAR.
const pinnedVersion = "3.3.14";
const platformAssets = {
  win32: {
    name: `faf-ice-adapter-${pinnedVersion}-win.jar`,
    sha256: "8646f3ae75cf99febc79df7f198de11e73f8408f75ab4f8fe028cb52f7198be4",
  },
  linux: {
    name: `faf-ice-adapter-${pinnedVersion}-linux.jar`,
    sha256: "d756c3c869424d4ddbecf48339cfaf8375020e4101b346d8851e04ff5107d656",
  },
};
const release = platformAssets[process.platform];

if (process.env.FAF_ICE_ADAPTER_JAR || process.env.FAF_SKIP_ICE_ADAPTER_DOWNLOAD === "1") {
  process.exit(0);
}
if (process.env.FAF_FAKE_AUTH && !process.env.FAF_REAL_LOBBY) {
  process.exit(0);
}
if (!release) {
  console.warn(`[java-ice] No bundled adapter artifact is configured for ${process.platform}; use FAF_ICE_ADAPTER_JAR.`);
  process.exit(0);
}

const version = process.env.FAF_ICE_ADAPTER_VERSION || pinnedVersion;
const asset = version === pinnedVersion
  ? release.name
  : `faf-ice-adapter-${version}-${process.platform === "win32" ? "win" : "linux"}.jar`;
const expectedSha256 = process.env.FAF_ICE_ADAPTER_SHA256
  || (version === pinnedVersion ? release.sha256 : "");
if (!expectedSha256) {
  throw new Error(
    "FAF_ICE_ADAPTER_SHA256 is required when FAF_ICE_ADAPTER_VERSION overrides the pinned release",
  );
}

const target = join(process.cwd(), "natives", "java-ice-adapter", "faf-ice-adapter.jar");
const url = `https://github.com/FAForever/java-ice-adapter/releases/download/${version}/${asset}`;

try {
  const downloaded = await downloadVerified({
    label: "Java ICE adapter",
    url,
    target,
    expectedSha256,
  });
  console.log(`[java-ice] ${downloaded ? "Downloaded and verified" : "Verified"} ${asset}`);
} catch (error) {
  console.error(`[java-ice] ${error.message}`);
  process.exitCode = 1;
}

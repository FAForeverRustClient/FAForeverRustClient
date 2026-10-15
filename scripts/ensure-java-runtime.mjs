import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { downloadVerified } from "./download-verified.mjs";
import { JAVA_RUNTIME_VERSION as version, JAVA_RUNTIMES } from "./java-runtime.mjs";

// Neroxis 1.22.x is compiled for class-file version 69, so Java 21 (sufficient
// for the ICE adapter) is no longer sufficient for the complete client.

if (process.env.FAF_JAVA_PATH || process.env.FAF_SKIP_JAVA_RUNTIME_DOWNLOAD === "1") {
  process.exit(0);
}
if (process.env.FAF_FAKE_AUTH && !process.env.FAF_REAL_LOBBY) {
  process.exit(0);
}
const platformRuntime = JAVA_RUNTIMES[`${process.platform}/${process.arch}`];
if (!platformRuntime) {
  console.warn(`[java-runtime] No bundled runtime is configured for ${process.platform}/${process.arch}; use FAF_JAVA_PATH.`);
  process.exit(0);
}
const { archive: archiveName, sha256: expectedSha256, executable } = platformRuntime;
const url = `https://github.com/adoptium/temurin25-binaries/releases/download/jdk-${encodeURIComponent(version)}/${archiveName}`;

const nativeDir = join(process.cwd(), "natives");
const archive = join(nativeDir, "downloads", archiveName);
const runtime = join(nativeDir, "jre");
const marker = join(runtime, ".temurin-version");
const java = join(runtime, "bin", executable);

try {
  const downloaded = await downloadVerified({
    label: "Eclipse Temurin Java runtime",
    url,
    target: archive,
    expectedSha256,
  });
  const installedVersion = await readFile(marker, "utf8").catch(() => "");
  const installed = installedVersion.trim() === version
    && await readFile(java).then(() => true).catch(() => false);
  if (!installed) {
    const staging = join(nativeDir, "jre.extracting");
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    const extraction = spawnSync("tar", ["-xf", archive, "-C", staging], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (extraction.status !== 0) {
      throw new Error(`archive extraction failed: ${(extraction.stderr || extraction.stdout).trim()}`);
    }
    const entries = await readdir(staging, { withFileTypes: true });
    const roots = entries.filter((entry) => entry.isDirectory());
    if (roots.length !== 1) {
      throw new Error(`archive contained ${roots.length} runtime roots instead of one`);
    }
    const extracted = join(staging, roots[0].name);
    await rm(runtime, { recursive: true, force: true });
    await rename(extracted, runtime);
    await rm(staging, { recursive: true, force: true });
    await writeFile(marker, `${version}\n`, "utf8");
  }
  console.log(`[java-runtime] ${downloaded ? "Downloaded and verified" : "Verified"} Eclipse Temurin ${version}`);
} catch (error) {
  console.error(`[java-runtime] ${error.message}`);
  process.exitCode = 1;
}

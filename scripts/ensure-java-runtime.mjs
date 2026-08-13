import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { downloadVerified } from "./download-verified.mjs";

// Neroxis 1.22.x is compiled for class-file version 69, so Java 21 (sufficient
// for the ICE adapter) is no longer sufficient for the complete client.
const version = "25.0.3+9";
const archiveName = "OpenJDK25U-jre_x64_windows_hotspot_25.0.3_9.zip";
const expectedSha256 = "a183e7280220ad5f6fe94ecbf025a5f10fc5797a0b18c600ed8f813c8158c530";
const url = `https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.3%2B9/${archiveName}`;

if (process.env.FAF_JAVA_PATH || process.env.FAF_SKIP_JAVA_RUNTIME_DOWNLOAD === "1") {
  process.exit(0);
}
if (process.env.FAF_FAKE_AUTH && !process.env.FAF_REAL_LOBBY) {
  process.exit(0);
}
if (process.platform !== "win32" || process.arch !== "x64") {
  console.warn(`[java-runtime] No bundled runtime is configured for ${process.platform}/${process.arch}; use FAF_JAVA_PATH.`);
  process.exit(0);
}

const nativeDir = join(process.cwd(), "natives");
const archive = join(nativeDir, "downloads", archiveName);
const runtime = join(nativeDir, "jre");
const marker = join(runtime, ".temurin-version");
const java = join(runtime, "bin", "java.exe");

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

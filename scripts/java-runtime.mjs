import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

export const JAVA_RUNTIME_VERSION = "25.0.3+9";
export const JAVA_RUNTIMES = {
  "win32/x64": {
    archive: "OpenJDK25U-jre_x64_windows_hotspot_25.0.3_9.zip",
    sha256: "a183e7280220ad5f6fe94ecbf025a5f10fc5797a0b18c600ed8f813c8158c530",
    executable: "java.exe",
  },
  "linux/x64": {
    archive: "OpenJDK25U-jre_x64_linux_hotspot_25.0.3_9.tar.gz",
    sha256: "487ad434d8b121ae3902d5ad9cb830cd8e1f75fefad6e2ba80f89d60e3db95d7",
    executable: "java",
  },
};

export function checkJavaRuntime(executable, { exists = existsSync, run = spawnSync } = {}) {
  if (!exists(executable)) throw new Error("The bundled Java runtime is missing.");
  const result = run(executable, ["-version"], { encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) throw new Error("The bundled Java runtime could not be started.");
  const major = Number(/version\s+"(\d+)/.exec(`${result.stderr}\n${result.stdout}`)?.[1]);
  if (!Number.isInteger(major) || major < 25) {
    throw new Error("The bundled Java runtime must be Java 25 or newer.");
  }
  return major;
}

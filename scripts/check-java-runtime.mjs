import { join } from "node:path";
import { checkJavaRuntime, JAVA_RUNTIMES } from "./java-runtime.mjs";

const runtime = JAVA_RUNTIMES[`${process.platform}/${process.arch}`];
if (!runtime) throw new Error("No bundled Java runtime is configured for this release platform.");
const major = checkJavaRuntime(join(process.cwd(), "natives", "jre", "bin", runtime.executable));
console.log(`Bundled Java runtime verified: Java ${major}.`);

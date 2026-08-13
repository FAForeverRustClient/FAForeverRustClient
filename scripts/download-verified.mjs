import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

async function sha256(path) {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

export async function isVerifiedFile(path, expectedSha256) {
  try {
    return (await sha256(path)) === expectedSha256.toLowerCase();
  } catch {
    return false;
  }
}

export async function downloadVerified({ label, url, target, expectedSha256 }) {
  if (!/^[a-f0-9]{64}$/i.test(expectedSha256)) {
    throw new Error(`${label} requires a 64-character SHA-256 digest`);
  }
  if (await isVerifiedFile(target, expectedSha256)) {
    return false;
  }

  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.download`;
  await rm(temporary, { force: true });

  try {
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) {
      throw new Error(`GitHub returned ${response.status} ${response.statusText}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expectedSha256.toLowerCase()) {
      throw new Error(`checksum mismatch: expected ${expectedSha256}, received ${actual}`);
    }

    await writeFile(temporary, bytes);
    await rm(target, { force: true });
    await rename(temporary, target);
    return true;
  } catch (error) {
    await rm(temporary, { force: true });
    throw new Error(`${label} download failed from ${url}: ${error.message}`, { cause: error });
  }
}

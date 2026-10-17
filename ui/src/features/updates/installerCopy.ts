import type { ClientRelease } from "../../ipc/bindings";

/** Display only. Execution uses the backend's validated, owned cache path. */
export function installerRestartsClient(release: ClientRelease): boolean {
  return /\.(exe|msi)$/i.test(release.assetName);
}

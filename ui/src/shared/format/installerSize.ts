/** Installer bytes, in the same units as the vault. Empty when unknown. */
export function formatSize(bytes: number): string {
  if (bytes <= 0) return "";
  const megabytes = bytes / (1024 * 1024);
  return megabytes >= 1 ? `${megabytes.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * A byte count, in the largest unit that leaves it readable.
 *
 * Two copies of this existed, in the game cache settings and in the local
 * replay list, and a third was about to be written for the join dialog's
 * download total. They agreed on everything except how far up the scale they
 * went, which is exactly the kind of difference nobody notices until a number
 * reads as `1536.0 MB` in one place and `1.50 GB` in another.
 *
 * Binary units (1024), because this measures files on a disk and both callers
 * already did. `0 B` for nothing, and for anything nonsensical: a negative or
 * missing size is not worth a special case in a caller.
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

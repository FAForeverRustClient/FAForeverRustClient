import type { ReactNode } from "react";
import { useMarkedMapPreview } from "../markedMapPreview";

/**
 * An installed map's picture with FAF's mass, hydro and spawn icons drawn on
 * it (`markedMapPreview.ts`), for the large preview of a generated map. Shows
 * `fallback` until the picture is drawn, and for good when it cannot be: a map
 * not on disk, or one whose files do not read.
 */
export function MarkedMapImage({ folderName, alt, className, fallback }: {
  /** The installed folder, or `null` to show `fallback` without asking. */
  folderName: string | null;
  alt: string;
  className?: string;
  fallback: ReactNode;
}) {
  const url = useMarkedMapPreview(folderName);
  if (!url) return <>{fallback}</>;
  return <img className={className} src={url} alt={alt} decoding="async" />;
}

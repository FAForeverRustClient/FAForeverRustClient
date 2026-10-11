// Drawing the player's own background picture (#439).
//
// The bytes come from the backend (`read_background_image`) and are shown
// through a blob URL, projected onto the document root as custom properties.
// The stylesheet decides where it appears: see `html[data-background]` in
// `shell.css`.

import { useEffect } from "react";
import { native } from "../ipc/native";

/** What the backend accepts; `IMAGES` in `infra::backgrounds`. */
export const BACKGROUND_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif"] as const;

/** The MIME type for a stored name, which keeps its extension. */
export function backgroundMimeType(name: string): string {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  if (extension === "gif") return "image/gif";
  return "image/png";
}

export function useAppBackground(name: string, dim: number) {
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--app-background-dim", `${Math.min(Math.max(dim, 0), 90)}%`);
  }, [dim]);

  useEffect(() => {
    const root = document.documentElement;
    if (!name) {
      delete root.dataset.background;
      root.style.removeProperty("--app-background-image");
      return;
    }
    let url: string | null = null;
    let cancelled = false;
    native.readBackgroundImage(name)
      .then((bytes) => {
        if (cancelled) return;
        url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: backgroundMimeType(name) }));
        root.style.setProperty("--app-background-image", `url("${url}")`);
        root.dataset.background = "custom";
      })
      .catch(() => {
        // A file deleted by hand: the theme's own background, not an error.
        if (cancelled) return;
        delete root.dataset.background;
        root.style.removeProperty("--app-background-image");
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [name]);
}

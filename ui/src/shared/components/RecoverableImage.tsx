// An `<img>` that hides itself when its picture fails to load, and shows again
// as soon as it is given another picture.
//
// The handlers this replaces set `visibility: hidden` or `hidden` on the
// element itself. React keeps the element when only its `src` changes, so a
// flag that failed once stayed hidden after the player's country changed, and
// a league badge stayed hidden after the season brought a new one that loaded
// fine. Remembering *which* source failed, rather than that one did, makes a
// new source start out visible without an effect to reset anything.

import { useState, type ImgHTMLAttributes } from "react";

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "hidden"> & {
  src: string;
  /**
   * `"keep-space"` hides the picture and keeps its box, for a slot the rest
   * of the line is aligned to (a flag before a name). `"remove"` takes it out
   * of the layout.
   */
  whenBroken?: "keep-space" | "remove";
};

export function RecoverableImage({ src, whenBroken = "keep-space", style, onError, ...rest }: Props) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const broken = failedSource === src;
  return (
    <img
      {...rest}
      src={src}
      hidden={broken && whenBroken === "remove"}
      style={broken && whenBroken === "keep-space" ? { ...style, visibility: "hidden" } : style}
      onError={(event) => {
        setFailedSource(src);
        onError?.(event);
      }}
    />
  );
}

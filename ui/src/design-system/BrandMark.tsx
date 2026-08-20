import { FAF_LOGO_URL } from "../shared/branding";

interface BrandMarkProps {
  className?: string;
  size?: number;
}

/**
 * Shared official FAF mark used anywhere the application identifies itself.
 *
 * Painted as a CSS mask rather than an `<img>`, because the artwork is a
 * single-colour wordmark and the client ships a light theme: the SVG supplies
 * the shape and `--color-brand-mark` supplies the ink, so the one file in the
 * repository reads white on the dark themes and black on forgeLight instead of
 * disappearing into a bright sidebar.
 *
 * `size` bounds the mark rather than sizing it. The wordmark is roughly 2:1, so
 * it letterboxes inside the square its call sites already reserve.
 */
export function BrandMark({ className, size = 32 }: BrandMarkProps) {
  const mask = `url("${FAF_LOGO_URL}") center / contain no-repeat`;
  const style = { height: size, mask, width: size, WebkitMask: mask };

  return (
    <span
      aria-hidden="true"
      className={className ? `brand-glyph ${className}` : "brand-glyph"}
      style={style}
    />
  );
}

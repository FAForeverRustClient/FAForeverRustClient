import { FAF_LOGO_URL } from "../shared/branding";

interface BrandMarkProps {
  className?: string;
  size?: number;
}

/** Shared official FAF mark used anywhere the application identifies itself. */
export function BrandMark({ className, size = 32 }: BrandMarkProps) {
  return (
    <img
      aria-hidden="true"
      className={className}
      draggable={false}
      height={size}
      src={FAF_LOGO_URL}
      width={size}
    />
  );
}

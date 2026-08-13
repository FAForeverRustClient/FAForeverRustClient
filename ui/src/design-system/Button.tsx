// Button primitive. Encapsulates the control's structure + class names so a
// theme that needs structural button differences changes one file, not every
// call site. Variants map to token-driven CSS in styles.css.

import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "ghost";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
}

export function Button({ variant = "ghost", className, ...rest }: ButtonProps) {
  const base = variant === "primary" ? "btn-primary" : "btn-ghost";
  return <button className={className ? `${base} ${className}` : base} {...rest} />;
}

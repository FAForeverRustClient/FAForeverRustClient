// Button primitive. Encapsulates the control's structure + class names so a
// theme that needs structural button differences changes one file, not every
// call site. Variants map to token-driven CSS: `primary` and `ghost` in
// styles.css, `danger` in modal.css beside the confirmation it belongs to.

import { forwardRef, type ButtonHTMLAttributes } from "react";

type Variant = "primary" | "ghost" | "danger";

const CLASS: Record<Variant, string> = {
  primary: "btn-primary",
  ghost: "btn-ghost",
  danger: "btn-danger",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "ghost", className, type = "button", ...rest },
  ref,
) {
  const base = CLASS[variant];
  return <button ref={ref} type={type} className={className ? `${base} ${className}` : base} {...rest} />;
});

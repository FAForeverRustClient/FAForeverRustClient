import { Button } from "../../design-system/Button";

interface CommandErrorBannerProps {
  message: string;
  onDismiss: () => void;
}

/**
 * Reports a command that never reached the Rust runtime without replacing the
 * application. Bootstrap failures are fatal; an isolated button/action failure
 * is recoverable and should leave the user's current screen and input intact.
 */
export function CommandErrorBanner({ message, onDismiss }: CommandErrorBannerProps) {
  return (
    <aside className="command-error-banner surface-error" role="alert" aria-live="assertive">
      <div>
        <strong>Action could not be sent</strong>
        <span>{message}</span>
      </div>
      <Button type="button" onClick={onDismiss}>Dismiss</Button>
    </aside>
  );
}

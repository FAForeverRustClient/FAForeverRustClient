import { BrandMark } from "../../design-system/BrandMark";
import { Button } from "../../design-system/Button";

interface Props {
  error?: string;
}

/** Visible bootstrap boundary while the frontend waits for authoritative Rust state. */
export function StartupView({ error }: Props) {
  return (
    <main className="centered">
      <div className="entry-card" aria-live="polite">
        <div className="entry-brand">
          <BrandMark className="entry-brand-image" size={68} />
        </div>
        <div className="entry-heading">
          <h1>{error ? "Could not start FAForever" : "Starting FAForever"}</h1>
          <p>{error ?? "Loading your client state…"}</p>
        </div>
        {error && (
          <Button variant="primary" onClick={() => window.location.reload()}>
            Try again
          </Button>
        )}
      </div>
    </main>
  );
}

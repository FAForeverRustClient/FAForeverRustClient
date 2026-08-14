import { BrandMark } from "../../design-system/BrandMark";
import { Button } from "../../design-system/Button";
import { useTranslation } from "../../i18n/useTranslation";

interface Props {
  error?: string;
}

/** Visible bootstrap boundary while the frontend waits for authoritative Rust state. */
export function StartupView({ error }: Props) {
  const { t } = useTranslation();

  return (
    <main className="centered">
      <div className="entry-card" aria-live="polite">
        <div className="entry-brand">
          <BrandMark className="entry-brand-image" size={68} />
        </div>
        <div className="entry-heading">
          <h1>{error ? t("shell.startup.failedTitle") : t("shell.startup.title")}</h1>
          <p>{error ?? t("shell.startup.loading")}</p>
        </div>
        {error && (
          <Button variant="primary" onClick={() => window.location.reload()}>
            {t("shell.startup.retry")}
          </Button>
        )}
      </div>
    </main>
  );
}

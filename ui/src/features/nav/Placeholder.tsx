import { useTranslation } from "../../i18n/useTranslation";

// Generic placeholder for tabs whose feature slice hasn't landed yet. Keeps the
// navigation shell complete so each feature is a fill-in, not a restructure.

export function Placeholder({ title }: { title: string }) {
  const { t } = useTranslation();
  return (
    <div className="placeholder">
      <h2 className="view-title">{title}</h2>
      <p className="muted">{t("nav.placeholder")}</p>
    </div>
  );
}

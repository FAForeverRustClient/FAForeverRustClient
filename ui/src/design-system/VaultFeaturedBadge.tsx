import { Icon } from "./Icon";
import { useTranslation } from "../i18n/useTranslation";

/** One shared endorsement marker for catalogue artwork. */
export function VaultFeaturedBadge() {
  const { t } = useTranslation();
  return (
    <span className="vault-featured-badge" title={t("designSystem.featured.title")}>
      <Icon name="star" size={12} fill="currentColor" />
      {t("designSystem.featured.badge")}
    </span>
  );
}

import { useTranslation } from "../i18n/useTranslation";

/**
 * One shared endorsement marker for catalogue artwork.
 *
 * A word, not a star: on the same card a star already means the rating and the
 * favourite button, and a third one here read as more of either.
 */
export function VaultFeaturedBadge() {
  const { t } = useTranslation();
  return (
    <span className="vault-featured-badge" title={t("designSystem.featured.title")}>
      {t("designSystem.featured.badge")}
    </span>
  );
}

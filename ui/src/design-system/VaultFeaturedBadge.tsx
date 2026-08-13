import { Icon } from "./Icon";

/** One shared endorsement marker for catalogue artwork. */
export function VaultFeaturedBadge() {
  return (
    <span className="vault-featured-badge" title="Featured selection from the FAF team">
      <Icon name="star" size={12} fill="currentColor" />
      Featured
    </span>
  );
}

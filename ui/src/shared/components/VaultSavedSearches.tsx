import type { SearchPreset } from "../../ipc/bindings";
import { t, type MessageKey } from "../../i18n";
import { useLocale } from "../../i18n/useTranslation";
import { decodeVaultSearch, encodeVaultSearch, type VaultSearch } from "../vaultSavedSearches";
import { SavedSearches, type SavedSearchEntry } from "./SavedSearches";

export function VaultSavedSearches<F extends { search: string; sort: string }, P extends string>({
  list, presets, category, filters, defaults, categories, choices, signedIn, onApply,
}: {
  list: string;
  presets: SearchPreset[];
  category: P;
  filters: F;
  defaults: F;
  categories: readonly (readonly [P, MessageKey])[];
  choices: Partial<Record<keyof F, readonly string[]>>;
  signedIn: boolean;
  onApply: (value: VaultSearch<F, P>) => void;
}) {
  useLocale();
  const entries: SavedSearchEntry<VaultSearch<F, P>>[] = [];
  for (const preset of presets.filter((entry) => entry.list === list)) {
    const value = decodeVaultSearch(preset.query, defaults, categories.map(([id]) => id), choices);
    if (!value) continue;
    const label = categories.find(([id]) => id === value.category)?.[1];
    const disabled = value.category === "mine" && !signedIn;
    entries.push({ name: preset.name, saved: preset.query, value,
      signature: encodeVaultSearch(value), disabled,
      summary: `${label ? t(label) : value.category}${value.filters.search ? `: ${value.filters.search}` : ""}${disabled ? ` · ${t("auth.signIn")}` : ""}`,
    });
  }
  return <SavedSearches list={list} entries={entries}
    currentSignature={encodeVaultSearch({ category, filters })}
    encodeCurrent={() => encodeVaultSearch({ category, filters })} onApply={onApply} />;
}

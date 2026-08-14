// Theme picker for the Settings → Design section. Selectable cards; the active
// theme comes from the settings slice, selection dispatches SetTheme (the backend
// persists and echoes ThemeChanged). Pure: select state + dispatch.

import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import type { Theme } from "../../ipc/bindings";
import { recordEntries } from "../../shared/records";
import type { MessageKey } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";

const THEMES: Record<Theme, { label: MessageKey; hint: MessageKey }> = {
  forgeDark: { label: "settings.theme.forgeDark", hint: "settings.theme.forgeDarkHint" },
  forgeLight: { label: "settings.theme.forgeLight", hint: "settings.theme.forgeLightHint" },
  javaClient: { label: "settings.theme.javaClient", hint: "settings.theme.javaClientHint" },
  pythonClient: { label: "settings.theme.pythonClient", hint: "settings.theme.pythonClientHint" },
};

export function ThemePicker() {
  const { t } = useTranslation();
  const theme = useAppStore((s) => s.state.settings.theme);

  const setTheme = (value: Theme) =>
    ipc.send({ kind: "Settings", command: { type: "setTheme", payload: { theme: value } } });

  return (
    <div className="theme-grid">
      {recordEntries(THEMES).map(([value, themeOption]) => (
        <button
          type="button"
          key={value}
          className={value === theme
            ? "theme-card surface surface-interactive theme-card-active"
            : "theme-card surface surface-interactive"}
          onClick={() => setTheme(value)}
          aria-pressed={value === theme}
        >
          <span className="theme-card-label">{t(themeOption.label)}</span>
          <span className="theme-card-hint muted">{t(themeOption.hint)}</span>
        </button>
      ))}
    </div>
  );
}

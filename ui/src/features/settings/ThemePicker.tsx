// Theme picker for the Settings → Design section. Selectable cards; the active
// theme comes from the settings slice, selection dispatches SetTheme (the backend
// persists and echoes ThemeChanged). Pure: select state + dispatch.

import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import type { Theme } from "../../ipc/bindings";
import { recordEntries } from "../../shared/records";

const THEMES: Record<Theme, { label: string; hint: string }> = {
  forgeDark: { label: "FAF Dark", hint: "Default · quiet neutral workspace" },
  forgeLight: { label: "FAF Light", hint: "Bright neutral workspace" },
  javaClient: { label: "Java Client", hint: "FAF Java client aesthetic" },
  pythonClient: { label: "Python Client", hint: "FAF Python client aesthetic" },
};

export function ThemePicker() {
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
          <span className="theme-card-label">{themeOption.label}</span>
          <span className="theme-card-hint muted">{themeOption.hint}</span>
        </button>
      ))}
    </div>
  );
}

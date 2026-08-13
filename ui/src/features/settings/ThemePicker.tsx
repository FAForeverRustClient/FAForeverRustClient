// Theme picker for the Settings → Design section. Selectable cards; the active
// theme comes from the settings slice, selection dispatches SetTheme (the backend
// persists and echoes ThemeChanged). Pure: select state + dispatch.

import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import type { Theme } from "../../ipc/bindings";

const THEMES: { value: Theme; label: string; hint: string }[] = [
  { value: "forgeDark", label: "Forge Dark", hint: "ForgeMapToolkit — warm near-black" },
  { value: "forgeLight", label: "Forge Light", hint: "ForgeMapToolkit — light" },
  { value: "javaClient", label: "Java Client", hint: "FAF Java client aesthetic" },
  { value: "pythonClient", label: "Python Client", hint: "FAF Python client aesthetic" },
];

export function ThemePicker() {
  const theme = useAppStore((s) => s.state.settings.theme);

  const setTheme = (value: Theme) =>
    ipc.dispatch({ kind: "Settings", command: { type: "setTheme", payload: { theme: value } } });

  return (
    <div className="theme-grid">
      {THEMES.map((t) => (
        <button
          key={t.value}
          className={t.value === theme ? "theme-card theme-card-active" : "theme-card"}
          onClick={() => setTheme(t.value)}
          aria-pressed={t.value === theme}
        >
          <span className="theme-card-label">{t.label}</span>
          <span className="theme-card-hint muted">{t.hint}</span>
        </button>
      ))}
    </div>
  );
}

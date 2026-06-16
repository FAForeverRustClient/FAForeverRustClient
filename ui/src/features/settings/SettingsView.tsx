// Settings tab. Sectioned page; the first section is Design (theme selection).
// Future settings (account, paths, notifications) become sections here, each
// reading/dispatching its own slice — no restructuring.

import { ThemePicker } from "./ThemePicker";

export function SettingsView() {
  return (
    <div className="settings-view">
      <h2 className="view-title">Settings</h2>

      <section className="settings-section">
        <h3 className="settings-section-title">Design</h3>
        <p className="muted">Choose the look of the client. Your choice is saved.</p>
        <ThemePicker />
      </section>
    </div>
  );
}

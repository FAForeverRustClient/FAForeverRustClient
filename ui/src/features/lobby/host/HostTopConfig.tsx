// The header row shared by both host dialogs: game title, then the three
// admission controls. Co-op keeps the rating window, because an unrated game is
// exactly where a host may want to keep a rushing veteran out of a slow run.

import { useTranslation } from "../../../i18n/useTranslation";
import type { HostLobbySettings } from "./hostLobbySettings";

export function HostTopConfig({ settings }: { settings: HostLobbySettings }) {
  const { t } = useTranslation();

  return (
    <section className="host-top-config surface-panel">
      <div className="host-top-title-wrap">
        <label className="host-top-label" htmlFor="host-lobby-name">
          {t("lobby.host.gameTitle")}
        </label>
        <input
          id="host-lobby-name"
          className="host-title-input"
          value={settings.title}
          maxLength={128}
          aria-invalid={Boolean(settings.titleError)}
          aria-describedby={settings.titleError ? "host-title-error" : undefined}
          onChange={(event) => settings.setTitle(event.target.value)}
          placeholder={t("lobby.host.gameTitle")}
        />
        {settings.titleError && (
          <small id="host-title-error" className="host-field-error host-title-error">
            {settings.titleError}
          </small>
        )}
      </div>

      <div className="host-top-options-row">
        <div className="host-option-item">
          <label className="check-field">
            <input
              type="checkbox"
              checked={settings.passwordEnabled}
              onChange={(event) => settings.setPasswordEnabled(event.target.checked)}
            />
            <span>{t("lobby.host.passwordProtected")}</span>
          </label>
          <input
            className="compact-input host-password-input"
            type="password"
            disabled={!settings.passwordEnabled}
            value={settings.password}
            maxLength={25}
            aria-invalid={Boolean(settings.passwordError)}
            aria-describedby={settings.passwordError ? "host-password-error" : undefined}
            onChange={(event) => settings.setPassword(event.target.value)}
            placeholder={t("lobby.host.password")}
            aria-label={t("lobby.host.passwordAria")}
          />
          {settings.passwordError && (
            <small id="host-password-error" className="host-field-error">
              {settings.passwordError}
            </small>
          )}
        </div>

        <div className="host-option-item">
          <label className="check-field">
            <input
              type="checkbox"
              checked={settings.visibility === "friends"}
              onChange={(event) =>
                settings.setVisibility(event.target.checked ? "friends" : "public")
              }
            />
            <span>{t("lobby.host.onlyFriends")}</span>
          </label>
        </div>

        <div className="host-option-item host-rating-option">
          <label className="check-field">
            <input
              type="checkbox"
              checked={settings.ratingEnabled}
              onChange={(event) => settings.setRatingEnabled(event.target.checked)}
            />
            <span>{t("lobby.host.enforceRating")}</span>
          </label>
          <div className="host-rating-inputs">
            <input
              className="number-input"
              type="number"
              disabled={!settings.ratingEnabled}
              value={settings.ratingMin}
              min={-9999}
              max={9999}
              aria-invalid={Boolean(settings.ratingError)}
              onChange={(event) => settings.setRatingMin(Number(event.target.value))}
              aria-label={t("lobby.host.minRating")}
            />
            <span className="muted">to</span>
            <input
              className="number-input"
              type="number"
              disabled={!settings.ratingEnabled}
              value={settings.ratingMax}
              min={-9999}
              max={9999}
              aria-invalid={Boolean(settings.ratingError)}
              onChange={(event) => settings.setRatingMax(Number(event.target.value))}
              aria-label={t("lobby.host.maxRating")}
            />
          </div>
          {settings.ratingError && (
            <small className="host-field-error host-rating-error">{settings.ratingError}</small>
          )}
        </div>
      </div>
    </section>
  );
}

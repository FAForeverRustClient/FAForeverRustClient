// Login screen. Pure + state-driven: selects the auth slice and dispatches the
// Login command. No knowledge of OAuth, tokens, or networking: that lives behind
// the backend's AuthPort.

import { useState } from "react";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { BrandMark } from "../../design-system/BrandMark";
import "./auth.css";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { ACCOUNT_LINKS, openExternalUrl } from "../../shared/externalLinks";
import { useTranslation } from "../../i18n/useTranslation";

function AccountLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => {
        event.preventDefault();
        void openExternalUrl(href);
      }}
    >
      {children}
    </a>
  );
}

export function LoginView() {
  const { t } = useTranslation();
  const auth = useAppStore((s) => s.state.auth);
  const generalPreferences = useAppStore((s) => s.state.settings.general);
  // Whether this process was built with the offline development ports. The
  // credential-free login only produces a working session there; see
  // `SessionState::offline_auth`.
  const offlineAuth = useAppStore((s) => s.state.session.offlineAuth);
  const [remember, setRemember] = useState(generalPreferences.autoLogin ?? true);
  const busy = auth.status === "loggingIn";

  const login = () => {
    if (remember !== (generalPreferences.autoLogin ?? true)) {
      ipc.send({
        kind: "Settings",
        command: {
          type: "setGeneral",
          payload: { preferences: { ...generalPreferences, autoLogin: remember } },
        },
      });
    }
    ipc.send({ kind: "Auth", command: { type: "login", payload: { remember } } });
  };
  const cancelLogin = () => ipc.send({ kind: "Auth", command: { type: "cancelLogin" } });
  const playOffline = () => ipc.send({ kind: "Auth", command: { type: "playOffline" } });
  const loginTest = () => ipc.send({ kind: "Auth", command: { type: "loginTest" } });

  return (
    <main className="centered login-screen">
      <div className="entry-card surface-panel login-card">
        <div className="entry-brand"><BrandMark size={68} /></div>
        <div className="entry-heading">
          <h1>{t("auth.welcome")}</h1>
          <p>{t("auth.subtitle")}</p>
        </div>

        {busy ? (
          <div className="login-in-progress">
            <Button className="login-button" variant="primary" disabled>
              {t("auth.signingIn")}
            </Button>
            <Button className="login-cancel-button" variant="ghost" onClick={cancelLogin}>
              {t("auth.cancel")}
            </Button>
          </div>
        ) : (
          <Button className="login-button" variant="primary" onClick={login}>
            {t("auth.login")}
          </Button>
        )}
        <p className="login-hint">{t("auth.hint")}</p>

        {/* Everything the client can do without FAF: the replays already on
            this disk, and the settings. Offered next to the login rather than
            behind a failed one, because the people who need it most are the
            ones whose login is never going to succeed. */}
        <Button className="login-offline-button" onClick={playOffline} disabled={busy}>
          <Icon name="replays" size={15} /> {t("auth.playOffline")}
        </Button>
        <p className="login-hint">{t("auth.playOfflineHint")}</p>

        <label className="login-remember">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => {
              const checked = event.target.checked;
              setRemember(checked);
              ipc.send({
                kind: "Settings",
                command: {
                  type: "setGeneral",
                  payload: { preferences: { ...generalPreferences, autoLogin: checked } },
                },
              });
            }}
          />
          <span>{t("auth.staySignedIn")}</span>
        </label>

        {auth.status === "failed" && auth.error && (
          <p className="login-error surface-error" role="alert">
            <Icon name="bell" size={15} />
            <span>{auth.error}</span>
          </p>
        )}

        <nav className="login-account-links" aria-label={t("auth.helpNav")}>
          <AccountLink href={ACCOUNT_LINKS.create}>{t("auth.createAccount")}</AccountLink>
          <AccountLink href={ACCOUNT_LINKS.recover}>{t("auth.forgotPassword")}</AccountLink>
          <AccountLink href={ACCOUNT_LINKS.support}>{t("auth.support")}</AccountLink>
        </nav>

        {/* Development builds only. Against real ports this fabricates a player
            the server has never heard of, with no token behind it, so every
            request afterwards fails in a way that looks like a broken client. */}
        {offlineAuth && (
          <div className="login-dev">
            <span className="login-dev-tag">{t("auth.devBuild")}</span>
            <Button className="login-test-button" onClick={loginTest} disabled={busy}>
              {t("auth.enterTestMode")}
            </Button>
            <p>{t("auth.devHint")}</p>
          </div>
        )}
      </div>

      <p className="login-footnote">{t("auth.footnote")}</p>
    </main>
  );
}

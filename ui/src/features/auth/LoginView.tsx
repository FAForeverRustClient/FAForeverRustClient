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
  // Whether this process was built with the offline development ports. The
  // credential-free login only produces a working session there; see
  // `SessionState::offline_auth`.
  const offlineAuth = useAppStore((s) => s.state.session.offlineAuth);
  const [remember, setRemember] = useState(true);
  const busy = auth.status === "loggingIn";

  const login = () => ipc.send({ kind: "Auth", command: { type: "login", payload: { remember } } });
  const cancelLogin = () => ipc.send({ kind: "Auth", command: { type: "cancelLogin" } });
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

        <label className="login-remember">
          <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
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

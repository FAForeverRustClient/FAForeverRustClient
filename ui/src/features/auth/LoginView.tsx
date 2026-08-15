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
  const auth = useAppStore((s) => s.state.auth);
  // Whether this process was built with the offline development ports. The
  // credential-free login only produces a working session there; see
  // `SessionState::offline_auth`.
  const offlineAuth = useAppStore((s) => s.state.session.offlineAuth);
  const [remember, setRemember] = useState(true);
  const busy = auth.status === "loggingIn";

  const login = () => ipc.send({ kind: "Auth", command: { type: "login", payload: { remember } } });
  const loginTest = () => ipc.send({ kind: "Auth", command: { type: "loginTest" } });

  return (
    <main className="centered login-screen">
      <div className="entry-card surface-panel login-card">
        <div className="entry-brand"><BrandMark className="entry-brand-image" size={68} /></div>
        <div className="entry-heading">
          <h1>Welcome to FAForever</h1>
          <p>Sign in with your FAF account to continue.</p>
        </div>

        <Button className="login-button" variant="primary" onClick={login} disabled={busy}>
          {busy ? "Signing in…" : "Log in with FAF"}
        </Button>
        <p className="login-hint">Opens your browser to sign in. The client never sees your password.</p>

        <label className="login-remember">
          <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
          <span>Stay signed in on this computer</span>
        </label>

        {auth.status === "failed" && auth.error && (
          <p className="login-error surface-error" role="alert">
            <Icon name="bell" size={15} />
            <span>{auth.error}</span>
          </p>
        )}

        <nav className="login-account-links" aria-label="FAF account help">
          <AccountLink href={ACCOUNT_LINKS.create}>Create account</AccountLink>
          <AccountLink href={ACCOUNT_LINKS.recover}>Forgot password?</AccountLink>
          <AccountLink href={ACCOUNT_LINKS.support}>Support</AccountLink>
        </nav>

        {/* Development builds only. Against real ports this fabricates a player
            the server has never heard of, with no token behind it, so every
            request afterwards fails in a way that looks like a broken client. */}
        {offlineAuth && (
          <div className="login-dev">
            <span className="login-dev-tag">Development build</span>
            <Button className="login-test-button" onClick={loginTest} disabled={busy}>
              Enter test mode
            </Button>
            <p>Local sample account. No browser, no server.</p>
          </div>
        )}
      </div>

      <p className="login-footnote">The open-source multiplayer client for Forged Alliance Forever.</p>
    </main>
  );
}

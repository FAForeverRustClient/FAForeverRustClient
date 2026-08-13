// Login screen. Pure + state-driven: selects the auth slice and dispatches the
// Login command. No knowledge of OAuth, tokens, or networking — that lives behind
// the backend's AuthPort.

import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { Button } from "../../design-system/Button";

export function LoginView() {
  const auth = useAppStore((s) => s.state.auth);
  const busy = auth.status === "loggingIn";

  const login = () => ipc.dispatch({ kind: "Auth", command: { type: "login" } });

  return (
    <main className="centered">
      <div className="card login-card">
        <h1 className="app-title">Forge Client</h1>
        <p className="app-subtitle">Sign in to continue</p>

        <Button variant="primary" className="btn-block" onClick={login} disabled={busy}>
          {busy ? "Signing in…" : "Log in"}
        </Button>

        {auth.status === "failed" && auth.error && (
          <p className="error" role="alert">
            {auth.error}
          </p>
        )}
      </div>
    </main>
  );
}

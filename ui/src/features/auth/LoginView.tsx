// Login screen. Pure + state-driven: selects the auth slice and dispatches the
// Login command. No knowledge of OAuth, tokens, or networking — that lives behind
// the backend's AuthPort.

import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";

export function LoginView() {
  const auth = useAppStore((s) => s.state.auth);
  const busy = auth.status === "loggingIn";

  const login = () => ipc.dispatch({ kind: "Auth", command: { type: "login" } });

  return (
    <main className="centered">
      <div className="card login-card">
        <h1 className="app-title">Forge Client</h1>
        <p className="app-subtitle">Sign in to continue</p>

        <button className="btn-primary" onClick={login} disabled={busy}>
          {busy ? "Signing in…" : "Log in"}
        </button>

        {auth.status === "failed" && auth.error && (
          <p className="error" role="alert">
            {auth.error}
          </p>
        )}
      </div>
    </main>
  );
}

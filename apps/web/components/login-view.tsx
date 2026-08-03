"use client";

import { ArrowIcon } from "@/components/icons";

export function LoginView({
  configured,
  error,
}: {
  configured: boolean;
  error: string | null;
}) {
  return (
    <div className="login-shell">
      <main className="login-card">
        <div className="brand login-brand">
          <span className="brand-mark">QS</span>
          <span>
            QUOTE<span className="brand-accent">READY</span>
            <small>STUDIO</small>
          </span>
        </div>
        <span className="gate-mark">Z</span>
        <h1>Sign in with your Zoo account</h1>
        <p>
          QuoteReady Studio is restricted to authenticated Zoo users. Your
          reports, factory profile and Zoo library stay scoped to your Zoo
          identity.
        </p>
        {error && (
          <div className="error-message login-error" role="alert">
            {error}
          </div>
        )}
        <button
          className="primary-button"
          disabled={!configured}
          onClick={() => window.location.assign("/api/auth/login")}
          type="button"
        >
          {configured ? "Connect Zoo" : "OAuth setup needed"}
          <ArrowIcon />
        </button>
        <small>
          Authorization Code + PKCE via api.zoo.dev · no password is ever stored
          here.
        </small>
      </main>
    </div>
  );
}

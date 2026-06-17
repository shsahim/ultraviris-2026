"use client";

import { useActionState } from "react";
import { loginAction, type FormState } from "../actions";

const initialState: FormState = {};

export default function LoginForm({ configured }: { configured: boolean }) {
  const [state, action, pending] = useActionState(loginAction, initialState);

  return (
    <div className="admin-login">
      <h1 className="admin-title">Natalie R Nathan admin</h1>
      {!configured ? (
        <p className="admin-note admin-note--error">
          Admin is not configured. Set <code>ADMIN_PASSWORD</code> (and
          optionally <code>ADMIN_USERNAME</code>) in your environment to seed the
          first account, then restart the server.
        </p>
      ) : (
        <form action={action} className="admin-login-form">
          <label className="admin-field">
            <span className="admin-label">Username</span>
            <input
              type="text"
              name="username"
              autoComplete="username"
              required
              autoFocus
              className="admin-input"
            />
          </label>
          <label className="admin-field">
            <span className="admin-label">Password</span>
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              required
              className="admin-input"
            />
          </label>
          <button type="submit" disabled={pending} className="admin-button">
            {pending ? "Signing in..." : "Sign in"}
          </button>
          {state.error && (
            <p className="admin-note admin-note--error">{state.error}</p>
          )}
        </form>
      )}
    </div>
  );
}

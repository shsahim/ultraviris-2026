"use client";

import { useActionState } from "react";
import { loginAction, type FormState } from "../actions";

const initialState: FormState = {};

export default function LoginForm({ configured }: { configured: boolean }) {
  const [state, action, pending] = useActionState(loginAction, initialState);

  return (
    <div className="admin-login">
      <h1 className="admin-title">ultraviris admin</h1>
      {!configured ? (
        <p className="admin-note admin-note--error">
          Admin is not configured. Set <code>ADMIN_PASSWORD</code> in your
          environment, then restart the server.
        </p>
      ) : (
        <form action={action} className="admin-login-form">
          <label className="admin-field">
            <span className="admin-label">Password</span>
            <input
              type="password"
              name="password"
              required
              autoFocus
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

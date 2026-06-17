"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import {
  changePasswordAction,
  createUserAction,
  deleteUserAction,
  type FormState,
} from "../actions";

export interface AdminUserRow {
  id: number;
  username: string;
  created_at: string;
  updated_at: string;
}

const initial: FormState = {};

function CreateUser() {
  const [state, action, pending] = useActionState(createUserAction, initial);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.ok) formRef.current?.reset();
  }, [state.ok]);

  return (
    <form ref={formRef} action={action} className="admin-users-form">
      <h3 className="admin-subtitle">Add user</h3>
      <label className="admin-field">
        <span className="admin-label">Username</span>
        <input
          type="text"
          name="username"
          required
          autoComplete="off"
          className="admin-input"
        />
      </label>
      <label className="admin-field">
        <span className="admin-label">Password</span>
        <input
          type="password"
          name="password"
          required
          autoComplete="new-password"
          className="admin-input"
        />
      </label>
      <button type="submit" disabled={pending} className="admin-button">
        {pending ? "Adding..." : "Add user"}
      </button>
      {state.error && (
        <p className="admin-note admin-note--error">{state.error}</p>
      )}
      {state.ok && <p className="admin-note">User added.</p>}
    </form>
  );
}

function ChangePassword({ usernames }: { usernames: string[] }) {
  const [state, action, pending] = useActionState(
    changePasswordAction,
    initial
  );
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.ok) formRef.current?.reset();
  }, [state.ok]);

  return (
    <form ref={formRef} action={action} className="admin-users-form">
      <h3 className="admin-subtitle">Change password</h3>
      <label className="admin-field">
        <span className="admin-label">User</span>
        <select name="username" required className="admin-input">
          {usernames.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
      </label>
      <label className="admin-field">
        <span className="admin-label">New password</span>
        <input
          type="password"
          name="password"
          required
          autoComplete="new-password"
          className="admin-input"
        />
      </label>
      <button type="submit" disabled={pending} className="admin-button">
        {pending ? "Saving..." : "Update password"}
      </button>
      {state.error && (
        <p className="admin-note admin-note--error">{state.error}</p>
      )}
      {state.ok && <p className="admin-note">Password updated.</p>}
    </form>
  );
}

function DeleteButton({
  username,
  disabled,
}: {
  username: string;
  disabled: boolean;
}) {
  const [state, action, pending] = useActionState(deleteUserAction, initial);
  const [confirming, setConfirming] = useState(false);

  if (disabled) {
    return <span className="admin-muted">—</span>;
  }

  if (!confirming) {
    return (
      <button
        type="button"
        className="admin-button admin-button--ghost"
        onClick={() => setConfirming(true)}
      >
        Delete
      </button>
    );
  }

  return (
    <form action={action} className="admin-users-delete">
      <input type="hidden" name="username" value={username} />
      <button
        type="submit"
        disabled={pending}
        className="admin-button admin-button--danger"
      >
        {pending ? "Deleting..." : "Confirm"}
      </button>
      <button
        type="button"
        className="admin-button admin-button--ghost"
        onClick={() => setConfirming(false)}
      >
        Cancel
      </button>
      {state.error && (
        <p className="admin-note admin-note--error">{state.error}</p>
      )}
    </form>
  );
}

export default function AdminUsers({
  users,
  currentUser,
}: {
  users: AdminUserRow[];
  currentUser: string | null;
}) {
  const usernames = users.map((u) => u.username);

  return (
    <section className="admin-section">
      <h2 className="admin-subtitle">Admin users</h2>

      <table className="admin-table">
        <thead>
          <tr>
            <th>Username</th>
            <th>Created</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>
                {u.username}
                {currentUser === u.username && (
                  <span className="admin-muted"> (you)</span>
                )}
              </td>
              <td className="admin-muted">
                {new Date(u.created_at).toLocaleDateString()}
              </td>
              <td>
                <DeleteButton
                  username={u.username}
                  disabled={currentUser === u.username || users.length <= 1}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="admin-divider" />
      <div className="admin-users-grid">
        <CreateUser />
        {usernames.length > 0 && <ChangePassword usernames={usernames} />}
      </div>
    </section>
  );
}

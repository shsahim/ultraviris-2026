"use client";

import { useEffect, useState } from "react";

export default function Toast({ message }: { message: string }) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    // Remove the ?created= param from the URL (without a re-render) so the
    // toast doesn't reappear on refresh.
    const url = new URL(window.location.href);
    if (url.searchParams.has("created")) {
      url.searchParams.delete("created");
      window.history.replaceState(null, "", url.pathname + url.search);
    }

    const timer = setTimeout(() => setVisible(false), 4000);
    return () => clearTimeout(timer);
  }, []);

  if (!visible) {
    return null;
  }

  return (
    <div className="admin-toast" role="status">
      <span>{message}</span>
      <button
        type="button"
        className="admin-toast-close"
        aria-label="Dismiss"
        onClick={() => setVisible(false)}
      >
        ×
      </button>
    </div>
  );
}

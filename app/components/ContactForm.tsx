"use client";

import { useState } from "react";

type Status = "idle" | "sending" | "sent" | "error";

export default function ContactForm() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [company, setCompany] = useState(""); // honeypot; real users leave blank
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus("sending");
    setError("");

    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, message, company }),
      });
      const data = await res.json();

      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Something went wrong.");
      }

      setStatus("sent");
      setEmail("");
      setMessage("");
      setCompany("");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Something went wrong.");
    }
  }

  return (
    <form onSubmit={handleSubmit} className="contact-form">
      {/* Honeypot: hidden from users, ignored by them, often filled by bots. */}
      <div aria-hidden="true" style={{ position: "absolute", left: "-9999px" }}>
        <label htmlFor="company">Company</label>
        <input
          id="company"
          name="company"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
        />
      </div>

      <div className="contact-field">
        <label htmlFor="email" className="contact-label">
          Email
        </label>
        <input
          id="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          placeholder="you@example.com"
          className="contact-input"
        />
      </div>

      <div className="contact-field">
        <label htmlFor="message" className="contact-label">
          Message
        </label>
        <textarea
          id="message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          required
          maxLength={5000}
          placeholder="Write your message..."
          className="contact-textarea"
        />
      </div>

      <button
        type="submit"
        disabled={status === "sending"}
        className="contact-button"
      >
        {status === "sending" ? "Sending..." : "Send message"}
      </button>

      {status === "sent" && (
        <p className="contact-note">Thanks! Your message has been sent.</p>
      )}
      {status === "error" && (
        <p className="contact-note contact-note--error">{error}</p>
      )}
    </form>
  );
}

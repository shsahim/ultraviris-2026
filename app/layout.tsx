import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ultraviris-2026",
  description: "A very simple Next.js app",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

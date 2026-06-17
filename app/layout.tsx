import type { Metadata, Viewport } from "next";
import "./globals.css";
import { SITE_DESCRIPTION, SITE_NAME, SITE_URL } from "@/lib/site";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: `${SITE_NAME} — Fine Artist`,
    template: `%s — ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  authors: [{ name: "Natalie-Rose Nathan", url: SITE_URL }],
  creator: "Natalie-Rose Nathan",
  keywords: [
    "Natalie R Nathan",
    "Natalie-Rose Nathan",
    "fine artist",
    "paintings",
    "Los Angeles artist",
    "Otis College of Art and Design",
    "video editor",
    "producer",
    "contemporary art",
  ],
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    title: `${SITE_NAME} — Fine Artist`,
    description: SITE_DESCRIPTION,
    url: SITE_URL,
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: `${SITE_NAME} — Fine Artist`,
    description: SITE_DESCRIPTION,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
};

// Structured data so search engines understand who/what the site is about.
const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "@id": `${SITE_URL}/#website`,
      url: SITE_URL,
      name: SITE_NAME,
      description: SITE_DESCRIPTION,
      inLanguage: "en-US",
    },
    {
      "@type": "Person",
      "@id": `${SITE_URL}/#person`,
      name: "Natalie-Rose Nathan",
      alternateName: SITE_NAME,
      url: SITE_URL,
      jobTitle: ["Fine Artist", "Video Editor", "Producer", "Dancer", "Musician"],
      alumniOf: {
        "@type": "CollegeOrUniversity",
        name: "Otis College of Art and Design",
      },
      address: {
        "@type": "PostalAddress",
        addressLocality: "Los Angeles",
        addressRegion: "CA",
        addressCountry: "US",
      },
    },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        {children}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </body>
    </html>
  );
}

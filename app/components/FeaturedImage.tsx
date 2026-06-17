"use client";

import { useState } from "react";

export interface FeaturedCandidate {
  id: number;
  src: string;
  alt: string;
}

// Shows the first candidate image that loads. If one is missing (e.g. the file
// isn't in S3), it transparently advances to the next instead of rendering a
// broken-image icon.
export default function FeaturedImage({
  images,
}: {
  images: FeaturedCandidate[];
}) {
  const [i, setI] = useState(0);

  if (images.length === 0 || i >= images.length) {
    return (
      <p style={{ fontSize: "0.9rem", color: "#777777" }}>
        No active images found.
      </p>
    );
  }

  const img = images[i];
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={img.src}
      alt={img.alt}
      onError={() => setI((n) => n + 1)}
      style={{
        maxWidth: "100%",
        maxHeight: "75vh",
        height: "auto",
        objectFit: "contain",
      }}
    />
  );
}

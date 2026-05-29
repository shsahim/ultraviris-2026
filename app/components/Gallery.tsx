"use client";

import { useCallback, useEffect, useState } from "react";

export interface GalleryImage {
  id: number;
  title: string;
  src: string;
  description: string;
  width: number | null;
  height: number | null;
}

export default function Gallery({
  images,
  projectName,
}: {
  images: GalleryImage[];
  projectName: string;
}) {
  const [index, setIndex] = useState<number | null>(null);
  const open = index !== null;

  const close = useCallback(() => setIndex(null), []);
  const prev = useCallback(
    () =>
      setIndex((i) => (i === null ? i : (i - 1 + images.length) % images.length)),
    [images.length]
  );
  const next = useCallback(
    () => setIndex((i) => (i === null ? i : (i + 1) % images.length)),
    [images.length]
  );

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowLeft") prev();
      else if (e.key === "ArrowRight") next();
    }
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, close, prev, next]);

  // Preload the neighbouring images so paging through the carousel is instant.
  useEffect(() => {
    if (index === null || images.length < 2) return;
    const neighbours = [
      images[(index + 1) % images.length],
      images[(index - 1 + images.length) % images.length],
    ];
    for (const img of neighbours) {
      const preloader = new window.Image();
      preloader.src = img.src;
    }
  }, [index, images]);

  if (images.length === 0) {
    return <p style={{ color: "#777777" }}>No images in this project yet.</p>;
  }

  const current = index !== null ? images[index] : null;

  return (
    <>
      <div className="gallery-grid">
        {images.map((img, i) => (
          <button
            key={img.id}
            type="button"
            className="gallery-item"
            onClick={() => setIndex(i)}
            aria-label={img.title || "View image"}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={img.src}
              alt={img.title || projectName}
              loading="lazy"
              decoding="async"
              style={{
                aspectRatio:
                  img.width && img.height
                    ? `${img.width} / ${img.height}`
                    : undefined,
              }}
            />
          </button>
        ))}
      </div>

      {current && (
        <div
          className="gallery-lightbox"
          onClick={close}
          role="dialog"
          aria-modal="true"
        >
          <button
            type="button"
            className="gallery-close"
            onClick={(e) => {
              e.stopPropagation();
              close();
            }}
            aria-label="Close"
          >
            ×
          </button>

          {images.length > 1 && (
            <>
              <button
                type="button"
                className="gallery-arrow gallery-arrow--prev"
                onClick={(e) => {
                  e.stopPropagation();
                  prev();
                }}
                aria-label="Previous image"
              >
                ‹
              </button>
              <button
                type="button"
                className="gallery-arrow gallery-arrow--next"
                onClick={(e) => {
                  e.stopPropagation();
                  next();
                }}
                aria-label="Next image"
              >
                ›
              </button>
            </>
          )}

          <div
            className="gallery-lightbox-content"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="gallery-lightbox-image">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={current.src} alt={current.title || projectName} />
            </div>
            <div className="gallery-lightbox-info">
              <h3 className="gallery-info-title">
                {current.title || "Untitled"}
              </h3>
              {current.description && (
                <p className="gallery-info-desc">{current.description}</p>
              )}
              {current.width && current.height ? (
                <p className="gallery-info-meta">
                  {current.width} × {current.height} px
                </p>
              ) : null}
              <p className="gallery-info-count">
                {(index ?? 0) + 1} / {images.length}
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

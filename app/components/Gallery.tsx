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
  // Hide images that fail to load (e.g. missing from S3) so visitors never see
  // broken-image icons. Navigation operates on the still-visible set.
  const [brokenIds, setBrokenIds] = useState<Set<number>>(new Set());
  const visible = images.filter((img) => !brokenIds.has(img.id));
  const open = index !== null;

  const markBroken = useCallback((id: number) => {
    setBrokenIds((prev) => {
      const nextSet = new Set(prev);
      nextSet.add(id);
      return nextSet;
    });
  }, []);

  const close = useCallback(() => setIndex(null), []);
  const prev = useCallback(
    () =>
      setIndex((i) =>
        i === null ? i : (i - 1 + visible.length) % visible.length
      ),
    [visible.length]
  );
  const next = useCallback(
    () => setIndex((i) => (i === null ? i : (i + 1) % visible.length)),
    [visible.length]
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
    if (index === null || visible.length < 2) return;
    const neighbours = [
      visible[(index + 1) % visible.length],
      visible[(index - 1 + visible.length) % visible.length],
    ];
    for (const img of neighbours) {
      if (!img) continue;
      const preloader = new window.Image();
      preloader.src = img.src;
    }
  }, [index, visible]);

  if (visible.length === 0) {
    return <p style={{ color: "#777777" }}>No images in this project yet.</p>;
  }

  const current = index !== null ? visible[index] ?? null : null;

  return (
    <>
      <div className="gallery-grid">
        {visible.map((img, i) => (
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
              onError={() => markBroken(img.id)}
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

          {visible.length > 1 && (
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
              <img
                src={current.src}
                alt={current.title || projectName}
                onError={() => {
                  markBroken(current.id);
                  close();
                }}
              />
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
                {(index ?? 0) + 1} / {visible.length}
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

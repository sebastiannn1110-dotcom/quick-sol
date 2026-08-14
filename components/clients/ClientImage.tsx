"use client";

import { Building2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

type ClientImageProps = {
  logoUrl: string | null;
  authorizedIdentificationImageUrl: string | null;
  alt: string;
  className: string;
  imageClassName?: string;
  placeholderClassName?: string;
};

export default function ClientImage({
  logoUrl,
  authorizedIdentificationImageUrl,
  alt,
  className,
  imageClassName = "h-full w-full object-contain p-2",
  placeholderClassName = "h-12 w-12 text-slate-300"
}: ClientImageProps) {
  const sources = useMemo(
    () => Array.from(new Set(
      [logoUrl, authorizedIdentificationImageUrl].filter(
        (value): value is string => Boolean(value)
      )
    )),
    [authorizedIdentificationImageUrl, logoUrl]
  );
  const sourcesKey = sources.join("\u0000");
  const previousSourcesKey = useRef(sourcesKey);
  const [sourceIndex, setSourceIndex] = useState(0);
  const source = sources[sourceIndex] ?? null;
  const [loading, setLoading] = useState(Boolean(source));

  useEffect(() => {
    if (previousSourcesKey.current === sourcesKey) return;
    previousSourcesKey.current = sourcesKey;
    setSourceIndex(0);
    setLoading(sources.length > 0);
  }, [sources.length, sourcesKey]);

  function useFallback() {
    const nextIndex = sourceIndex + 1;
    setSourceIndex(nextIndex);
    setLoading(nextIndex < sources.length);
  }

  return (
    <div
      className={`relative overflow-hidden bg-white ${className}`}
      data-client-image-state={source ? (loading ? "loading" : "ready") : "placeholder"}
      data-testid="client-image"
    >
      {source ? (
        <>
          {loading ? (
            <span
              className="absolute inset-2 animate-pulse rounded bg-slate-100"
              aria-hidden="true"
            />
          ) : null}
          {/* Signed Supabase URLs are dynamic, so next/image cannot statically allow their host. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            key={source}
            src={source}
            alt={alt}
            className={`${imageClassName} transition-opacity ${loading ? "opacity-0" : "opacity-100"}`}
            loading="lazy"
            decoding="async"
            onLoad={() => setLoading(false)}
            onError={useFallback}
          />
        </>
      ) : (
        <span className="flex h-full w-full items-center justify-center" data-testid="client-image-placeholder">
          <Building2 className={placeholderClassName} aria-hidden="true" />
        </span>
      )}
    </div>
  );
}

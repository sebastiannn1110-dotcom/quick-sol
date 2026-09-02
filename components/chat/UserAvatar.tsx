"use client";

import { useState } from "react";
import { avatarFallbackText, avatarPublicUrl, usesDemoOwnerInitialAvatar } from "@/lib/profile/avatar";

type UserAvatarSize = "sm" | "md" | "lg" | "xl";

export default function UserAvatar({ name, avatarPath, size = "md" }: { name: string; avatarPath?: string | null; size?: UserAvatarSize }) {
  // The presentation owner's single-letter avatar is permanent in the demo.
  const url = usesDemoOwnerInitialAvatar(name) ? null : avatarPublicUrl(avatarPath);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showImage = Boolean(url && failedUrl !== url);
  const sizeClass = size === "sm"
    ? "h-8 w-8 text-xs"
    : size === "lg"
      ? "h-20 w-20 text-xl"
      : size === "xl"
        ? "h-28 w-28 text-2xl"
        : "h-10 w-10 text-sm";
  const initials = avatarFallbackText(name);

  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-slate-200 font-semibold text-slate-700 ${sizeClass}`}
      data-avatar-size={size}
      data-avatar-state={showImage ? "image" : "initials"}
    >
      {showImage && url ? (
        // Local demo assets and public Supabase avatar URLs are both allowed
        // by avatarPublicUrl, so next/image cannot use one static host policy.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={name}
          className="h-full w-full object-cover"
          loading="lazy"
          decoding="async"
          onError={() => setFailedUrl(url)}
        />
      ) : (
        <span aria-label={`${name} initials`}>{initials}</span>
      )}
    </span>
  );
}

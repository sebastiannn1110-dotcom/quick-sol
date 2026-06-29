"use client";

import { avatarPublicUrl } from "@/lib/profile/avatar";

export default function UserAvatar({ name, avatarPath, size = "md" }: { name: string; avatarPath?: string | null; size?: "sm" | "md" | "lg" }) {
  const url = avatarPublicUrl(avatarPath);
  const sizeClass = size === "sm" ? "h-8 w-8 text-xs" : size === "lg" ? "h-20 w-20 text-xl" : "h-10 w-10 text-sm";
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "QS";
  return (
    <span
      aria-label={name}
      className={`inline-flex shrink-0 items-center justify-center rounded-full bg-slate-200 bg-cover bg-center font-semibold text-slate-700 ${sizeClass}`}
      style={url ? { backgroundImage: `url("${url.replace(/"/g, "%22")}")` } : undefined}
    >
      {url ? <span className="sr-only">{initials}</span> : initials}
    </span>
  );
}

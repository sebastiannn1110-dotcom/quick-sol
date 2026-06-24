"use client";

import { useEffect, useState } from "react";
import type { Profile, UserRole } from "@/lib/types";

export default function RoleGuard({
  allowedRoles,
  children
}: {
  allowedRoles: UserRole[];
  children: React.ReactNode;
}) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadProfile() {
      const response = await fetch("/api/me", { cache: "no-store" });
      if (response.ok) {
        const payload = (await response.json()) as { profile: Profile };
        setProfile(payload.profile);
      }
      setLoading(false);
    }

    loadProfile();
  }, []);

  if (loading) {
    return <div className="rounded-md bg-white p-6 text-sm text-slate-500 shadow-sm">Checking permissions...</div>;
  }

  if (!profile || !allowedRoles.includes(profile.role)) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        You do not have permission to access this area.
      </div>
    );
  }

  return <>{children}</>;
}

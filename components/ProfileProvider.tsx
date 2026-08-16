"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import type { Profile } from "@/lib/types";

type ProfileContextValue = {
  profile: Profile | null;
  loading: boolean;
  refreshProfile: () => Promise<void>;
};

const ProfileContext = createContext<ProfileContextValue | null>(null);
const PUBLIC_PATHS = new Set(["/login", "/forgot-password", "/reset-password"]);

export function ProfileProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const disabled = PUBLIC_PATHS.has(pathname);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(!disabled);

  const refreshProfile = useCallback(async () => {
    if (disabled) {
      setProfile(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const response = await fetch("/api/me", { cache: "no-store" });
      if (!response.ok) {
        setProfile(null);
        return;
      }
      const payload = (await response.json()) as { profile: Profile };
      setProfile(payload.profile);
    } finally {
      setLoading(false);
    }
  }, [disabled]);

  useEffect(() => {
    void refreshProfile();
    // Profile is shared for the current authenticated shell. A route change does
    // not need another /api/me round-trip.
  }, [refreshProfile]);

  const value = useMemo(() => ({ profile, loading, refreshProfile }), [profile, loading, refreshProfile]);
  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>;
}

export function useProfile() {
  const context = useContext(ProfileContext);
  if (!context) throw new Error("useProfile must be used inside ProfileProvider");
  return context;
}

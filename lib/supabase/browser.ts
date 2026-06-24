"use client";

import { createBrowserClient } from "@supabase/ssr";
import { getSupabasePublishableKey } from "@/lib/security/env";

export function createSupabaseBrowserClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = getSupabasePublishableKey();

  if (!url || !publishableKey) {
    return null;
  }

  return createBrowserClient(url, publishableKey);
}

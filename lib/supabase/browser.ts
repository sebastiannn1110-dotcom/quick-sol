"use client";

import { createBrowserClient } from "@supabase/ssr";
import { getSupabasePublishableKey } from "@/lib/security/env";

export interface SupabaseBrowserConfig {
  url: string;
  publishableKey: string;
}

export function createSupabaseBrowserClient(config?: SupabaseBrowserConfig) {
  const url = config?.url ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = config?.publishableKey ?? getSupabasePublishableKey();

  if (!url || !publishableKey) {
    return null;
  }

  return createBrowserClient(url, publishableKey);
}

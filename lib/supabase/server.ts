import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { serverSupabaseClientOptions } from "@/lib/supabase/node-client-options";
import {
  getSupabasePublishableKey,
  getSupabaseServiceRoleKey,
  isServiceRoleConfigured,
  isSupabaseConfigured
} from "@/lib/security/env";

export async function createSupabaseServerClient() {
  if (!isSupabaseConfigured()) return null;

  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    getSupabasePublishableKey(),
    {
      realtime: serverSupabaseClientOptions().realtime,
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options);
            });
          } catch {
            // Server Components cannot always set cookies. Route handlers can.
          }
        }
      }
    }
  );
}

export function createSupabaseServiceRoleClient() {
  if (!isServiceRoleConfigured()) return null;

  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    getSupabaseServiceRoleKey(),
    serverSupabaseClientOptions()
  );
}

export function createSupabaseAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = getSupabaseServiceRoleKey();

  if (!supabaseUrl || !serviceRoleKey) return null;

  return createClient(supabaseUrl, serviceRoleKey, serverSupabaseClientOptions());
}

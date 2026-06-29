import { describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { serverSupabaseClientOptions } from "@/lib/supabase/node-client-options";

describe("serverSupabaseClientOptions", () => {
  it("lets server-only Supabase clients be created without native WebSocket", () => {
    const client = createClient(
      "https://example.supabase.co",
      "sb_publishable_test",
      serverSupabaseClientOptions()
    );

    expect(client.from).toEqual(expect.any(Function));
  });
});

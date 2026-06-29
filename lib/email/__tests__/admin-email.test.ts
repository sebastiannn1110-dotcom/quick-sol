import { describe, expect, it } from "vitest";
import { adminEmailSendSchema } from "@/lib/email/admin-email";
import { adminMessageHtml, escapeHtml } from "@/lib/email/content";

describe("admin email center", () => {
  it("requires a server-resolved recipient selector", () => {
    const result = adminEmailSendSchema.safeParse({ subject: "Important update", body: "Message", userIds: [] });
    expect(result.success).toBe(false);
  });

  it("accepts role and explicit profile selectors", () => {
    expect(adminEmailSendSchema.safeParse({ subject: "Important update", body: "Message", roles: ["employee"] }).success).toBe(true);
    expect(adminEmailSendSchema.safeParse({ subject: "Important update", body: "Message", userIds: ["00000000-0000-4000-8000-000000000001"] }).success).toBe(true);
  });

  it("escapes administrator supplied HTML", () => {
    expect(escapeHtml("<script>alert(1)</script>")).not.toContain("<script>");
    expect(adminMessageHtml({ subject: "<b>Title</b>", body: "Hello <img>", senderName: "Admin" })).not.toContain("<img>");
  });
});

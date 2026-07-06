import { describe, expect, it } from "vitest";
import { adminEmailSendSchema } from "@/lib/email/admin-email";
import { validateAdminEmailAttachment } from "@/lib/email/attachments";
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

  it("accepts manual external recipients and multiple emails", () => {
    const result = adminEmailSendSchema.safeParse({
      subject: "Weekly report",
      body: "Attached report",
      manualEmails: ["buyer@example.com", "ops@example.com"]
    });
    expect(result.success).toBe(true);
  });

  it("accepts simple console payload recipients alias", () => {
    const result = adminEmailSendSchema.safeParse({
      recipients: ["sebastiannn1110@gmail.com"],
      subject: "Prueba Quiksol Email Center",
      body: "Correo de prueba enviado desde consola.",
      attachments: []
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.manualEmails).toEqual(["sebastiannn1110@gmail.com"]);
  });

  it("validates safe email attachments", () => {
    const file = new File(["hello"], "report.csv", { type: "text/csv" });
    const blocked = new File(["x"], "script.exe", { type: "application/x-msdownload" });
    expect(validateAdminEmailAttachment(file).valid).toBe(true);
    expect(validateAdminEmailAttachment(blocked).valid).toBe(false);
  });

  it("escapes administrator supplied HTML", () => {
    expect(escapeHtml("<script>alert(1)</script>")).not.toContain("<script>");
    expect(adminMessageHtml({ subject: "<b>Title</b>", body: "Hello <img>", senderName: "Admin" })).not.toContain("<img>");
  });
});

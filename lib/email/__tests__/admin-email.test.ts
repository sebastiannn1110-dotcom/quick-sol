import { describe, expect, it, vi } from "vitest";
import { adminEmailSendSchema, resolveAdminEmailRecipients } from "@/lib/email/admin-email";
import { validateAdminEmailAttachment } from "@/lib/email/attachments";
import { adminMessageHtml, escapeHtml } from "@/lib/email/content";
import {
  ELECTRONIC_PARTS_DEMO_EMPLOYEE_EMAILS,
  ELECTRONIC_PARTS_DEMO_OWNER_EMAIL,
  ELECTRONIC_PARTS_DEMO_SEED_MARKER
} from "@/lib/demo/employee-scope";

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

  it("resolves profile recipients only from the canonical 19-person demo scope", async () => {
    const retained = ELECTRONIC_PARTS_DEMO_EMPLOYEE_EMAILS.map((email, index) => ({
      id: `retained-${index}`,
      full_name: `Retained ${index}`,
      email,
      role: "employee",
      department: "Sales",
      region: "Global",
      bio: ELECTRONIC_PARTS_DEMO_SEED_MARKER,
      is_active: true
    }));
    const rows = [
      ...retained,
      ...Array.from({ length: 107 }, (_, index) => ({
        ...retained[0],
        id: `historical-${index}`,
        email: `historical-${index}@example.com`,
        bio: null
      })),
      { ...retained[0], id: "owner", full_name: "user.test.demo.com", email: ELECTRONIC_PARTS_DEMO_OWNER_EMAIL }
    ];
    expect(rows).toHaveLength(127);

    const query = {
      select: vi.fn(),
      eq: vi.fn(),
      in: vi.fn(),
      order: vi.fn(),
      limit: vi.fn(),
      then: (resolve: (value: { data: typeof rows; error: null }) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve)
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.in.mockReturnValue(query);
    query.order.mockReturnValue(query);
    query.limit.mockReturnValue(query);
    const supabase = { from: vi.fn(() => query) };

    const recipients = await resolveAdminEmailRecipients(
      supabase as never,
      { userIds: [], manualEmails: [], allEmployees: true, roles: [], department: null, region: null }
    );

    expect(recipients).toHaveLength(19);
    expect(recipients.map((recipient) => recipient.email)).toEqual(ELECTRONIC_PARTS_DEMO_EMPLOYEE_EMAILS);
    expect(recipients.some((recipient) => recipient.email === ELECTRONIC_PARTS_DEMO_OWNER_EMAIL)).toBe(false);
  });
});

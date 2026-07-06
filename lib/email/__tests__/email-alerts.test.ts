import { afterEach, describe, expect, it, vi } from "vitest";
import { getEmailProvider, getEmailProviderDiagnostics, sendEmail } from "@/lib/email/email-service";
import { shouldSendAlert } from "@/lib/email/evaluate-alert-rules";

describe("email alerts", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("uses mock mode when no provider is configured", async () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    delete process.env.ENABLE_EMAIL_ALERTS;

    expect(getEmailProvider()).toBe("mock");
    const result = await sendEmail({
      to: ["admin@example.com"],
      subject: "Test",
      html: "<p>Hello</p>"
    });
    expect(result.status).toBe("skipped");
    expect(result.errorMessage).toContain("mock");
  });

  it("reports resend diagnostics without exposing secrets", () => {
    process.env.RESEND_API_KEY = "secret-test-key";
    process.env.EMAIL_FROM = "Quiksol Alerts <onboarding@resend.dev>";
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    delete process.env.ENABLE_EMAIL_ALERTS;

    const diagnostics = getEmailProviderDiagnostics();
    expect(diagnostics.provider).toBe("resend");
    expect(diagnostics.hasResendApiKey).toBe(true);
    expect(diagnostics.emailFrom).toBe("Quiksol Alerts <onboarding@resend.dev>");
    expect(diagnostics.warnings.join(" ")).toContain("onboarding@resend.dev");
    expect(JSON.stringify(diagnostics)).not.toContain("secret-test-key");
  });

  it("logs real resend errors", async () => {
    process.env.RESEND_API_KEY = "secret-test-key";
    process.env.EMAIL_FROM = "Quiksol Alerts <onboarding@resend.dev>";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      name: "validation_error",
      message: "You can only send testing emails to your own email address"
    }), { status: 403 }));

    const result = await sendEmail({
      to: ["person@example.com"],
      subject: "Test",
      html: "<p>Hello</p>"
    });
    expect(result.provider).toBe("resend");
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("testing emails");
    vi.restoreAllMocks();
  });

  it("sends upload_has_many_errors when threshold is exceeded", () => {
    expect(
      shouldSendAlert(
        {
          enabled: true,
          event_type: "upload_has_many_errors",
          condition_type: "error_count_gt",
          condition_value: 200
        },
        { eventType: "upload_has_many_errors", errorCount: 245 }
      )
    ).toBe(true);
  });

  it("sends low_gp_rate when rate is below percentage threshold", () => {
    expect(
      shouldSendAlert(
        {
          enabled: true,
          event_type: "low_gp_rate",
          condition_type: "gp_rate_lt",
          condition_value: 15
        },
        { eventType: "low_gp_rate", lowGpRate: 0.12 }
      )
    ).toBe(true);
  });
});

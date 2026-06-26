import { afterEach, describe, expect, it } from "vitest";
import { getEmailProvider, sendEmail } from "@/lib/email/email-service";
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

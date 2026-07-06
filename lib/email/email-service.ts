export type EmailProvider = "resend" | "smtp" | "mock" | "disabled";
export type EmailStatus = "sent" | "failed" | "skipped" | "pending";

export interface SendEmailInput {
  to: string[];
  subject: string;
  html: string;
  text?: string;
  attachments?: Array<{
    filename: string;
    contentBase64: string;
    contentType: string;
  }>;
}

export interface SendEmailResult {
  provider: EmailProvider;
  status: EmailStatus;
  messageId?: string;
  errorMessage?: string;
}

export interface EmailProviderDiagnostics {
  provider: EmailProvider;
  hasResendApiKey: boolean;
  hasSmtpConfig: boolean;
  emailFrom: string;
  canSendRealEmail: boolean;
  warnings: string[];
}

function compactText(html: string) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function senderDomainFromAddress(address: string) {
  const match = address.match(/<[^@\s<>]+@([^>\s]+)>/) ?? address.match(/[^@\s<>]+@([^>\s<>]+)/);
  return match?.[1]?.toLowerCase() ?? null;
}

export function getEmailProvider(): EmailProvider {
  if (process.env.ENABLE_EMAIL_ALERTS === "false") return "disabled";
  if (process.env.RESEND_API_KEY) return "resend";
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) return "smtp";
  return "mock";
}

export function getEmailFromAddress() {
  return process.env.EMAIL_FROM || process.env.SMTP_FROM || "Quiksol Alerts <alerts@quiksol.local>";
}

export function getEmailProviderDiagnostics(): EmailProviderDiagnostics {
  const provider = getEmailProvider();
  const emailFrom = getEmailFromAddress();
  const senderDomain = senderDomainFromAddress(emailFrom);
  const hasResendApiKey = Boolean(process.env.RESEND_API_KEY);
  const hasSmtpConfig = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
  const warnings: string[] = [];

  if (provider === "mock") warnings.push("Email provider is mock; no real email was sent.");
  if (provider === "disabled") warnings.push("Email provider disabled; no real email was sent.");
  if (provider === "resend" && emailFrom.includes("onboarding@resend.dev")) {
    warnings.push("Using onboarding@resend.dev may be limited. Verify a custom domain in Resend for production delivery.");
  }
  if (provider === "resend" && senderDomain === "tudominio.com") {
    warnings.push("EMAIL_FROM uses the placeholder domain tudominio.com. Replace it with a verified Resend domain before sending real email.");
  }
  if ((provider === "resend" || provider === "smtp") && senderDomain?.endsWith(".local")) {
    warnings.push("EMAIL_FROM/SMTP_FROM uses a local sender domain. Use a real verified sender domain for production delivery.");
  }
  if ((provider === "resend" || provider === "smtp") && !emailFrom.includes("@")) {
    warnings.push("EMAIL_FROM/SMTP_FROM does not look like a valid email sender.");
  }

  return {
    provider,
    hasResendApiKey,
    hasSmtpConfig,
    emailFrom,
    canSendRealEmail: provider === "resend" || provider === "smtp",
    warnings
  };
}

async function sendWithResend(input: SendEmailInput): Promise<SendEmailResult> {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: getEmailFromAddress(),
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text ?? compactText(input.html),
      attachments: input.attachments?.map((attachment) => ({
        filename: attachment.filename,
        content: attachment.contentBase64,
        content_type: attachment.contentType
      }))
    })
  });
  const payload = (await response.json().catch(() => null)) as {
    id?: string;
    message?: string;
    error?: string;
    name?: string;
  } | null;
  if (!response.ok) {
    const details = [payload?.name, payload?.message, payload?.error].filter(Boolean).join(": ");
    return {
      provider: "resend",
      status: "failed",
      errorMessage: details || `Resend failed with status ${response.status}`
    };
  }
  return { provider: "resend", status: "sent", messageId: payload?.id };
}

async function sendWithSmtp(input: SendEmailInput): Promise<SendEmailResult> {
  const nodemailer = await import("nodemailer");
  const port = Number(process.env.SMTP_PORT || 587);
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
  const result = await transport.sendMail({
    from: getEmailFromAddress(),
    to: input.to.join(", "),
    subject: input.subject,
    html: input.html,
    text: input.text ?? compactText(input.html),
    attachments: input.attachments?.map((attachment) => ({
      filename: attachment.filename,
      content: Buffer.from(attachment.contentBase64, "base64"),
      contentType: attachment.contentType
    }))
  });
  return { provider: "smtp", status: "sent", messageId: result.messageId };
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const provider = getEmailProvider();
  const diagnostics = getEmailProviderDiagnostics();
  console.info("email_provider_selected", {
    provider,
    emailFrom: diagnostics.emailFrom,
    recipientCount: input.to.length,
    canSendRealEmail: diagnostics.canSendRealEmail,
    warnings: diagnostics.warnings
  });
  if (provider === "disabled") {
    console.warn("email_send_skipped", { provider, reason: "Email provider disabled; no real email was sent." });
    return { provider, status: "skipped", errorMessage: "Email provider disabled; no real email was sent." };
  }
  if (!input.to.length) {
    console.warn("email_send_skipped", { provider, reason: "No email recipients were provided." });
    return { provider, status: "skipped", errorMessage: "No email recipients were provided." };
  }
  if (provider === "mock") {
    console.warn("email_send_skipped", { provider, reason: "Email provider is mock; no real email was sent." });
    return {
      provider,
      status: "skipped",
      messageId: `mock-${Date.now()}`,
      errorMessage: "Email provider is mock; no real email was sent."
    };
  }

  try {
    console.info("email_send_started", { provider, emailFrom: diagnostics.emailFrom, recipientCount: input.to.length });
    const result = provider === "resend" ? await sendWithResend(input) : await sendWithSmtp(input);
    if (result.status === "sent") {
      console.info("email_sent", { provider, messageId: result.messageId, recipientCount: input.to.length });
    } else {
      console.error("email_failed", { provider, errorMessage: result.errorMessage, recipientCount: input.to.length });
    }
    return result;
  } catch (error) {
    console.error("email_failed", {
      provider,
      errorMessage: error instanceof Error ? error.message : "Email provider failed.",
      recipientCount: input.to.length
    });
    return {
      provider,
      status: "failed",
      errorMessage: error instanceof Error ? error.message : "Email provider failed."
    };
  }
}

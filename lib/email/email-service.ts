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

function compactText(html: string) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
  if (provider === "disabled") return { provider, status: "skipped", errorMessage: "Email alerts are disabled." };
  if (!input.to.length) return { provider, status: "skipped", errorMessage: "No email recipients were provided." };
  if (provider === "mock") {
    return {
      provider,
      status: "skipped",
      messageId: `mock-${Date.now()}`,
      errorMessage: "No email provider configured; email was logged as mock."
    };
  }

  try {
    if (provider === "resend") return await sendWithResend(input);
    return await sendWithSmtp(input);
  } catch (error) {
    return {
      provider,
      status: "failed",
      errorMessage: error instanceof Error ? error.message : "Email provider failed."
    };
  }
}

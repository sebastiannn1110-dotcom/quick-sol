import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { adminMessageHtml } from "@/lib/email/content";
import { sendEmail, type SendEmailResult } from "@/lib/email/email-service";
import type { EmailAttachmentPayload } from "@/lib/email/attachments";

export const adminEmailSendSchema = z.object({
  subject: z.string().trim().min(3).max(180),
  body: z.string().trim().min(2).max(10_000),
  userIds: z.array(z.string().uuid()).max(250).default([]),
  manualEmails: z.array(z.string().email()).max(250).default([]),
  allEmployees: z.boolean().default(false),
  roles: z.array(z.enum(["admin", "manager", "employee"])).max(3).default([]),
  department: z.string().trim().max(100).optional().nullable(),
  region: z.string().trim().max(100).optional().nullable(),
  templateId: z.string().trim().max(80).optional().nullable()
}).refine(
  (value) => value.allEmployees || value.userIds.length > 0 || value.manualEmails.length > 0 || value.roles.length > 0 || Boolean(value.department) || Boolean(value.region),
  { message: "Selecciona al menos un destinatario." }
);

export interface AdminEmailRecipient {
  id: string;
  full_name: string;
  email: string;
  role: "admin" | "manager" | "employee";
  department: string | null;
  region: string | null;
  source?: "profile" | "manual";
}

export async function resolveAdminEmailRecipients(
  supabase: SupabaseClient,
  selector: Pick<z.infer<typeof adminEmailSendSchema>, "userIds" | "manualEmails" | "allEmployees" | "roles" | "department" | "region">
) {
  const manualRecipients: AdminEmailRecipient[] = Array.from(new Set(selector.manualEmails.map((email) => email.toLowerCase()))).map((email) => ({
    id: `manual:${email}`,
    full_name: email,
    email,
    role: "employee",
    department: null,
    region: null,
    source: "manual"
  }));

  if (!selector.allEmployees && !selector.userIds.length && !selector.roles.length && !selector.department && !selector.region) {
    return manualRecipients;
  }

  let query = supabase
    .from("profiles")
    .select("id, full_name, email, role, department, region")
    .eq("is_active", true)
    .order("full_name")
    .limit(250);

  if (selector.allEmployees) query = query.eq("role", "employee");
  else if (selector.userIds.length) query = query.in("id", selector.userIds);
  else {
    if (selector.roles.length) query = query.in("role", selector.roles);
    if (selector.department) query = query.eq("department", selector.department);
    if (selector.region) query = query.eq("region", selector.region);
  }

  const { data, error } = await query;
  if (error) throw error;
  const profileRecipients = ((data ?? []).filter((profile) => Boolean(profile.email)) as AdminEmailRecipient[]).map((recipient) => ({ ...recipient, source: "profile" as const }));
  const byEmail = new Map<string, AdminEmailRecipient>();
  for (const recipient of [...profileRecipients, ...manualRecipients]) byEmail.set(recipient.email.toLowerCase(), recipient);
  return Array.from(byEmail.values());
}

export async function sendAdminEmailToRecipients(input: {
  recipients: AdminEmailRecipient[];
  subject: string;
  body: string;
  senderName: string;
  attachments?: EmailAttachmentPayload[];
}) {
  const html = adminMessageHtml({ subject: input.subject, body: input.body, senderName: input.senderName });
  const results: Array<{ recipient: AdminEmailRecipient; result: SendEmailResult }> = [];

  for (let start = 0; start < input.recipients.length; start += 8) {
    const chunk = input.recipients.slice(start, start + 8);
    const sent = await Promise.all(
      chunk.map(async (recipient) => ({
        recipient,
        result: await sendEmail({
          to: [recipient.email],
          subject: input.subject,
          html,
          text: input.body,
          attachments: input.attachments?.map((attachment) => ({
            filename: attachment.filename,
            contentBase64: attachment.contentBase64,
            contentType: attachment.contentType
          }))
        })
      }))
    );
    results.push(...sent);
  }

  return results;
}

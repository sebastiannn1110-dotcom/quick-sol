import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { adminMessageHtml } from "@/lib/email/content";
import { sendEmail, type SendEmailResult } from "@/lib/email/email-service";

export const adminEmailSendSchema = z.object({
  subject: z.string().trim().min(3).max(180),
  body: z.string().trim().min(2).max(10_000),
  userIds: z.array(z.string().uuid()).max(100).default([]),
  allEmployees: z.boolean().default(false),
  roles: z.array(z.enum(["admin", "manager", "employee"])).max(3).default([]),
  department: z.string().trim().max(100).optional().nullable(),
  region: z.string().trim().max(100).optional().nullable(),
  templateId: z.string().trim().max(80).optional().nullable()
}).refine(
  (value) => value.allEmployees || value.userIds.length > 0 || value.roles.length > 0 || Boolean(value.department) || Boolean(value.region),
  { message: "Selecciona al menos un destinatario." }
);

export interface AdminEmailRecipient {
  id: string;
  full_name: string;
  email: string;
  role: "admin" | "manager" | "employee";
  department: string | null;
  region: string | null;
}

export async function resolveAdminEmailRecipients(
  supabase: SupabaseClient,
  selector: Pick<z.infer<typeof adminEmailSendSchema>, "userIds" | "allEmployees" | "roles" | "department" | "region">
) {
  let query = supabase
    .from("profiles")
    .select("id, full_name, email, role, department, region")
    .eq("is_active", true)
    .order("full_name")
    .limit(100);

  if (selector.allEmployees) query = query.eq("role", "employee");
  else if (selector.userIds.length) query = query.in("id", selector.userIds);
  else {
    if (selector.roles.length) query = query.in("role", selector.roles);
    if (selector.department) query = query.eq("department", selector.department);
    if (selector.region) query = query.eq("region", selector.region);
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).filter((profile) => Boolean(profile.email)) as AdminEmailRecipient[];
}

export async function sendAdminEmailToRecipients(input: {
  recipients: AdminEmailRecipient[];
  subject: string;
  body: string;
  senderName: string;
}) {
  const html = adminMessageHtml({ subject: input.subject, body: input.body, senderName: input.senderName });
  const results: Array<{ recipient: AdminEmailRecipient; result: SendEmailResult }> = [];

  for (let start = 0; start < input.recipients.length; start += 8) {
    const chunk = input.recipients.slice(start, start + 8);
    const sent = await Promise.all(
      chunk.map(async (recipient) => ({
        recipient,
        result: await sendEmail({ to: [recipient.email], subject: input.subject, html, text: input.body })
      }))
    );
    results.push(...sent);
  }

  return results;
}

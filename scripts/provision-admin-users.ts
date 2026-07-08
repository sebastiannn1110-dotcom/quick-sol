import fs from "node:fs";
import path from "node:path";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { serverSupabaseClientOptions } from "../lib/supabase/node-client-options";

type AdminSeed = {
  email: string;
  password: string;
  fullName: string;
  department: string;
  region: string;
};

const ADMINS: AdminSeed[] = [
  {
    email: "admin@quiksol.local",
    password: "Quiksol.Admin.2026!",
    fullName: "Quiksol Admin",
    department: "Operations",
    region: "Global"
  },
  {
    email: "braian@admin.quiksol",
    password: "password.braian",
    fullName: "Braian Admin",
    department: "Administration",
    region: "Global"
  }
];

function loadEnvFile(fileName: string) {
  const filePath = path.resolve(process.cwd(), fileName);
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separator = line.indexOf("=");
    if (separator <= 0) continue;

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] ??= value;
  }
}

function getServiceClient() {
  loadEnvFile(".env.local");
  loadEnvFile(".env");

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/SUPABASE_SECRET_KEY.");
  }

  return createClient(supabaseUrl, serviceRoleKey, serverSupabaseClientOptions());
}

function getPublicClient() {
  loadEnvFile(".env.local");
  loadEnvFile(".env");

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !publishableKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY/NEXT_PUBLIC_SUPABASE_ANON_KEY.");
  }

  return createClient(supabaseUrl, publishableKey, serverSupabaseClientOptions());
}

async function findUserByEmail(supabase: SupabaseClient, email: string) {
  const normalizedEmail = email.toLowerCase();
  let page = 1;
  const perPage = 1000;

  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`Unable to list Supabase users: ${error.message}`);

    const user = data.users.find((item) => item.email?.toLowerCase() === normalizedEmail);
    if (user) return user;
    if (data.users.length < perPage) return null;

    page += 1;
  }
}

async function upsertProfile(supabase: SupabaseClient, user: User, admin: AdminSeed) {
  const { error } = await supabase.from("profiles").upsert({
    id: user.id,
    full_name: admin.fullName,
    email: admin.email,
    role: "admin",
    department: admin.department,
    region: admin.region,
    is_active: true
  });

  if (error) throw new Error(`Unable to upsert profile for ${admin.email}: ${error.message}`);
}

async function provisionAdmin(supabase: SupabaseClient, admin: AdminSeed) {
  const existingUser = await findUserByEmail(supabase, admin.email);

  if (existingUser) {
    const { data, error } = await supabase.auth.admin.updateUserById(existingUser.id, {
      email: admin.email,
      password: admin.password,
      email_confirm: true,
      user_metadata: {
        full_name: admin.fullName,
        role: "admin",
        department: admin.department,
        region: admin.region
      }
    });

    if (error || !data.user) {
      throw new Error(`Unable to update admin ${admin.email}: ${error?.message ?? "missing user"}`);
    }

    await upsertProfile(supabase, data.user, admin);
    return "updated";
  }

  const { data, error } = await supabase.auth.admin.createUser({
    email: admin.email,
    password: admin.password,
    email_confirm: true,
    user_metadata: {
      full_name: admin.fullName,
      role: "admin",
      department: admin.department,
      region: admin.region
    }
  });

  if (error || !data.user) {
    throw new Error(`Unable to create admin ${admin.email}: ${error?.message ?? "missing user"}`);
  }

  await upsertProfile(supabase, data.user, admin);
  return "created";
}

async function verifyAdminLogin(supabase: SupabaseClient, admin: AdminSeed) {
  const { error } = await supabase.auth.signInWithPassword({
    email: admin.email,
    password: admin.password
  });

  if (error) throw new Error(`Login verification failed for ${admin.email}: ${error.message}`);

  await supabase.auth.signOut();
  console.log(`verified: ${admin.email} login ok`);
}

async function main() {
  const supabase = getServiceClient();

  for (const admin of ADMINS) {
    const action = await provisionAdmin(supabase, admin);
    console.log(`${action}: ${admin.email} -> admin`);
  }

  if (process.argv.includes("--verify-login")) {
    const publicClient = getPublicClient();
    for (const admin of ADMINS) {
      await verifyAdminLogin(publicClient, admin);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

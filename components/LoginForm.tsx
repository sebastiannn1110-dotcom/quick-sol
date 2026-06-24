"use client";

import { FormEvent, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { clientLogger } from "@/lib/logger/clientLogger";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

export default function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirect = searchParams.get("redirect") ?? "/dashboard";
  const setupError = searchParams.get("error");
  const supabase = createSupabaseBrowserClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(
    setupError === "inactive_user"
      ? "Your user is inactive. Contact an admin."
      : setupError === "supabase_not_configured"
        ? "Supabase environment variables are missing."
        : null
  );

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) {
      setError("Supabase is not configured. Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.");
      return;
    }

    setLoading(true);
    setError(null);
    setMessage(null);

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password
    });

    setLoading(false);

    if (signInError) {
      clientLogger.loginFailed({ email, reason: signInError.message });
      setError("Invalid credentials or inactive account.");
      return;
    }

    clientLogger.loginSuccess({ email });
    router.replace(redirect);
    router.refresh();
  }

  async function handleReset() {
    if (!supabase || !email) {
      setError("Enter your email before requesting a password reset.");
      return;
    }

    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/login`
    });

    if (resetError) setError("Unable to send reset email.");
    else {
      clientLogger.passwordResetRequested({ email });
      setMessage("Password reset email sent.");
    }
  }

  return (
    <div className="w-full max-w-md rounded-md border border-slate-200 bg-white p-6 shadow-soft">
      <div className="mb-6">
        <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-md bg-brand-600 text-sm font-bold text-white">
          QS
        </div>
        <p className="text-sm font-medium text-brand-700">Quiksol Data Intelligence Platform</p>
        <h1 className="mt-1 text-2xl font-semibold text-slate-950">Sign in</h1>
      </div>

      {!supabase ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          Supabase is not configured. Create `.env.local` with the required Supabase variables to
          enable secure login.
        </div>
      ) : null}

      <form onSubmit={handleSubmit} className="mt-5 grid gap-4">
        <label className="grid gap-1 text-sm font-medium text-slate-700">
          Email
          <input
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="focus-ring rounded-md border border-slate-300 px-3 py-2.5 font-normal text-slate-950"
            placeholder="employee@quiksol.com"
          />
        </label>
        <label className="grid gap-1 text-sm font-medium text-slate-700">
          Password
          <input
            type="password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="focus-ring rounded-md border border-slate-300 px-3 py-2.5 font-normal text-slate-950"
            placeholder="Your password"
          />
        </label>

        {message ? <p className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-700">{message}</p> : null}
        {error ? <p className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}

        <button
          disabled={loading || !supabase}
          className="focus-ring rounded-md bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
          type="submit"
        >
          {loading ? "Signing in..." : "Sign in"}
        </button>
        <button
          type="button"
          onClick={handleReset}
          className="text-sm font-medium text-slate-600 hover:text-slate-950"
        >
          Send password reset email
        </button>
      </form>
    </div>
  );
}

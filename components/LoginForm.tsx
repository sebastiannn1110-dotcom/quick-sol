"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { clientLogger } from "@/lib/logger/clientLogger";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import LanguageToggle from "@/components/LanguageToggle";
import { useLanguage } from "@/components/LanguageProvider";

export default function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t } = useLanguage();
  const redirect = searchParams.get("redirect") ?? "/dashboard";
  const setupError = searchParams.get("error");
  const [supabase, setSupabase] = useState(() => createSupabaseBrowserClient());
  const [configLoading, setConfigLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(
    setupError === "inactive_user"
      ? t("auth.inactive")
      : setupError === "supabase_not_configured"
        ? t("auth.envMissing")
        : null
  );

  useEffect(() => {
    if (setupError === "inactive_user") setError(t("auth.inactive"));
    else if (setupError === "supabase_not_configured") setError(t("auth.envMissing"));
  }, [setupError, t]);

  useEffect(() => {
    async function loadRuntimeConfig() {
      try {
        const response = await fetch("/api/auth/public-config", { cache: "no-store" });
        if (!response.ok) {
          setSupabase(null);
          return;
        }
        const config = (await response.json()) as {
          configured: boolean;
          supabaseUrl?: string;
          supabasePublishableKey?: string;
        };
        if (config.configured && config.supabaseUrl && config.supabasePublishableKey) {
          setSupabase(
            createSupabaseBrowserClient({
              url: config.supabaseUrl,
              publishableKey: config.supabasePublishableKey
            })
          );
        } else {
          setSupabase(null);
        }
      } finally {
        setConfigLoading(false);
      }
    }

    loadRuntimeConfig();
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (configLoading) {
      setError(t("auth.configLoading"));
      return;
    }
    if (!supabase) {
      setError(t("auth.supabaseMissing"));
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
      setError(t("auth.invalid"));
      return;
    }

    clientLogger.loginSuccess({ email });
    router.replace(redirect);
    router.refresh();
  }

  async function handleReset() {
    if (!supabase || !email) {
      setError(t("auth.enterEmail"));
      return;
    }

    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/login`
    });

    if (resetError) setError(t("auth.resetFailed"));
    else {
      clientLogger.passwordResetRequested({ email });
      setMessage(t("auth.resetSent"));
    }
  }

  return (
    <div className="w-full max-w-md rounded-md border border-slate-200 bg-white p-6 shadow-soft">
      <div className="mb-6">
        <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-md bg-brand-600 text-sm font-bold text-white">
          QS
        </div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium text-brand-700">Quiksol Data Intelligence Platform</p>
          <LanguageToggle />
        </div>
        <h1 className="mt-1 text-2xl font-semibold text-slate-950">{t("auth.signIn")}</h1>
      </div>

      {!supabase ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          {t("auth.notConfiguredNotice")}
        </div>
      ) : null}

      <form onSubmit={handleSubmit} className="mt-5 grid gap-4">
        <label className="grid gap-1 text-sm font-medium text-slate-700">
          {t("auth.email")}
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
          {t("auth.password")}
          <input
            type="password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="focus-ring rounded-md border border-slate-300 px-3 py-2.5 font-normal text-slate-950"
            placeholder={t("auth.passwordPlaceholder")}
          />
        </label>

        {message ? <p className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-700">{message}</p> : null}
        {error ? <p className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}

        <button
          disabled={loading || configLoading || !supabase}
          className="focus-ring rounded-md bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
          type="submit"
        >
          {configLoading ? t("auth.preparing") : loading ? t("auth.signingIn") : t("auth.signIn")}
        </button>
        <button
          type="button"
          onClick={handleReset}
          className="text-sm font-medium text-slate-600 hover:text-slate-950"
        >
          {t("auth.reset")}
        </button>
      </form>
    </div>
  );
}

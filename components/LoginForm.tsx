"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { clientLogger } from "@/lib/logger/clientLogger";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import LanguageToggle from "@/components/LanguageToggle";
import BrandMark from "@/components/BrandMark";
import { useLanguage } from "@/components/LanguageProvider";
import { safePostLoginRedirect } from "@/lib/auth/redirects";

export default function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t } = useLanguage();
  const redirect = safePostLoginRedirect(searchParams.get("redirect"));
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

  return (
    <div className="w-full max-w-6xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-soft lg:grid lg:grid-cols-[1.05fr_0.95fr]">
      <section className="technical-grid relative hidden min-h-[620px] overflow-hidden bg-slate-950 p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="absolute -right-24 top-20 h-64 w-64 rounded-full border border-blue-400/20" aria-hidden="true" />
        <div className="absolute -right-10 top-36 h-40 w-40 rounded-full border border-blue-300/20" aria-hidden="true" />
        <div>
          <div className="flex items-center gap-4">
            <BrandMark size={52} label="Electronic Parts microchip mark" className="ring-1 ring-white/20" />
            <div>
              <p className="text-xl font-semibold tracking-tight">Electronic Parts</p>
              <span className="mt-1 inline-flex rounded-full border border-blue-300/30 bg-blue-400/10 px-2.5 py-1 text-[10px] font-semibold tracking-[0.18em] text-blue-100">DEMO</span>
            </div>
          </div>
          <h2 className="mt-20 max-w-md text-4xl font-semibold leading-tight tracking-tight">
            Electronic Components Intelligence Platform
          </h2>
          <p className="mt-5 max-w-lg text-base leading-7 text-slate-300">
            One workspace for component sourcing, inventory intelligence, RFQs, customer operations and commercial analytics.
          </p>
        </div>
        <div className="flex items-center gap-3 border-t border-slate-800 pt-6 text-xs text-slate-400">
          <span className="h-2 w-2 rounded-full bg-blue-400" aria-hidden="true" />
          Demonstration environment · White-label B2B platform
        </div>
      </section>

      <section className="flex min-h-[580px] flex-col justify-center p-6 sm:p-10 lg:p-14">
        <div className="mx-auto w-full max-w-md">
          <div className="mb-8 flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-3 lg:hidden">
                <BrandMark size={44} label="Electronic Parts microchip mark" />
                <div>
                  <p className="font-semibold text-slate-950">Electronic Parts</p>
                  <p className="text-[10px] font-semibold tracking-[0.18em] text-brand-700">DEMO</p>
                </div>
              </div>
              <p className="mt-8 text-xs font-semibold uppercase tracking-[0.16em] text-brand-700 lg:mt-0">Electronic Parts</p>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">{t("auth.signIn")}</h1>
              <p className="mt-2 text-sm leading-6 text-slate-600">Electronic Components Intelligence Platform</p>
            </div>
            <LanguageToggle />
          </div>

          {!supabase ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              {t("auth.notConfiguredNotice")}
            </div>
          ) : null}

          <form onSubmit={handleSubmit} className="mt-6 grid gap-5">
        <label className="grid gap-1 text-sm font-medium text-slate-700">
          {t("auth.email")}
          <input
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            className="focus-ring min-h-11 rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 font-normal text-slate-950 shadow-sm placeholder:text-slate-400"
            placeholder="name@example.com"
          />
        </label>
        <label className="grid gap-1 text-sm font-medium text-slate-700">
          {t("auth.password")}
          <input
            type="password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            className="focus-ring min-h-11 rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 font-normal text-slate-950 shadow-sm placeholder:text-slate-400"
            placeholder={t("auth.passwordPlaceholder")}
          />
        </label>

        {message ? <p className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">{message}</p> : null}
        {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}

        <button
          disabled={loading || configLoading || !supabase}
          className="focus-ring min-h-11 rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
          type="submit"
        >
          {configLoading ? t("auth.preparing") : loading ? t("auth.signingIn") : t("auth.signIn")}
        </button>
            <Link
          href="/forgot-password"
          className="text-center text-sm font-medium text-slate-600 hover:text-slate-950"
        >
          {t("auth.reset")}
            </Link>
          </form>
          <div className="mt-8 flex items-center justify-between border-t border-slate-200 pt-5 text-xs text-slate-500">
            <span>Demo Environment</span>
            <span>B2B Platform</span>
          </div>
        </div>
      </section>
    </div>
  );
}

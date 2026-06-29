"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import LanguageToggle from "@/components/LanguageToggle";

export default function ForgotPasswordPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/auth/password-reset/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "No se pudo procesar la solicitud.");
      router.push(`/reset-password?email=${encodeURIComponent(email.trim().toLowerCase())}`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "No se pudo procesar la solicitud.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-md rounded-md border border-slate-200 bg-white p-6 shadow-soft">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-md bg-brand-600 text-sm font-bold text-white">QS</div>
            <h1 className="text-2xl font-semibold text-slate-950">Recuperar contrasena</h1>
          </div>
          <LanguageToggle />
        </div>
        <p className="mt-3 text-sm text-slate-600">Escribe tu correo. Si esta registrado, enviaremos un codigo de ocho caracteres.</p>
        <form onSubmit={submit} className="mt-5 grid gap-4">
          <label className="grid gap-1 text-sm font-medium text-slate-700">
            Correo
            <input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" className="focus-ring rounded-md border border-slate-300 px-3 py-2.5 font-normal" />
          </label>
          {error ? <p className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
          <button disabled={loading} className="focus-ring rounded-md bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60">
            {loading ? "Procesando..." : "Enviar codigo"}
          </button>
          <Link href="/login" className="text-center text-sm font-medium text-slate-600 hover:text-slate-950">Volver al inicio de sesion</Link>
        </form>
      </div>
    </div>
  );
}

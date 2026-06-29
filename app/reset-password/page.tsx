"use client";

import Link from "next/link";
import { FormEvent, Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import QuiksolIcon from "@/components/QuiksolIcon";

function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const [email, setEmail] = useState(searchParams.get("email") ?? "");
  const [code, setCode] = useState("");
  const [resetToken, setResetToken] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/auth/password-reset/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code })
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.resetToken) throw new Error(payload?.error ?? "El codigo no es valido.");
      setResetToken(payload.resetToken);
    } catch (verifyError) {
      setError(verifyError instanceof Error ? verifyError.message : "El codigo no es valido.");
    } finally {
      setLoading(false);
    }
  }

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password !== confirmPassword) {
      setError("Las contrasenas no coinciden.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/auth/password-reset/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, resetToken, password })
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error ?? "No se pudo cambiar la contrasena.");
      setSuccess(true);
    } catch (confirmError) {
      setError(confirmError instanceof Error ? confirmError.message : "No se pudo cambiar la contrasena.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full max-w-md rounded-md border border-slate-200 bg-white p-6 shadow-soft">
      <QuiksolIcon size={44} className="mb-4 ring-1 ring-brand-100" />
      <h1 className="text-2xl font-semibold text-slate-950">Restablecer contrasena</h1>
      {success ? (
        <div className="mt-5 space-y-4">
          <p className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-800">Tu contrasena fue actualizada. Ya puedes iniciar sesion.</p>
          <Link href="/login" className="block rounded-md bg-brand-600 px-4 py-2.5 text-center text-sm font-semibold text-white">Ir al inicio de sesion</Link>
        </div>
      ) : !resetToken ? (
        <form onSubmit={verify} className="mt-5 grid gap-4">
          <p className="text-sm text-slate-600">Escribe el codigo recibido. Vence en 15 minutos y permite un maximo de cinco intentos.</p>
          <label className="grid gap-1 text-sm font-medium text-slate-700">Correo<input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} className="focus-ring rounded-md border border-slate-300 px-3 py-2.5 font-normal" /></label>
          <label className="grid gap-1 text-sm font-medium text-slate-700">Codigo<input required value={code} onChange={(event) => setCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8))} placeholder="ABCD1234" autoComplete="one-time-code" className="focus-ring rounded-md border border-slate-300 px-3 py-2.5 font-mono text-lg uppercase tracking-widest" /></label>
          {error ? <p className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
          <button disabled={loading || code.length !== 8} className="focus-ring rounded-md bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60">{loading ? "Verificando..." : "Verificar codigo"}</button>
          <Link href="/forgot-password" className="text-center text-sm font-medium text-slate-600">Solicitar otro codigo</Link>
        </form>
      ) : (
        <form onSubmit={confirm} className="mt-5 grid gap-4">
          <p className="text-sm text-slate-600">Usa al menos 12 caracteres, una mayuscula, una minuscula y un numero.</p>
          <label className="grid gap-1 text-sm font-medium text-slate-700">Nueva contrasena<input type="password" required minLength={12} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" className="focus-ring rounded-md border border-slate-300 px-3 py-2.5 font-normal" /></label>
          <label className="grid gap-1 text-sm font-medium text-slate-700">Confirmar contrasena<input type="password" required minLength={12} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" className="focus-ring rounded-md border border-slate-300 px-3 py-2.5 font-normal" /></label>
          {error ? <p className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
          <button disabled={loading} className="focus-ring rounded-md bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60">{loading ? "Actualizando..." : "Cambiar contrasena"}</button>
        </form>
      )}
    </div>
  );
}

export default function ResetPasswordPage() {
  return <div className="flex min-h-screen items-center justify-center px-4 py-10"><Suspense fallback={<p>Cargando...</p>}><ResetPasswordForm /></Suspense></div>;
}

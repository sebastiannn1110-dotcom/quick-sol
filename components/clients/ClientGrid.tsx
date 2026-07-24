"use client";

import Link from "next/link";
import { Plus } from "lucide-react";
import ClientCard from "@/components/clients/ClientCard";
import { useLanguage } from "@/components/LanguageProvider";
import type { AccountClient } from "@/lib/clients/clients";

export default function ClientGrid({
  clients,
  loading,
  canManage
}: {
  clients: AccountClient[];
  loading: boolean;
  canManage: boolean;
}) {
  const { t } = useLanguage();
  if (loading) return <div className="py-10 text-center text-sm text-slate-500">{t("clients.loading")}</div>;
  if (!clients.length) {
    return (
      <div className="border-y border-slate-200 bg-white py-12 text-center">
        <p className="mx-auto max-w-xl text-sm text-slate-600">
          {t(canManage ? "clients.empty.manager" : "clients.empty.employee")}
        </p>
        {canManage ? (
          <Link href="/admin/clients/new" className="mt-5 inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-slate-950 px-4 text-sm font-semibold text-white hover:bg-slate-800">
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t("clients.create")}
          </Link>
        ) : null}
      </div>
    );
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      {clients.map((client) => <ClientCard key={client.id} client={client} />)}
    </div>
  );
}

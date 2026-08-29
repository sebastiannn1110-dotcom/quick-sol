"use client";

import { useCallback, useMemo, useState } from "react";
import { ChevronDown, Pencil, RefreshCw, Save, Users, X } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import UserAvatar from "@/components/chat/UserAvatar";
import {
  useVisiblePolling,
  type VisiblePollingContext
} from "@/components/useVisiblePolling";
import type { EmployeeAnalyticsPayload } from "@/lib/employee-analytics/contracts";
import type { Language } from "@/lib/i18n";
import {
  BUSINESS_RANKS,
  type BusinessRank,
  type OrganizationDirectory,
  type OrganizationMember
} from "@/lib/organization/contracts";
import { allowedManagerIds } from "@/lib/organization/scope";
import type { UserRole } from "@/lib/types";

type TreeMember = OrganizationMember & { children: TreeMember[] };

type TeamCopy = {
  eyebrow: string;
  title: string;
  description: string;
  refresh: string;
  loading: string;
  loadError: string;
  updateError: string;
  conflictError: string;
  updated: string;
  tree: string;
  noMembers: string;
  titlePending: string;
  noDepartment: string;
  countryPending: string;
  editMember: string;
  businessRank: string;
  department: string;
  countryLocation: string;
  notAssigned: string;
  manager: string;
  topLevel: string;
  directReports: string;
  technicalRole: string;
  responsibilities: string;
  noResponsibilities: string;
  employeeAnalytics: string;
  acceptedQuoteValue: string;
  quoteConversionRate: string;
  noAnalytics: string;
  editTitle: string;
  cancelEdit: string;
  businessTitle: string;
  country: string;
  saving: string;
  saveChanges: string;
  selectMember: string;
  ranks: Record<BusinessRank, string>;
  roles: Record<UserRole, string>;
};

const COPY: Record<Language, TeamCopy> = {
  en: {
    eyebrow: "Organization",
    title: "Team Structure",
    description: "Business hierarchy is separate from technical authorization roles.",
    refresh: "Refresh",
    loading: "Loading Team Structure...",
    loadError: "Team Structure could not be loaded.",
    updateError: "The team member could not be updated.",
    conflictError: "The organization changed. Review the latest version and try again.",
    updated: "Team member updated.",
    tree: "Organization tree",
    noMembers: "No organization members are visible in your scope.",
    titlePending: "Title pending",
    noDepartment: "No department",
    countryPending: "Country pending",
    editMember: "Edit team member",
    businessRank: "Business rank",
    department: "Department",
    countryLocation: "Country / location",
    notAssigned: "Not assigned",
    manager: "Manager",
    topLevel: "Top level",
    directReports: "Direct reports",
    technicalRole: "Technical role",
    responsibilities: "Responsibilities",
    noResponsibilities: "No responsibilities documented.",
    employeeAnalytics: "Employee analytics",
    acceptedQuoteValue: "Accepted Quote Value",
    quoteConversionRate: "Quote Conversion Rate",
    noAnalytics: "No analytics available in your current scope.",
    editTitle: "Edit organization member",
    cancelEdit: "Cancel edit",
    businessTitle: "Business title",
    country: "Country",
    saving: "Saving...",
    saveChanges: "Save changes",
    selectMember: "Select a team member.",
    ranks: {
      owner: "Owner",
      executive: "Executive",
      director: "Director",
      manager: "Manager",
      salesperson: "Salesperson",
      sourcing_manager: "Sourcing Manager",
      sourcing_specialist: "Sourcing Specialist",
      individual_contributor: "Individual contributor"
    },
    roles: { admin: "Admin", manager: "Manager", employee: "Employee", super_admin_dev: "Super Admin Dev" }
  },
  es: {
    eyebrow: "Organización",
    title: "Estructura del equipo",
    description: "La jerarquía empresarial está separada de los roles técnicos de autorización.",
    refresh: "Actualizar",
    loading: "Cargando estructura del equipo...",
    loadError: "No se pudo cargar la estructura del equipo.",
    updateError: "No se pudo actualizar al miembro del equipo.",
    conflictError: "La organización cambió. Revisa la versión más reciente e inténtalo de nuevo.",
    updated: "Miembro del equipo actualizado.",
    tree: "Árbol organizacional",
    noMembers: "No hay miembros visibles en tu alcance.",
    titlePending: "Cargo pendiente",
    noDepartment: "Sin departamento",
    countryPending: "País pendiente",
    editMember: "Editar miembro del equipo",
    businessRank: "Rango empresarial",
    department: "Departamento",
    countryLocation: "País / ubicación",
    notAssigned: "Sin asignar",
    manager: "Responsable",
    topLevel: "Nivel superior",
    directReports: "Reportes directos",
    technicalRole: "Rol técnico",
    responsibilities: "Responsabilidades",
    noResponsibilities: "No hay responsabilidades documentadas.",
    employeeAnalytics: "Analítica del empleado",
    acceptedQuoteValue: "Valor de cotizaciones aceptadas",
    quoteConversionRate: "Tasa de conversión de cotizaciones",
    noAnalytics: "No hay analítica disponible en tu alcance actual.",
    editTitle: "Editar miembro de la organización",
    cancelEdit: "Cancelar edición",
    businessTitle: "Cargo empresarial",
    country: "País",
    saving: "Guardando...",
    saveChanges: "Guardar cambios",
    selectMember: "Selecciona un miembro del equipo.",
    ranks: {
      owner: "Propietario",
      executive: "Ejecutivo",
      director: "Director",
      manager: "Gerente",
      salesperson: "Vendedor",
      sourcing_manager: "Gerente de abastecimiento",
      sourcing_specialist: "Especialista de abastecimiento",
      individual_contributor: "Colaborador individual"
    },
    roles: { admin: "Administrador", manager: "Gerente", employee: "Empleado", super_admin_dev: "Super Admin Dev" }
  },
  zh: {
    eyebrow: "组织",
    title: "团队结构",
    description: "业务层级与技术授权角色相互独立。",
    refresh: "刷新",
    loading: "正在加载团队结构...",
    loadError: "无法加载团队结构。",
    updateError: "无法更新团队成员。",
    conflictError: "组织信息已发生变化。请查看最新版本后重试。",
    updated: "团队成员已更新。",
    tree: "组织树",
    noMembers: "当前范围内没有可见的组织成员。",
    titlePending: "职位待定",
    noDepartment: "未分配部门",
    countryPending: "国家待定",
    editMember: "编辑团队成员",
    businessRank: "业务层级",
    department: "部门",
    countryLocation: "国家 / 地点",
    notAssigned: "未分配",
    manager: "直属经理",
    topLevel: "最高层级",
    directReports: "直接下属",
    technicalRole: "技术角色",
    responsibilities: "职责",
    noResponsibilities: "尚未记录职责。",
    employeeAnalytics: "员工分析",
    acceptedQuoteValue: "已接受报价金额",
    quoteConversionRate: "报价转化率",
    noAnalytics: "当前范围内没有可用分析。",
    editTitle: "编辑组织成员",
    cancelEdit: "取消编辑",
    businessTitle: "业务职位",
    country: "国家",
    saving: "正在保存...",
    saveChanges: "保存更改",
    selectMember: "请选择一名团队成员。",
    ranks: {
      owner: "所有者",
      executive: "高管",
      director: "总监",
      manager: "经理",
      salesperson: "销售人员",
      sourcing_manager: "采购经理",
      sourcing_specialist: "采购专员",
      individual_contributor: "个人贡献者"
    },
    roles: { admin: "管理员", manager: "经理", employee: "员工", super_admin_dev: "超级开发管理员" }
  }
};

function forest(members: OrganizationMember[]) {
  const memberIds = new Set(members.map((member) => member.profileId));
  const children = new Map<string, OrganizationMember[]>();
  const roots: OrganizationMember[] = [];

  for (const member of members) {
    if (!member.managerId || !memberIds.has(member.managerId)) roots.push(member);
    else children.set(member.managerId, [...(children.get(member.managerId) ?? []), member]);
  }

  const build = (member: OrganizationMember, lineage: Set<string>): TreeMember => {
    if (lineage.has(member.profileId)) return { ...member, children: [] };
    const nextLineage = new Set(lineage).add(member.profileId);
    return {
      ...member,
      children: (children.get(member.profileId) ?? [])
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((child) => build(child, nextLineage))
    };
  };

  return roots.sort((a, b) => a.name.localeCompare(b.name)).map((root) => build(root, new Set()));
}

function TreeNode({ node, selectedId, onSelect, copy }: {
  node: TreeMember;
  selectedId: string;
  onSelect: (member: OrganizationMember) => void;
  copy: TeamCopy;
}) {
  return (
    <li className="relative">
      <button type="button" onClick={() => onSelect(node)} className={`focus-ring w-full max-w-sm rounded-xl border bg-white p-3 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-orange-300 ${selectedId === node.profileId ? "border-orange-400 ring-2 ring-orange-100" : "border-slate-200"}`}>
        <div className="flex items-start gap-3">
          <UserAvatar name={node.name} avatarPath={node.avatarPath} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-slate-950">{node.name}</span>
            <span className="block truncate text-xs font-medium text-brand-700">{node.businessTitle || copy.titlePending}</span>
            <span className="mt-1 block truncate text-[11px] text-slate-500">{copy.ranks[node.businessRank]} · {node.department || copy.noDepartment}</span>
            <span className="block truncate text-[11px] text-slate-400">{node.country || copy.countryPending}</span>
          </span>
        </div>
      </button>
      {node.children.length ? (
        <div className="ml-5 mt-2 border-l-2 border-slate-200 pl-5">
          <ChevronDown className="mb-1 -ml-[30px] h-4 w-4 rounded-full bg-slate-100 text-slate-500" />
          <ul className="space-y-3">{node.children.map((child) => <TreeNode key={child.profileId} node={child} selectedId={selectedId} onSelect={onSelect} copy={copy} />)}</ul>
        </div>
      ) : null}
    </li>
  );
}

type EditForm = {
  managerId: string;
  businessTitle: string;
  businessRank: BusinessRank;
  department: string;
  country: string;
  responsibilities: string;
};

function formFor(member: OrganizationMember): EditForm {
  return {
    managerId: member.managerId || "",
    businessTitle: member.businessTitle,
    businessRank: member.businessRank,
    department: member.department || "",
    country: member.country || "",
    responsibilities: member.responsibilities
  };
}

export default function TeamStructure() {
  const { language, locale } = useLanguage();
  const copy = COPY[language];
  const [directory, setDirectory] = useState<OrganizationDirectory | null>(null);
  const [analytics, setAnalytics] = useState<EmployeeAnalyticsPayload | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<EditForm | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async ({ signal, trigger }: VisiblePollingContext) => {
    if (trigger === "initial" || trigger === "manual") setLoading(true);
    try {
      const [organizationResponse, analyticsResponse] = await Promise.all([
        fetch("/api/organization", { cache: "no-store", signal }),
        fetch("/api/employee-analytics", { cache: "no-store", signal })
      ]);
      const organizationPayload = (await organizationResponse.json().catch(() => null)) as OrganizationDirectory | null;
      const analyticsPayload = (await analyticsResponse.json().catch(() => null)) as { analytics?: EmployeeAnalyticsPayload } | null;

      if (signal.aborted) return;
      if (!organizationResponse.ok || !organizationPayload || !("members" in organizationPayload)) {
        setError(copy.loadError);
        return;
      }

      setError("");
      setDirectory(organizationPayload);
      setAnalytics(analyticsResponse.ok ? analyticsPayload?.analytics || null : null);
      setSelectedId((current) => current || organizationPayload.members[0]?.profileId || "");
    } catch {
      if (!signal.aborted) setError(copy.loadError);
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [copy.loadError]);

  const { refresh } = useVisiblePolling(load, { intervalMs: 12_000 });

  const selected = directory?.members.find((member) => member.profileId === selectedId) || null;
  const tree = useMemo(() => forest(directory?.members || []), [directory]);
  const manager = directory?.members.find((member) => member.profileId === selected?.managerId) || null;
  const reports = directory?.members.filter((member) => member.managerId === selected?.profileId) || [];
  const selectedAnalytics = analytics?.metrics.find((metric) => metric.employeeId === selected?.profileId) || null;
  const managerOptions = useMemo(() => {
    if (!directory || !selected) return [];
    const allowed = allowedManagerIds(directory.actor, selected.profileId, directory.members);
    return directory.members.filter((member) => allowed.has(member.profileId));
  }, [directory, selected]);

  function beginEdit() {
    if (!selected?.canEdit) return;
    setForm(formFor(selected));
    setEditing(true);
    setError("");
    setMessage("");
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !form) return;
    setSaving(true);
    setError("");
    setMessage("");

    const response = await fetch(`/api/organization/members/${encodeURIComponent(selected.profileId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: selected.version,
        managerId: form.managerId || null,
        businessTitle: form.businessTitle,
        businessRank: form.businessRank,
        department: form.department || null,
        country: form.country || null,
        location: selected.location,
        responsibilities: form.responsibilities
      })
    });
    const payload = (await response.json().catch(() => null)) as { member?: OrganizationMember } | null;
    if (!response.ok || !payload?.member) {
      setSaving(false);
      if (response.status === 409) {
        await refresh();
        setError(copy.conflictError);
      } else {
        setError(copy.updateError);
      }
      return;
    }

    setDirectory((current) => current ? {
      ...current,
      members: current.members.map((member) => member.profileId === payload.member!.profileId ? payload.member! : member)
    } : current);
    setEditing(false);
    setMessage(copy.updated);
    setSaving(false);
  }

  if (loading && !directory) {
    return <div className="rounded-md bg-white p-6 text-sm text-slate-500 shadow-sm">{copy.loading}</div>;
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div><p className="text-sm font-medium text-orange-700">{copy.eyebrow}</p><h1 className="text-2xl font-semibold text-slate-950">{copy.title}</h1><p className="mt-2 text-sm text-slate-600">{copy.description}</p></div>
        <button type="button" onClick={() => void refresh()} disabled={loading} className="focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> {copy.refresh}</button>
      </header>

      {message ? <p className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-800">{message}</p> : null}
      {error ? <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]">
        <section className="min-h-[640px] overflow-auto rounded-md border border-slate-200 bg-slate-50 p-5 shadow-sm">
          <div className="mb-5 flex items-center gap-2"><Users className="h-5 w-5 text-brand-600" /><h2 className="font-semibold text-slate-950">{copy.tree}</h2></div>
          {tree.length ? <ul className="space-y-4">{tree.map((node) => <TreeNode key={node.profileId} node={node} selectedId={selectedId} copy={copy} onSelect={(member) => { setSelectedId(member.profileId); setEditing(false); setForm(null); setMessage(""); }} />)}</ul> : <p className="text-sm text-slate-500">{copy.noMembers}</p>}
        </section>

        <aside className="rounded-md border border-slate-200 bg-white p-5 shadow-sm">
          {selected ? (
            <div className="space-y-5">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3"><UserAvatar name={selected.name} avatarPath={selected.avatarPath} size="lg" /><div><h2 className="text-xl font-semibold text-slate-950">{selected.name}</h2><p className="text-sm text-slate-500">{selected.email}</p><p className="mt-1 text-sm font-semibold text-brand-700">{selected.businessTitle || copy.titlePending}</p></div></div>
                {selected.canEdit && !editing ? <button type="button" onClick={beginEdit} className="focus-ring inline-flex h-10 w-10 items-center justify-center rounded-md border border-slate-300 text-slate-700" aria-label={copy.editMember}><Pencil className="h-4 w-4" /></button> : null}
              </div>

              {!editing ? (
                <>
                  <dl className="grid grid-cols-2 gap-3 text-sm">
                    <div className="rounded-md bg-slate-50 p-3"><dt className="text-xs text-slate-500">{copy.businessRank}</dt><dd className="mt-1 font-semibold text-slate-900">{copy.ranks[selected.businessRank]}</dd></div>
                    <div className="rounded-md bg-slate-50 p-3"><dt className="text-xs text-slate-500">{copy.department}</dt><dd className="mt-1 font-semibold text-slate-900">{selected.department || copy.notAssigned}</dd></div>
                    <div className="rounded-md bg-slate-50 p-3"><dt className="text-xs text-slate-500">{copy.countryLocation}</dt><dd className="mt-1 font-semibold text-slate-900">{[selected.country, selected.location].filter(Boolean).join(" · ") || copy.notAssigned}</dd></div>
                    <div className="rounded-md bg-slate-50 p-3"><dt className="text-xs text-slate-500">{copy.manager}</dt><dd className="mt-1 font-semibold text-slate-900">{manager?.name || copy.topLevel}</dd></div>
                    <div className="rounded-md bg-slate-50 p-3"><dt className="text-xs text-slate-500">{copy.directReports}</dt><dd className="mt-1 font-semibold text-slate-900">{reports.length}</dd></div>
                    <div className="rounded-md bg-slate-50 p-3"><dt className="text-xs text-slate-500">{copy.technicalRole}</dt><dd className="mt-1 font-semibold text-slate-900">{copy.roles[selected.technicalRole]}</dd></div>
                  </dl>
                  <div><h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{copy.responsibilities}</h3><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-700">{selected.responsibilities || copy.noResponsibilities}</p></div>
                  <div><h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{copy.employeeAnalytics}</h3>{selectedAnalytics ? <div className="mt-2 grid grid-cols-2 gap-2 text-sm"><div className="rounded-md bg-orange-50 p-3"><p className="text-xs text-orange-700">{copy.acceptedQuoteValue}</p><p className="mt-1 font-semibold text-slate-950">{new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(selectedAnalytics.acceptedQuoteValue)}</p></div><div className="rounded-md bg-slate-50 p-3"><p className="text-xs text-slate-500">{copy.quoteConversionRate}</p><p className="mt-1 font-semibold text-slate-950">{selectedAnalytics.quoteConversionRate.toFixed(2)}%</p></div></div> : <p className="mt-2 text-sm text-slate-500">{copy.noAnalytics}</p>}</div>
                </>
              ) : form ? (
                <form onSubmit={save} className="space-y-4">
                  <div className="flex items-center justify-between"><h3 className="font-semibold text-slate-950">{copy.editTitle}</h3><button type="button" onClick={() => setEditing(false)} className="focus-ring rounded-md p-2 text-slate-500" aria-label={copy.cancelEdit}><X className="h-4 w-4" /></button></div>
                  <label className="grid gap-1 text-xs font-semibold text-slate-600">{copy.manager}<select value={form.managerId} onChange={(event) => setForm({ ...form, managerId: event.target.value })} className="focus-ring h-11 rounded-md border border-slate-300 px-3 text-sm font-normal text-slate-900">{directory?.actor.canEditGlobal ? <option value="">{copy.topLevel}</option> : null}{managerOptions.map((member) => <option key={member.profileId} value={member.profileId}>{member.name}</option>)}</select></label>
                  <label className="grid gap-1 text-xs font-semibold text-slate-600">{copy.businessTitle}<input value={form.businessTitle} onChange={(event) => setForm({ ...form, businessTitle: event.target.value })} maxLength={160} className="focus-ring h-11 rounded-md border border-slate-300 px-3 text-sm font-normal text-slate-900" /></label>
                  <label className="grid gap-1 text-xs font-semibold text-slate-600">{copy.businessRank}<select value={form.businessRank} onChange={(event) => setForm({ ...form, businessRank: event.target.value as BusinessRank })} className="focus-ring h-11 rounded-md border border-slate-300 px-3 text-sm font-normal text-slate-900">{BUSINESS_RANKS.filter((rank) => rank !== "owner" || directory?.actor.canEditGlobal).map((rank) => <option key={rank} value={rank}>{copy.ranks[rank]}</option>)}</select></label>
                  <div className="grid grid-cols-2 gap-3"><label className="grid gap-1 text-xs font-semibold text-slate-600">{copy.department}<input value={form.department} onChange={(event) => setForm({ ...form, department: event.target.value })} maxLength={160} className="focus-ring h-11 rounded-md border border-slate-300 px-3 text-sm font-normal text-slate-900" /></label><label className="grid gap-1 text-xs font-semibold text-slate-600">{copy.country}<input value={form.country} onChange={(event) => setForm({ ...form, country: event.target.value })} maxLength={100} className="focus-ring h-11 rounded-md border border-slate-300 px-3 text-sm font-normal text-slate-900" /></label></div>
                  <label className="grid gap-1 text-xs font-semibold text-slate-600">{copy.responsibilities}<textarea value={form.responsibilities} onChange={(event) => setForm({ ...form, responsibilities: event.target.value })} maxLength={4000} rows={5} className="focus-ring rounded-md border border-slate-300 px-3 py-2 text-sm font-normal text-slate-900" /></label>
                  <button type="submit" disabled={saving} className="focus-ring inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-brand-600 px-4 text-sm font-semibold text-white disabled:opacity-50"><Save className="h-4 w-4" />{saving ? copy.saving : copy.saveChanges}</button>
                </form>
              ) : null}
            </div>
          ) : <p className="text-sm text-slate-500">{copy.selectMember}</p>}
        </aside>
      </div>
    </div>
  );
}

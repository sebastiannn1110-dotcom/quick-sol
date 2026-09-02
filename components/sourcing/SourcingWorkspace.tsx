"use client";

import { useCallback, useState, type FormEvent } from "react";
import { useLanguage } from "@/components/LanguageProvider";
import {
  useVisiblePolling,
  type VisiblePollingContext
} from "@/components/useVisiblePolling";

const SOURCING_COPY = {
  es: {
    eyebrow: "Operaciones comerciales", title: "Sourcing",
    privacy: "Costos, proveedores y documentos son privados. Publicar es una acción separada de aprobar.",
    newRequest: "Nueva solicitud", mpn: "MPN", manufacturer: "Fabricante", quantity: "Cantidad", uom: "UOM",
    customerContext: "Cliente / contexto", normal: "Normal", high: "Alta", urgent: "Urgente", notes: "Notas",
    createRequest: "Crear solicitud", automation: "Automatización de solicitudes",
    automationHelp: "Crea de forma idempotente una solicitud desde una línea RFQ real.", rfqItem: "UUID de línea RFQ comercial",
    sendSourcing: "Enviar a Sourcing", requests: "Solicitudes", loading: "Cargando...", noRequests: "No hay solicitudes de sourcing.",
    noManufacturer: "Fabricante no indicado", noContext: "Sin contexto", attach: "Adjuntar privado", addOffer: "Agregar oferta",
    privateCost: "Costo privado", lead: "Lead", days: "días", expires: "vence", authorizedPrice: "Precio autorizado USD",
    decisionReason: "Razón / nota de decisión", approvePrice: "Aprobar precio", reject: "Rechazar", available: "Disponible",
    limited: "Limitado", unavailable: "No disponible", contact: "Consultar", authorized: "Autorizado",
    withdraw: "Retirar del catálogo", publish: "Publicar en catálogo", newOffer: "Nueva oferta para", close: "Cerrar",
    supplier: "Proveedor", supplierRef: "Referencia proveedor", unitCost: "Costo unitario", currency: "Moneda",
    leadDays: "Días de entrega", condition: "Condición", warehouse: "Almacén", incoterm: "Incoterm",
    dateCode: "Código de fecha", countryOfOrigin: "País de origen", privateNotes: "Notas privadas", saveOffer: "Guardar oferta",
    requestCreated: "Solicitud creada.", offerSaved: "Oferta guardada para revisión.", priceApproved: "Precio autorizado.",
    offerRejected: "Oferta rechazada.", publicationOff: "Publicación desactivada.", publicationOn: "Precio publicado en catálogo.",
    automationDone: "RFQ enviada a Sourcing.", attachmentDone: "Documento privado cargado.",
    sendOf: "Enviar a Opportunity Finder", ofReady: "Contrato supplier_offer preparado para Opportunity Finder.",
    openOf: "Abrir oportunidades", adapter: "Adaptador", provenance: "Procedencia", lot: "Lote", manual: "Manual", commerceRfq: "RFQ comercial", defaultRejection: "Rechazada después de la revisión de sourcing",
    status: { open: "Abierta", collecting_offers: "Recopilando ofertas", review: "En revisión", approved: "Aprobada", closed: "Cerrada", cancelled: "Cancelada", pending: "Pendiente", rejected: "Rechazada", expired: "Vencida", active: "Activa", revoked: "Revocada" }
  },
  en: {
    eyebrow: "Commercial operations", title: "Sourcing",
    privacy: "Costs, suppliers, and documents are private. Publishing is a separate action from approval.",
    newRequest: "New request", mpn: "MPN", manufacturer: "Manufacturer", quantity: "Quantity", uom: "UOM",
    customerContext: "Customer / context", normal: "Normal", high: "High", urgent: "Urgent", notes: "Notes",
    createRequest: "Create request", automation: "Request automation",
    automationHelp: "Idempotently creates one request from a real RFQ line.", rfqItem: "Commerce RFQ item UUID",
    sendSourcing: "Send to Sourcing", requests: "Requests", loading: "Loading...", noRequests: "There are no sourcing requests.",
    noManufacturer: "Manufacturer not provided", noContext: "No context", attach: "Attach private file", addOffer: "Add offer",
    privateCost: "Private cost", lead: "Lead", days: "days", expires: "expires", authorizedPrice: "Authorized USD price",
    decisionReason: "Decision reason / note", approvePrice: "Approve price", reject: "Reject", available: "Available",
    limited: "Limited", unavailable: "Unavailable", contact: "Contact us", authorized: "Authorized",
    withdraw: "Remove from catalog", publish: "Publish to catalog", newOffer: "New offer for", close: "Close",
    supplier: "Supplier", supplierRef: "Supplier reference", unitCost: "Unit cost", currency: "Currency",
    leadDays: "Lead days", condition: "Condition", warehouse: "Warehouse", incoterm: "Incoterm",
    dateCode: "Date code", countryOfOrigin: "Country of origin", privateNotes: "Private notes", saveOffer: "Save offer",
    requestCreated: "Request created.", offerSaved: "Offer saved for review.", priceApproved: "Price authorized.",
    offerRejected: "Offer rejected.", publicationOff: "Publication disabled.", publicationOn: "Price published to catalog.",
    automationDone: "RFQ sent to Sourcing.", attachmentDone: "Private document uploaded.",
    sendOf: "Send to Opportunity Finder", ofReady: "supplier_offer contract prepared for Opportunity Finder.",
    openOf: "Open opportunities", adapter: "Adapter", provenance: "Provenance", lot: "Lot", manual: "Manual", commerceRfq: "Commerce RFQ", defaultRejection: "Rejected after sourcing review",
    status: { open: "Open", collecting_offers: "Collecting offers", review: "In review", approved: "Approved", closed: "Closed", cancelled: "Cancelled", pending: "Pending", rejected: "Rejected", expired: "Expired", active: "Active", revoked: "Revoked" }
  },
  zh: {
    eyebrow: "商务运营", title: "采购寻源",
    privacy: "成本、供应商和文件均为私密信息。发布与审批是两个独立操作。",
    newRequest: "新建寻源请求", mpn: "料号 MPN", manufacturer: "制造商", quantity: "数量", uom: "计量单位",
    customerContext: "客户 / 背景", normal: "普通", high: "高", urgent: "紧急", notes: "备注",
    createRequest: "创建请求", automation: "请求自动化",
    automationHelp: "从真实 RFQ 行幂等创建一个寻源请求。", rfqItem: "商务 RFQ 行 UUID",
    sendSourcing: "发送到寻源", requests: "寻源请求", loading: "加载中...", noRequests: "暂无寻源请求。",
    noManufacturer: "未提供制造商", noContext: "无背景", attach: "添加私密附件", addOffer: "添加报价",
    privateCost: "私密成本", lead: "交期", days: "天", expires: "到期", authorizedPrice: "授权美元价格",
    decisionReason: "决策原因 / 备注", approvePrice: "批准价格", reject: "拒绝", available: "可供",
    limited: "有限", unavailable: "不可供", contact: "请咨询", authorized: "已授权",
    withdraw: "从目录撤下", publish: "发布到目录", newOffer: "新增报价：", close: "关闭",
    supplier: "供应商", supplierRef: "供应商参考号", unitCost: "单位成本", currency: "币种",
    leadDays: "交期天数", condition: "货况", warehouse: "仓库", incoterm: "国际贸易术语",
    dateCode: "日期代码", countryOfOrigin: "原产国", privateNotes: "私密备注", saveOffer: "保存报价",
    requestCreated: "请求已创建。", offerSaved: "报价已保存并等待审核。", priceApproved: "价格已授权。",
    offerRejected: "报价已拒绝。", publicationOff: "已停止发布。", publicationOn: "价格已发布到目录。",
    automationDone: "RFQ 已发送到寻源。", attachmentDone: "私密文件已上传。",
    sendOf: "发送到机会查找器", ofReady: "supplier_offer 合同已为机会查找器准备完成。",
    openOf: "打开机会", adapter: "适配器", provenance: "来源追踪", lot: "供货批次", manual: "手动", commerceRfq: "商务 RFQ", defaultRejection: "寻源审核后拒绝",
    status: { open: "开放", collecting_offers: "收集报价", review: "审核中", approved: "已批准", closed: "已关闭", cancelled: "已取消", pending: "待处理", rejected: "已拒绝", expired: "已过期", active: "有效", revoked: "已撤销" }
  }
} as const;

function stateLabel(labels: Record<string, string>, value: string) {
  return labels[value] ?? value;
}

type Offer = {
  id: string;
  supplierName: string;
  supplierReference: string | null;
  mpn: string;
  manufacturer: string | null;
  availableQuantity: number;
  unitOfMeasure: string | null;
  rawUnitCost: number;
  currency: string;
  leadTimeDays: number | null;
  minimumOrderQuantity: number;
  warehouse: string | null;
  incoterm: string | null;
  expiresAt: string;
  status: string;
};

type Approval = {
  id: string;
  sourcingOfferId: string;
  authorizedUnitPrice: number;
  currency: string;
  coarseAvailability: string;
  leadTimeDays: number | null;
  minimumOrderQuantity: number;
  status: string;
  publishToCatalog: boolean;
  validUntil: string;
  version: number;
};

type Attachment = {
  id: string;
  fileName: string;
  sizeBytes: number;
};

type SourcingRequest = {
  id: string;
  source: string;
  mpn: string;
  manufacturer: string | null;
  requestedQuantity: number;
  unitOfMeasure: string | null;
  customerContext: string | null;
  priority: string;
  status: string;
  notes: string;
  offers: Offer[];
  approvals: Approval[];
  attachments: Attachment[];
};

const inputClass = "rounded-md border border-slate-300 bg-white px-3 py-2 text-sm";

async function responseError(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  return payload?.error?.message ?? `Request failed (${response.status})`;
}

export default function SourcingWorkspace() {
  const { language, locale } = useLanguage();
  const c = SOURCING_COPY[language];
  const [requests, setRequests] = useState<SourcingRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [selectedRequestId, setSelectedRequestId] = useState("");
  const [authorizedPrices, setAuthorizedPrices] = useState<Record<string, string>>({});
  const [availability, setAvailability] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [ofResults, setOfResults] = useState<Record<string, { mappingVersion: string; supplyLotKey: string; provenance: Record<string, unknown> }>>({});
  const [requestForm, setRequestForm] = useState({
    mpn: "", manufacturer: "", requestedQuantity: "1", unitOfMeasure: "EA",
    customerContext: "", priority: "normal", notes: ""
  });
  const [offerForm, setOfferForm] = useState({
    supplierName: "", supplierReference: "", mpn: "", manufacturer: "",
    availableQuantity: "1", unitOfMeasure: "EA", rawUnitCost: "",
    currency: "USD", leadTimeDays: "", minimumOrderQuantity: "1",
    standardPackQuantity: "", dateCode: "", condition: "New",
    warehouse: "", incoterm: "", countryOfOrigin: "", expiresAt: "", notes: ""
  });

  const load = useCallback(async ({ signal, trigger }: VisiblePollingContext) => {
    if (trigger === "initial" || trigger === "manual") setLoading(true);
    try {
      const response = await fetch("/api/sourcing/requests", {
        cache: "no-store",
        signal
      });
      if (signal.aborted) return;
      if (response.ok) {
        const payload = await response.json() as { data: SourcingRequest[] };
        if (!signal.aborted) setRequests(payload.data);
      } else {
        setMessage(await responseError(response));
      }
    } catch (error) {
      if (!signal.aborted) {
        setMessage(error instanceof Error ? error.message : "Request failed");
      }
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, []);

  const { refresh } = useVisiblePolling(load, { intervalMs: 12_000 });

  async function mutate(url: string, body: unknown, success: string) {
    setBusy(true);
    setMessage("");
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!response.ok) setMessage(await responseError(response));
    else {
      setMessage(success);
      await refresh();
    }
    setBusy(false);
    return response.ok;
  }

  async function createRequest(event: FormEvent) {
    event.preventDefault();
    const ok = await mutate("/api/sourcing/requests", {
      ...requestForm,
      requestedQuantity: Number(requestForm.requestedQuantity)
    }, c.requestCreated);
    if (ok) setRequestForm((current) => ({ ...current, mpn: "", manufacturer: "", customerContext: "", notes: "" }));
  }

  async function createOffer(event: FormEvent) {
    event.preventDefault();
    if (!selectedRequestId) return;
    const ok = await mutate(`/api/sourcing/requests/${selectedRequestId}/offers`, {
      ...offerForm,
      availableQuantity: Number(offerForm.availableQuantity),
      rawUnitCost: Number(offerForm.rawUnitCost),
      leadTimeDays: offerForm.leadTimeDays ? Number(offerForm.leadTimeDays) : null,
      minimumOrderQuantity: Number(offerForm.minimumOrderQuantity),
      standardPackQuantity: offerForm.standardPackQuantity ? Number(offerForm.standardPackQuantity) : null,
      expiresAt: new Date(offerForm.expiresAt).toISOString(),
      provenance: { entry: "admin-sourcing-ui" }
    }, c.offerSaved);
    if (ok) setOfferForm((current) => ({ ...current, supplierName: "", supplierReference: "", rawUnitCost: "", notes: "" }));
  }

  async function decide(offer: Offer, decision: "approve" | "reject") {
    const body = decision === "approve"
      ? {
          decision,
          authorizedUnitPrice: Number(authorizedPrices[offer.id] ?? offer.rawUnitCost),
          authorizedCurrency: "USD",
          coarseAvailability: availability[offer.id] ?? "available",
          reason: reasons[offer.id] ?? ""
        }
      : { decision, reason: reasons[offer.id] ?? c.defaultRejection };
    await mutate(`/api/sourcing/offers/${offer.id}/decision`, body, decision === "approve" ? c.priceApproved : c.offerRejected);
  }

  async function publish(approval: Approval) {
    await mutate(`/api/sourcing/approvals/${approval.id}/publication`, {
      publishToCatalog: !approval.publishToCatalog
    }, approval.publishToCatalog ? c.publicationOff : c.publicationOn);
  }

  async function uploadAttachment(requestId: string, file: File | null) {
    if (!file) return;
    setBusy(true);
    const form = new FormData();
    form.set("requestId", requestId);
    form.set("file", file);
    const response = await fetch("/api/sourcing/attachments", { method: "POST", body: form });
    if (!response.ok) setMessage(await responseError(response));
    else {
      setMessage(c.attachmentDone);
      await refresh();
    }
    setBusy(false);
  }

  async function downloadAttachment(attachmentId: string) {
    const response = await fetch(`/api/sourcing/attachments/${attachmentId}/download`, { cache: "no-store" });
    if (!response.ok) return setMessage(await responseError(response));
    const payload = await response.json() as { data: { url: string } };
    window.open(payload.data.url, "_blank", "noopener,noreferrer");
  }

  async function sendToOpportunityFinder(offer: Offer) {
    setBusy(true);
    setMessage("");
    const response = await fetch(`/api/sourcing/offers/${offer.id}/of-adapter`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "prepare" })
    });
    if (!response.ok) setMessage(await responseError(response));
    else {
      const payload = await response.json() as {
        data: { mappingVersion: string; supplyLotKey: string; sourcingProvenance: Record<string, unknown> }
      };
      setOfResults((current) => ({
        ...current,
        [offer.id]: {
          mappingVersion: payload.data.mappingVersion,
          supplyLotKey: payload.data.supplyLotKey,
          provenance: payload.data.sourcingProvenance
        }
      }));
      setMessage(c.ofReady);
    }
    setBusy(false);
  }

  const selected = requests.find((item) => item.id === selectedRequestId);

  return (
    <div className="space-y-6">
      <header>
        <p className="text-sm font-medium text-orange-700">{c.eyebrow}</p>
        <h1 className="text-2xl font-semibold text-slate-950">{c.title}</h1>
        <p className="mt-1 text-sm text-slate-600">{c.privacy}</p>
      </header>

      {message ? <p className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">{message}</p> : null}

      <div className="grid gap-4 xl:grid-cols-2">
        <form onSubmit={createRequest} className="space-y-3 rounded-md border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="font-semibold text-slate-950">{c.newRequest}</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <input required className={inputClass} placeholder={c.mpn} value={requestForm.mpn} onChange={(event) => setRequestForm({ ...requestForm, mpn: event.target.value })} />
            <input className={inputClass} placeholder={c.manufacturer} value={requestForm.manufacturer} onChange={(event) => setRequestForm({ ...requestForm, manufacturer: event.target.value })} />
            <input required min="1" type="number" className={inputClass} placeholder={c.quantity} value={requestForm.requestedQuantity} onChange={(event) => setRequestForm({ ...requestForm, requestedQuantity: event.target.value })} />
            <input className={inputClass} placeholder={c.uom} value={requestForm.unitOfMeasure} onChange={(event) => setRequestForm({ ...requestForm, unitOfMeasure: event.target.value })} />
            <input className={inputClass} placeholder={c.customerContext} value={requestForm.customerContext} onChange={(event) => setRequestForm({ ...requestForm, customerContext: event.target.value })} />
            <select className={inputClass} value={requestForm.priority} onChange={(event) => setRequestForm({ ...requestForm, priority: event.target.value })}>
              <option value="normal">{c.normal}</option><option value="high">{c.high}</option><option value="urgent">{c.urgent}</option>
            </select>
          </div>
          <textarea className={`${inputClass} w-full`} placeholder={c.notes} value={requestForm.notes} onChange={(event) => setRequestForm({ ...requestForm, notes: event.target.value })} />
          <button disabled={busy} className="rounded-md bg-orange-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{c.createRequest}</button>
        </form>

      </div>

      <section className="rounded-md border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 p-4"><h2 className="font-semibold text-slate-950">{c.requests} ({requests.length})</h2></div>
        {loading ? <p className="p-6 text-sm text-slate-500">{c.loading}</p> : null}
        <div className="divide-y divide-slate-200">
          {requests.map((item) => (
            <article key={item.id} className="space-y-4 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-semibold text-slate-950">{item.mpn} · {item.requestedQuantity} {item.unitOfMeasure ?? ""}</p>
                  <p className="text-sm text-slate-600">{item.manufacturer || c.noManufacturer} · {item.customerContext || c.noContext}</p>
                  <p className="text-xs text-slate-500">{item.source === "commerce_rfq" ? c.commerceRfq : c.manual} · {item.priority === "high" ? c.high : item.priority === "urgent" ? c.urgent : c.normal} · {stateLabel(c.status, item.status)}</p>
                </div>
                <div className="flex items-center gap-2">
                  <label className="cursor-pointer rounded-md border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700">
                    {c.attach}
                    <input className="sr-only" type="file" accept=".pdf,.xlsx,.csv,.png,.jpg,.jpeg,.webp" onChange={(event) => void uploadAttachment(item.id, event.target.files?.[0] ?? null)} />
                  </label>
                  <button type="button" onClick={() => {
                    setSelectedRequestId(item.id);
                    setOfferForm((current) => ({ ...current, mpn: item.mpn, manufacturer: item.manufacturer ?? "", unitOfMeasure: item.unitOfMeasure ?? "EA" }));
                  }} className="rounded-md bg-slate-900 px-3 py-2 text-xs font-semibold text-white">{c.addOffer}</button>
                </div>
              </div>

              {item.attachments.length ? <div className="flex flex-wrap gap-2">{item.attachments.map((attachment) => (
                <button key={attachment.id} type="button" onClick={() => void downloadAttachment(attachment.id)} className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-700">{attachment.fileName}</button>
              ))}</div> : null}

              <div className="grid gap-3 lg:grid-cols-2">
                {item.offers.map((offer) => (
                  <div key={offer.id} className="rounded-md border border-slate-200 p-3 text-sm">
                    <div className="flex justify-between gap-2"><strong>{offer.supplierName}</strong><span>{stateLabel(c.status, offer.status)}</span></div>
                    <p className="mt-1 text-slate-700">{c.privateCost}: {offer.currency} {offer.rawUnitCost.toFixed(4)} · {c.quantity} {offer.availableQuantity}</p>
                    <p className="text-slate-500">{c.lead} {offer.leadTimeDays ?? "-"} {c.days} · MOQ {offer.minimumOrderQuantity} · {c.expires} {new Date(offer.expiresAt).toLocaleDateString(locale)}</p>
                    {offer.warehouse || offer.incoterm ? <p className="text-slate-500">{c.warehouse}: {offer.warehouse || "-"} · {c.incoterm}: {offer.incoterm || "-"}</p> : null}
                    {offer.status === "pending" ? (
                      <div className="mt-3 grid gap-2 sm:grid-cols-2">
                        <input className={inputClass} type="number" min="0.0001" step="0.0001" placeholder={c.authorizedPrice} value={authorizedPrices[offer.id] ?? ""} onChange={(event) => setAuthorizedPrices({ ...authorizedPrices, [offer.id]: event.target.value })} />
                        <select className={inputClass} value={availability[offer.id] ?? "available"} onChange={(event) => setAvailability({ ...availability, [offer.id]: event.target.value })}>
                          <option value="available">{c.available}</option><option value="limited">{c.limited}</option><option value="unavailable">{c.unavailable}</option><option value="contact_us">{c.contact}</option>
                        </select>
                        <input className={`${inputClass} sm:col-span-2`} placeholder={c.decisionReason} value={reasons[offer.id] ?? ""} onChange={(event) => setReasons({ ...reasons, [offer.id]: event.target.value })} />
                        <button disabled={busy || !authorizedPrices[offer.id]} type="button" onClick={() => void decide(offer, "approve")} className="rounded-md bg-emerald-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">{c.approvePrice}</button>
                        <button disabled={busy} type="button" onClick={() => void decide(offer, "reject")} className="rounded-md bg-red-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">{c.reject}</button>
                      </div>
                    ) : null}
                    {offer.status === "approved" ? (
                      <div className="mt-3 space-y-2">
                        <button disabled={busy} type="button" onClick={() => void sendToOpportunityFinder(offer)} className="rounded-md bg-blue-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">{c.sendOf}</button>
                        {ofResults[offer.id] ? (
                          <div className="rounded-md bg-blue-50 p-2 text-xs text-blue-900">
                            <p><strong>{c.adapter}:</strong> {ofResults[offer.id].mappingVersion}</p>
                            <p className="break-all"><strong>{c.lot}:</strong> {ofResults[offer.id].supplyLotKey}</p>
                            <p><strong>{c.provenance}:</strong> {JSON.stringify(ofResults[offer.id].provenance)}</p>
                            <a href="/admin/opportunities" className="mt-1 inline-block font-semibold underline">{c.openOf}</a>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>

              {item.approvals.map((approval) => (
                <div key={approval.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm">
                  <p><strong>{c.authorized}:</strong> {approval.currency} {approval.authorizedUnitPrice.toFixed(4)} · {approval.coarseAvailability === "available" ? c.available : approval.coarseAvailability === "limited" ? c.limited : approval.coarseAvailability === "unavailable" ? c.unavailable : c.contact} · MOQ {approval.minimumOrderQuantity} · v{approval.version}</p>
                  <button type="button" disabled={busy || approval.status !== "active"} onClick={() => void publish(approval)} className="rounded-md bg-emerald-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">
                    {approval.publishToCatalog ? c.withdraw : c.publish}
                  </button>
                </div>
              ))}
            </article>
          ))}
          {!loading && !requests.length ? <p className="p-6 text-sm text-slate-500">{c.noRequests}</p> : null}
        </div>
      </section>

      {selected ? (
        <form onSubmit={createOffer} className="space-y-3 rounded-md border border-orange-200 bg-orange-50 p-4">
          <div className="flex justify-between gap-3"><h2 className="font-semibold text-slate-950">{c.newOffer} {selected.mpn}</h2><button type="button" onClick={() => setSelectedRequestId("")} className="text-sm text-slate-600">{c.close}</button></div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <input required className={inputClass} placeholder={c.supplier} value={offerForm.supplierName} onChange={(event) => setOfferForm({ ...offerForm, supplierName: event.target.value })} />
            <input className={inputClass} placeholder={c.supplierRef} value={offerForm.supplierReference} onChange={(event) => setOfferForm({ ...offerForm, supplierReference: event.target.value })} />
            <input required className={inputClass} placeholder={c.mpn} value={offerForm.mpn} onChange={(event) => setOfferForm({ ...offerForm, mpn: event.target.value })} />
            <input className={inputClass} placeholder={c.manufacturer} value={offerForm.manufacturer} onChange={(event) => setOfferForm({ ...offerForm, manufacturer: event.target.value })} />
            <input required type="number" min="1" className={inputClass} placeholder={c.quantity} value={offerForm.availableQuantity} onChange={(event) => setOfferForm({ ...offerForm, availableQuantity: event.target.value })} />
            <input required type="number" min="0.000001" step="0.000001" className={inputClass} placeholder={c.unitCost} value={offerForm.rawUnitCost} onChange={(event) => setOfferForm({ ...offerForm, rawUnitCost: event.target.value })} />
            <input required className={inputClass} placeholder={c.currency} value={offerForm.currency} onChange={(event) => setOfferForm({ ...offerForm, currency: event.target.value.toUpperCase() })} />
            <input type="number" min="0" className={inputClass} placeholder={c.leadDays} value={offerForm.leadTimeDays} onChange={(event) => setOfferForm({ ...offerForm, leadTimeDays: event.target.value })} />
            <input required type="number" min="1" className={inputClass} placeholder="MOQ" value={offerForm.minimumOrderQuantity} onChange={(event) => setOfferForm({ ...offerForm, minimumOrderQuantity: event.target.value })} />
            <input type="number" min="1" className={inputClass} placeholder="SPQ" value={offerForm.standardPackQuantity} onChange={(event) => setOfferForm({ ...offerForm, standardPackQuantity: event.target.value })} />
            <input className={inputClass} placeholder={c.warehouse} value={offerForm.warehouse} onChange={(event) => setOfferForm({ ...offerForm, warehouse: event.target.value })} />
            <input className={inputClass} placeholder={c.incoterm} value={offerForm.incoterm} onChange={(event) => setOfferForm({ ...offerForm, incoterm: event.target.value.toUpperCase() })} />
            <input required type="datetime-local" className={inputClass} value={offerForm.expiresAt} onChange={(event) => setOfferForm({ ...offerForm, expiresAt: event.target.value })} />
            <input className={inputClass} placeholder={c.condition} value={offerForm.condition} onChange={(event) => setOfferForm({ ...offerForm, condition: event.target.value })} />
            <input className={inputClass} placeholder={c.dateCode} value={offerForm.dateCode} onChange={(event) => setOfferForm({ ...offerForm, dateCode: event.target.value })} />
            <input className={inputClass} placeholder={c.countryOfOrigin} value={offerForm.countryOfOrigin} onChange={(event) => setOfferForm({ ...offerForm, countryOfOrigin: event.target.value })} />
          </div>
          <textarea className={`${inputClass} w-full`} placeholder={c.privateNotes} value={offerForm.notes} onChange={(event) => setOfferForm({ ...offerForm, notes: event.target.value })} />
          <button disabled={busy} className="rounded-md bg-orange-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{c.saveOffer}</button>
        </form>
      ) : null}
    </div>
  );
}

export function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function adminMessageHtml(input: { subject: string; body: string; senderName: string }) {
  const paragraphs = escapeHtml(input.body)
    .split(/\r?\n/)
    .map((line) => (line.trim() ? `<p style="margin:0 0 12px">${line}</p>` : "<br>"))
    .join("");

  return `
    <div style="font-family:Arial,sans-serif;color:#0f172a;line-height:1.6;max-width:640px">
      <div style="border-bottom:3px solid #ea580c;padding-bottom:12px;margin-bottom:20px">
        <strong style="color:#c2410c">Quiksol Excel Intelligence System</strong>
      </div>
      <h2 style="margin:0 0 16px">${escapeHtml(input.subject)}</h2>
      <div>${paragraphs}</div>
      <p style="margin-top:24px;font-size:12px;color:#64748b">Enviado por ${escapeHtml(input.senderName)} desde el centro de correo de Quiksol.</p>
    </div>
  `;
}

export const EMAIL_TEMPLATES = [
  {
    id: "upload-review",
    name: "Revision de archivo",
    subject: "[Quiksol] Archivo pendiente de revision",
    body: "Hola,\n\nHay un archivo que requiere tu revision en Quiksol. Por favor ingresa al sistema, valida los datos y responde cuando termines.\n\nGracias."
  },
  {
    id: "data-quality",
    name: "Calidad de datos",
    subject: "[Quiksol] Seguimiento de calidad de datos",
    body: "Hola,\n\nEncontramos datos que necesitan correccion. Revisa los errores de importacion y vuelve a cargar el archivo cuando este listo.\n\nGracias."
  },
  {
    id: "team-update",
    name: "Actualizacion de equipo",
    subject: "[Quiksol] Actualizacion del equipo",
    body: "Hola equipo,\n\nCompartimos la siguiente actualizacion:\n\n[Escribe aqui la informacion]\n\nGracias."
  }
] as const;

export const EMAIL_ALERT_EVENT_OPTIONS = [
  { value: "upload_completed", label: "Nuevo Excel procesado", example: "Avisa cuando una carga termina correctamente.", condition: "" },
  { value: "upload_failed", label: "Carga fallida", example: "Avisa cuando Quiksol no puede procesar un archivo.", condition: "" },
  { value: "upload_has_many_errors", label: "Archivo con muchos errores", example: "Ejemplo: enviar si el archivo supera 200 errores.", condition: "error_count_gt" },
  { value: "low_gp_rate", label: "GP rate por debajo del limite", example: "Ejemplo: enviar si GP rate baja de 15%.", condition: "gp_rate_lt" },
  { value: "missing_mpn_threshold", label: "Demasiados registros sin MPN", example: "Ejemplo: enviar si hay mas de 20 registros sin MPN.", condition: "missing_mpn_gt" },
  { value: "import_quality_below_threshold", label: "Calidad de importacion baja", example: "Ejemplo: enviar si la calidad baja de 90%.", condition: "quality_score_lt" },
  { value: "weekly_report", label: "Reporte semanal", example: "Resumen semanal para los destinatarios seleccionados.", condition: "" },
  { value: "new_dataset_published", label: "Nuevo conjunto de datos publicado", example: "Avisa cuando se publica informacion nueva.", condition: "" }
] as const;

export const EMAIL_ALERT_CONDITION_OPTIONS = [
  { value: "", label: "Sin condicion numerica" },
  { value: "error_count_gt", label: "Cantidad de errores mayor que" },
  { value: "gp_rate_lt", label: "GP rate menor que (%)" },
  { value: "missing_mpn_gt", label: "Registros sin MPN mayor que" },
  { value: "quality_score_lt", label: "Calidad menor que (%)" }
] as const;

export function emailAlertEventLabel(value: string) {
  return EMAIL_ALERT_EVENT_OPTIONS.find((item) => item.value === value)?.label ?? value;
}

export function emailAlertConditionLabel(value: string | null | undefined) {
  if (!value) return "Siempre que ocurra";
  return EMAIL_ALERT_CONDITION_OPTIONS.find((item) => item.value === value)?.label ?? value;
}

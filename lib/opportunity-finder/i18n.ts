import type { Language } from "@/lib/i18n";
import type {
  OpportunityActionCode,
  OpportunityFileType,
  OpportunityJobStage,
  OpportunityJobStatus,
  OpportunityReasonCode,
  OpportunitySelectedRole,
  OpportunityType,
  OpportunityWarningCode
} from "@/lib/opportunity-finder/types";

const copy = {
  es: {
    eyebrow: "Herramientas de ventas",
    title: "Buscador de oportunidades",
    description: "Compara exclusivamente dos archivos para encontrar coincidencias exactas de MPN y asignar la disponibilidad sin doble conteo.",
    steps: ["Subir archivos", "Confirmar roles", "Procesamiento", "Resultados"],
    fileA: "Archivo 1",
    fileB: "Archivo 2",
    needsFile: "Archivo de necesidades",
    supplyFile: "Archivo de disponibilidad",
    dropPrompt: "Arrastra un archivo aquí o selecciónalo",
    accepted: "XLSX o CSV, sin macros. Máximo 64 MB por archivo.",
    selectFile: "Seleccionar archivo",
    replaceFile: "Cambiar archivo",
    uploadFiles: "Subir y analizar archivos",
    uploading: "Subiendo archivos",
    detectedType: "Tipo detectado",
    selectedRole: "Rol",
    sheets: "Hojas",
    rows: "Filas estimadas",
    size: "Tamaño",
    validation: "Validación",
    valid: "Válido",
    swapRoles: "Intercambiar roles",
    find: "Buscar oportunidades",
    cancel: "Cancelar",
    retry: "Reintentar",
    startAnother: "Empezar otra comparación",
    deleteJob: "Eliminar comparación",
    processingHint: "Puedes salir de esta pantalla. El trabajo y el progreso quedan guardados.",
    reusedComparisonNotice: "Se encontró una comparación anterior realizada con estos mismos archivos. Estás viendo sus resultados guardados.",
    reusedComparisonStatus: "Estado guardado",
    compatibilityTitle: "Esta combinación no es compatible",
    compatibility: {
      unknown_role: "Confirma un rol válido para los dos archivos.",
      ignored_file: "Los dos archivos deben participar en la comparación.",
      financial_file: "La información financiera no es compatible con búsquedas de oportunidades por MPN.",
      requires_demand: "Ambos archivos representan oferta, inventario o exceso. Compara uno contra un archivo de necesidades o demanda.",
      two_demand_files: "Los dos archivos representan demanda. El segundo debe contener inventario, exceso u oferta de proveedor.",
      two_history_files: "Dos archivos históricos no confirman una oportunidad actual. Agrega un archivo de demanda.",
      unsupported_pair: "Esta combinación no permite detectar oportunidades por MPN."
    },
    summary: {
      analyzedMpns: "MPN analizados",
      exactMatches: "Coincidencias exactas de MPN",
      usableAvailabilityMatches: "MPN con disponibilidad utilizable",
      exactQuantityMatches: "Cantidades exactas",
      fullSales: "Ventas completas",
      partialSales: "Ventas parciales",
      sourcingNeeded: "Sourcing requerido",
      excessResales: "Reventas de exceso",
      supplierOfferMatches: "Ofertas disponibles",
      supplyWithoutDemand: "Inventario sin demanda",
      historicalSignals: "Coincidencias históricas",
      reviewRequired: "Revisión requerida",
      missingMpnRows: "Filas sin MPN",
      invalidQuantityRows: "Cantidades inválidas",
      possibleMatches: "Posibles coincidencias"
    },
    filters: {
      title: "Filtros",
      mpn: "MPN",
      manufacturer: "Fabricante",
      context: "Cliente o contexto",
      type: "Tipo de oportunidad",
      file: "Archivo",
      all: "Todos",
      exactOnly: "Solo coincidencias exactas de MPN",
      exactOnlyHelp: "Compara el número de parte normalizado. No significa que las cantidades sean idénticas.",
      withShortage: "Con faltante",
      withAvailable: "Con disponibilidad utilizable",
      apply: "Aplicar filtros",
      clear: "Limpiar"
    },
    card: {
      manufacturer: "Fabricante",
      customer: "Cliente o contexto",
      supplier: "Fuente o proveedor",
      required: "Cantidad requerida",
      available: "Disponibilidad original",
      allocated: "Cantidad asignada",
      shortage: "Faltante",
      coverage: "Cobertura",
      requiredDate: "Fecha requerida",
      unit: "Unidad",
      exactMpnMatch: "MPN exacto",
      usableAvailabilityMatch: "Disponibilidad utilizable",
      exactQuantity: "Cantidad exacta",
      yes: "Sí",
      no: "No",
      demandSource: "Necesidad",
      supplySource: "Oferta",
      groupedRows: "Filas agrupadas",
      reason: "Razón",
      action: "Acción recomendada",
      warnings: "Advertencias de calidad",
      viewSource: "Ver origen",
      hideSource: "Ocultar origen",
      export: "Exportar",
      unspecified: "No especificado"
    },
    resultsTitle: "Oportunidades detectadas",
    noResults: "No hay resultados para los filtros actuales.",
    possibleTitle: "Posibles coincidencias para revisar",
    possibleDescription: "Estas variantes solo coinciden al ignorar símbolos. No se incluyeron como oportunidades exactas.",
    loadMore: "Cargar más",
    exportCsv: "Exportar CSV",
    exportXlsx: "Exportar XLSX",
    errors: {
      default: "No se pudo completar la operación.",
      EXACTLY_TWO_FILES_REQUIRED: "Selecciona exactamente dos archivos.",
      FILE_TOO_LARGE: "Uno de los archivos supera el límite permitido.",
      FILE_TYPE_BLOCKED: "Los archivos con macros, scripts o ejecutables no están permitidos.",
      FILE_EXTENSION_INVALID: "Solo se aceptan archivos XLSX o CSV.",
      FILE_MIME_INVALID: "El tipo real del archivo no es compatible.",
      STORAGE_NOT_CONFIGURED: "El almacenamiento privado no está configurado.",
      FINANCIAL_FILE_INCOMPATIBLE: "Este archivo contiene información financiera y no es compatible con una búsqueda por MPN.",
      ROLES_INCOMPATIBLE: "Los roles seleccionados no forman una comparación compatible.",
      SOURCE_FILE_EXPIRED: "Los archivos temporales ya expiraron. Inicia una nueva comparación.",
      JOB_CANCELLED: "La comparación fue cancelada.",
      FILE_SIGNATURE_INVALID: "La firma interna del archivo no coincide con su extensión.",
      MACRO_FILE_BLOCKED: "El archivo contiene macros y fue bloqueado.",
      OPPORTUNITY_PROCESSING_FAILED: "El procesamiento falló. Puedes reintentar."
    }
  },
  en: {
    eyebrow: "Sales tools",
    title: "Opportunity Finder",
    description: "Compare exactly two files to find exact MPN matches and allocate availability without double counting.",
    steps: ["Upload files", "Confirm roles", "Processing", "Results"],
    fileA: "File 1",
    fileB: "File 2",
    needsFile: "Needs file",
    supplyFile: "Availability file",
    dropPrompt: "Drop a file here or choose one",
    accepted: "XLSX or CSV, no macros. Maximum 64 MB per file.",
    selectFile: "Choose file",
    replaceFile: "Replace file",
    uploadFiles: "Upload and analyze files",
    uploading: "Uploading files",
    detectedType: "Detected type",
    selectedRole: "Role",
    sheets: "Sheets",
    rows: "Estimated rows",
    size: "Size",
    validation: "Validation",
    valid: "Valid",
    swapRoles: "Swap roles",
    find: "Find opportunities",
    cancel: "Cancel",
    retry: "Retry",
    startAnother: "Start another comparison",
    deleteJob: "Delete comparison",
    processingHint: "You can leave this screen. The job and its real progress are persisted.",
    reusedComparisonNotice: "A previous comparison made with these same files was found. You are viewing its saved results.",
    reusedComparisonStatus: "Saved status",
    compatibilityTitle: "This combination is not compatible",
    compatibility: {
      unknown_role: "Confirm a valid role for both files.",
      ignored_file: "Both files must participate in the comparison.",
      financial_file: "Financial information is not compatible with MPN opportunity searches.",
      requires_demand: "Both files represent supply, inventory, or excess. Compare one of them with a needs or demand file.",
      two_demand_files: "Both files represent demand. The second file must contain stock, excess, or a supplier offer.",
      two_history_files: "Two historical files do not confirm a current opportunity. Add a demand file.",
      unsupported_pair: "This combination cannot produce MPN opportunities."
    },
    summary: {
      analyzedMpns: "MPNs analyzed",
      exactMatches: "Exact MPN matches",
      usableAvailabilityMatches: "MPNs with usable availability",
      exactQuantityMatches: "Exact quantities",
      fullSales: "Full sales",
      partialSales: "Partial sales",
      sourcingNeeded: "Sourcing needed",
      excessResales: "Excess resales",
      supplierOfferMatches: "Available offers",
      supplyWithoutDemand: "Supply without demand",
      historicalSignals: "Historical matches",
      reviewRequired: "Review required",
      missingMpnRows: "Rows without MPN",
      invalidQuantityRows: "Invalid quantities",
      possibleMatches: "Possible matches"
    },
    filters: {
      title: "Filters",
      mpn: "MPN",
      manufacturer: "Manufacturer",
      context: "Customer or context",
      type: "Opportunity type",
      file: "File",
      all: "All",
      exactOnly: "Exact MPN matches only",
      exactOnlyHelp: "Compares the normalized part number. It does not mean the quantities are identical.",
      withShortage: "With shortage",
      withAvailable: "With usable availability",
      apply: "Apply filters",
      clear: "Clear"
    },
    card: {
      manufacturer: "Manufacturer",
      customer: "Customer or context",
      supplier: "Source or supplier",
      required: "Required quantity",
      available: "Original availability",
      allocated: "Allocated quantity",
      shortage: "Shortage",
      coverage: "Coverage",
      requiredDate: "Required date",
      unit: "Unit",
      exactMpnMatch: "Exact MPN",
      usableAvailabilityMatch: "Usable availability",
      exactQuantity: "Exact quantity",
      yes: "Yes",
      no: "No",
      demandSource: "Need",
      supplySource: "Supply",
      groupedRows: "Grouped rows",
      reason: "Reason",
      action: "Recommended action",
      warnings: "Data quality warnings",
      viewSource: "View source",
      hideSource: "Hide source",
      export: "Export",
      unspecified: "Not specified"
    },
    resultsTitle: "Detected opportunities",
    noResults: "No results match the current filters.",
    possibleTitle: "Possible matches to review",
    possibleDescription: "These variants match only when symbols are ignored. They were not included as exact opportunities.",
    loadMore: "Load more",
    exportCsv: "Export CSV",
    exportXlsx: "Export XLSX",
    errors: {
      default: "The operation could not be completed.",
      EXACTLY_TWO_FILES_REQUIRED: "Select exactly two files.",
      FILE_TOO_LARGE: "One of the files exceeds the allowed size.",
      FILE_TYPE_BLOCKED: "Files containing macros, scripts, or executables are not allowed.",
      FILE_EXTENSION_INVALID: "Only XLSX or CSV files are accepted.",
      FILE_MIME_INVALID: "The actual file type is not compatible.",
      STORAGE_NOT_CONFIGURED: "Private storage is not configured.",
      FINANCIAL_FILE_INCOMPATIBLE: "This file contains financial information and is not compatible with an MPN search.",
      ROLES_INCOMPATIBLE: "The selected roles do not form a compatible comparison.",
      SOURCE_FILE_EXPIRED: "The temporary files have expired. Start a new comparison.",
      JOB_CANCELLED: "The comparison was cancelled.",
      FILE_SIGNATURE_INVALID: "The file signature does not match its extension.",
      MACRO_FILE_BLOCKED: "The file contains macros and was blocked.",
      OPPORTUNITY_PROCESSING_FAILED: "Processing failed. You can retry."
    }
  },
  zh: {
    eyebrow: "销售工具",
    title: "销售机会查找器",
    description: "仅比较两个文件，查找完全匹配的 MPN，并在不重复计算的情况下分配可用数量。",
    steps: ["上传文件", "确认角色", "处理中", "结果"],
    fileA: "文件 1",
    fileB: "文件 2",
    needsFile: "需求文件",
    supplyFile: "可用库存文件",
    dropPrompt: "将文件拖到此处或选择文件",
    accepted: "支持 XLSX 或 CSV，不允许宏。每个文件最大 64 MB。",
    selectFile: "选择文件",
    replaceFile: "更换文件",
    uploadFiles: "上传并分析文件",
    uploading: "正在上传文件",
    detectedType: "检测到的类型",
    selectedRole: "角色",
    sheets: "工作表",
    rows: "预计行数",
    size: "大小",
    validation: "验证",
    valid: "有效",
    swapRoles: "交换角色",
    find: "查找销售机会",
    cancel: "取消",
    retry: "重试",
    startAnother: "开始新的比较",
    deleteJob: "删除比较",
    processingHint: "你可以离开此页面。任务及其真实进度会被保存。",
    reusedComparisonNotice: "找到一个使用相同文件创建的历史比较。当前显示的是已保存的结果。",
    reusedComparisonStatus: "已保存状态",
    compatibilityTitle: "此组合不兼容",
    compatibility: {
      unknown_role: "请为两个文件确认有效角色。",
      ignored_file: "两个文件都必须参与比较。",
      financial_file: "财务信息不适用于按 MPN 查找销售机会。",
      requires_demand: "两个文件都表示供应、库存或过剩。请将其中一个与需求文件比较。",
      two_demand_files: "两个文件都表示需求。第二个文件应包含库存、过剩或供应商报价。",
      two_history_files: "两个历史文件无法确认当前机会。请添加需求文件。",
      unsupported_pair: "此组合无法生成 MPN 销售机会。"
    },
    summary: {
      analyzedMpns: "已分析 MPN",
      exactMatches: "MPN 完全匹配",
      usableAvailabilityMatches: "有可用库存的 MPN",
      exactQuantityMatches: "数量完全相同",
      fullSales: "完全可售",
      partialSales: "部分可售",
      sourcingNeeded: "需要采购",
      excessResales: "过剩转售",
      supplierOfferMatches: "可用报价",
      supplyWithoutDemand: "有库存无需求",
      historicalSignals: "历史匹配",
      reviewRequired: "需要审核",
      missingMpnRows: "缺少 MPN 的行",
      invalidQuantityRows: "数量无效",
      possibleMatches: "可能匹配"
    },
    filters: {
      title: "筛选",
      mpn: "MPN",
      manufacturer: "制造商",
      context: "客户或上下文",
      type: "机会类型",
      file: "文件",
      all: "全部",
      exactOnly: "仅显示 MPN 完全匹配",
      exactOnlyHelp: "比较标准化的零件号，并不表示数量必须相同。",
      withShortage: "有缺口",
      withAvailable: "有可用库存",
      apply: "应用筛选",
      clear: "清除"
    },
    card: {
      manufacturer: "制造商",
      customer: "客户或上下文",
      supplier: "来源或供应商",
      required: "需求数量",
      available: "原始可用数量",
      allocated: "已分配数量",
      shortage: "缺口",
      coverage: "覆盖率",
      requiredDate: "需求日期",
      unit: "单位",
      exactMpnMatch: "MPN 完全匹配",
      usableAvailabilityMatch: "可用库存",
      exactQuantity: "数量完全相同",
      yes: "是",
      no: "否",
      demandSource: "需求来源",
      supplySource: "供应来源",
      groupedRows: "合并行数",
      reason: "原因",
      action: "建议操作",
      warnings: "数据质量警告",
      viewSource: "查看来源",
      hideSource: "隐藏来源",
      export: "导出",
      unspecified: "未指定"
    },
    resultsTitle: "检测到的销售机会",
    noResults: "当前筛选条件下没有结果。",
    possibleTitle: "需要审核的可能匹配",
    possibleDescription: "这些变体仅在忽略符号时匹配，因此未作为完全匹配的机会。",
    loadMore: "加载更多",
    exportCsv: "导出 CSV",
    exportXlsx: "导出 XLSX",
    errors: {
      default: "无法完成操作。",
      EXACTLY_TWO_FILES_REQUIRED: "请选择两个文件。",
      FILE_TOO_LARGE: "其中一个文件超过允许的大小。",
      FILE_TYPE_BLOCKED: "不允许包含宏、脚本或可执行内容的文件。",
      FILE_EXTENSION_INVALID: "仅接受 XLSX 或 CSV 文件。",
      FILE_MIME_INVALID: "文件的实际类型不兼容。",
      STORAGE_NOT_CONFIGURED: "私有存储尚未配置。",
      FINANCIAL_FILE_INCOMPATIBLE: "此文件包含财务信息，不适用于按 MPN 搜索。",
      ROLES_INCOMPATIBLE: "所选角色无法形成有效比较。",
      SOURCE_FILE_EXPIRED: "临时文件已过期，请开始新的比较。",
      JOB_CANCELLED: "比较已取消。",
      FILE_SIGNATURE_INVALID: "文件签名与扩展名不匹配。",
      MACRO_FILE_BLOCKED: "文件包含宏，已被阻止。",
      OPPORTUNITY_PROCESSING_FAILED: "处理失败，可以重试。"
    }
  }
} as const;

export const FILE_TYPE_LABELS: Record<Language, Record<OpportunityFileType, string>> = {
  es: {
    demand: "Demanda planificada",
    stock: "Inventario disponible",
    excess: "Exceso",
    supplier_offer: "Oferta de proveedor",
    received_history: "Historial de recepciones",
    sales_history: "Historial de ventas (soporte parcial)",
    financial: "Información financiera",
    unknown: "Desconocido"
  },
  en: {
    demand: "Planned demand",
    stock: "Available stock",
    excess: "Excess",
    supplier_offer: "Supplier offer",
    received_history: "Received history",
    sales_history: "Sales history (partial support)",
    financial: "Financial information",
    unknown: "Unknown"
  },
  zh: {
    demand: "计划需求",
    stock: "可用库存",
    excess: "过剩库存",
    supplier_offer: "供应商报价",
    received_history: "收货历史",
    sales_history: "销售历史（部分支持）",
    financial: "财务信息",
    unknown: "未知"
  }
};

export const ROLE_LABELS: Record<Language, Record<OpportunitySelectedRole, string>> = {
  es: {
    demand: "Necesidades / demanda",
    stock: "Inventario disponible",
    excess: "Exceso",
    supplier_offer: "Oferta de proveedor",
    received_history: "Historial de recepciones",
    sales_history: "Historial de ventas",
    ignore: "No utilizar para oportunidades"
  },
  en: {
    demand: "Needs / demand",
    stock: "Available stock",
    excess: "Excess",
    supplier_offer: "Supplier offer",
    received_history: "Received history",
    sales_history: "Sales history",
    ignore: "Do not use for opportunities"
  },
  zh: {
    demand: "需求",
    stock: "可用库存",
    excess: "过剩库存",
    supplier_offer: "供应商报价",
    received_history: "收货历史",
    sales_history: "销售历史",
    ignore: "不用于销售机会"
  }
};

export const OPPORTUNITY_TYPE_LABELS: Record<Language, Record<OpportunityType, string>> = {
  es: {
    full_sale: "Venta completa",
    partial_sale: "Venta parcial",
    sourcing_needed: "Sourcing requerido",
    excess_resale: "Reventa de exceso",
    supplier_offer_match: "Oferta disponible",
    supply_without_demand: "Inventario sin necesidad detectada",
    historical_signal: "Coincidencia histórica",
    review_required: "Revisión requerida"
  },
  en: {
    full_sale: "Full sale",
    partial_sale: "Partial sale",
    sourcing_needed: "Sourcing needed",
    excess_resale: "Excess resale",
    supplier_offer_match: "Available offer",
    supply_without_demand: "Supply without detected demand",
    historical_signal: "Historical match",
    review_required: "Review required"
  },
  zh: {
    full_sale: "完全可售",
    partial_sale: "部分可售",
    sourcing_needed: "需要采购",
    excess_resale: "过剩转售",
    supplier_offer_match: "可用报价",
    supply_without_demand: "有库存无需求",
    historical_signal: "历史匹配",
    review_required: "需要审核"
  }
};

const REASONS: Record<Language, Record<OpportunityReasonCode, string>> = {
  es: {
    full_coverage: "La disponibilidad cubre toda la cantidad requerida.",
    partial_coverage: "La disponibilidad cubre solo una parte de la necesidad.",
    no_available_supply: "No hay disponibilidad positiva para este MPN exacto.",
    excess_covers_demand: "El exceso coincide exactamente con la necesidad.",
    supplier_offer_available: "La oferta del proveedor contiene el MPN solicitado.",
    historical_match_only: "Este MPN tiene historial, pero el archivo no confirma disponibilidad actual.",
    manufacturer_conflict: "El MPN coincide, pero el fabricante requiere revisión.",
    missing_unit: "La unidad de medida no está especificada.",
    incompatible_unit: "Las unidades de medida no son compatibles.",
    invalid_quantity: "La cantidad no es válida para una asignación automática.",
    supply_has_no_demand: "Hay disponibilidad positiva y el archivo de demanda no contiene este MPN."
  },
  en: {
    full_coverage: "Availability covers the full required quantity.",
    partial_coverage: "Availability covers only part of the need.",
    no_available_supply: "There is no positive availability for this exact MPN.",
    excess_covers_demand: "The excess source exactly matches the need.",
    supplier_offer_available: "The supplier offer contains the requested MPN.",
    historical_match_only: "This MPN has history, but the file does not confirm current availability.",
    manufacturer_conflict: "The MPN matches, but the manufacturer requires review.",
    missing_unit: "The unit of measure is not specified.",
    incompatible_unit: "The units of measure are not compatible.",
    invalid_quantity: "The quantity is not valid for automatic allocation.",
    supply_has_no_demand: "Positive availability exists and the demand file does not contain this MPN."
  },
  zh: {
    full_coverage: "可用数量可覆盖全部需求。",
    partial_coverage: "可用数量只能覆盖部分需求。",
    no_available_supply: "此完全匹配的 MPN 没有正数可用数量。",
    excess_covers_demand: "过剩库存与需求的 MPN 完全匹配。",
    supplier_offer_available: "供应商报价包含所需 MPN。",
    historical_match_only: "此 MPN 有历史记录，但文件未确认当前可用数量。",
    manufacturer_conflict: "MPN 匹配，但制造商需要审核。",
    missing_unit: "未指定计量单位。",
    incompatible_unit: "计量单位不兼容。",
    invalid_quantity: "数量无效，无法自动分配。",
    supply_has_no_demand: "存在正数可用数量，但需求文件中没有此 MPN。"
  }
};

const ACTIONS: Record<Language, Record<OpportunityActionCode, string>> = {
  es: {
    offer_full_quantity: "Ofrecer la cantidad completa.",
    offer_available_quantity: "Ofrecer la cantidad disponible.",
    source_remaining_quantity: "Ofrecer lo disponible y buscar la cantidad restante.",
    contact_supplier: "Contactar al proveedor o iniciar sourcing.",
    find_buyer: "Buscar un comprador para la disponibilidad detectada.",
    review_manufacturer: "Revisar el fabricante antes de confirmar la venta.",
    review_quantity: "Validar cantidad y unidad antes de asignar.",
    upload_current_stock: "Cargar inventario actual para confirmar disponibilidad."
  },
  en: {
    offer_full_quantity: "Offer the full quantity.",
    offer_available_quantity: "Offer the available quantity.",
    source_remaining_quantity: "Offer what is available and source the remaining quantity.",
    contact_supplier: "Contact the supplier or start sourcing.",
    find_buyer: "Find a buyer for the detected availability.",
    review_manufacturer: "Review the manufacturer before confirming the sale.",
    review_quantity: "Validate quantity and unit before allocation.",
    upload_current_stock: "Upload current stock to confirm availability."
  },
  zh: {
    offer_full_quantity: "提供全部数量。",
    offer_available_quantity: "提供可用数量。",
    source_remaining_quantity: "提供可用数量并采购剩余数量。",
    contact_supplier: "联系供应商或开始采购。",
    find_buyer: "为检测到的可用库存寻找买家。",
    review_manufacturer: "确认销售前审核制造商。",
    review_quantity: "分配前验证数量和单位。",
    upload_current_stock: "上传当前库存以确认可用数量。"
  }
};

const WARNINGS: Record<Language, Record<OpportunityWarningCode, string>> = {
  es: {
    manufacturer_conflict: "Revisar fabricante",
    missing_unit: "Unidad no especificada",
    incompatible_unit: "Unidad incompatible",
    invalid_required_quantity: "Cantidad requerida inválida",
    invalid_available_quantity: "Cantidad disponible inválida",
    negative_available_quantity: "Cantidad negativa ignorada",
    multiple_manufacturers: "Varios fabricantes en el origen",
    historical_not_current_stock: "El historial no confirma stock actual"
  },
  en: {
    manufacturer_conflict: "Review manufacturer",
    missing_unit: "Unit not specified",
    incompatible_unit: "Incompatible unit",
    invalid_required_quantity: "Invalid required quantity",
    invalid_available_quantity: "Invalid available quantity",
    negative_available_quantity: "Negative quantity ignored",
    multiple_manufacturers: "Multiple manufacturers in source",
    historical_not_current_stock: "History does not confirm current stock"
  },
  zh: {
    manufacturer_conflict: "审核制造商",
    missing_unit: "未指定单位",
    incompatible_unit: "单位不兼容",
    invalid_required_quantity: "需求数量无效",
    invalid_available_quantity: "可用数量无效",
    negative_available_quantity: "已忽略负数数量",
    multiple_manufacturers: "来源中有多个制造商",
    historical_not_current_stock: "历史记录不代表当前库存"
  }
};

export const STATUS_LABELS: Record<Language, Record<OpportunityJobStatus, string>> = {
  es: {
    uploading: "Cargando",
    queued: "En cola",
    profiling: "Inspeccionando archivos",
    awaiting_roles: "Esperando confirmación",
    parsing: "Normalizando datos",
    matching: "Buscando coincidencias",
    completed: "Completado",
    completed_with_warnings: "Completado con advertencias",
    failed: "Fallido",
    cancelled: "Cancelado"
  },
  en: {
    uploading: "Uploading",
    queued: "Queued",
    profiling: "Inspecting files",
    awaiting_roles: "Awaiting confirmation",
    parsing: "Normalizing data",
    matching: "Finding matches",
    completed: "Completed",
    completed_with_warnings: "Completed with warnings",
    failed: "Failed",
    cancelled: "Cancelled"
  },
  zh: {
    uploading: "正在上传",
    queued: "排队中",
    profiling: "正在检查文件",
    awaiting_roles: "等待确认",
    parsing: "正在标准化数据",
    matching: "正在查找匹配",
    completed: "已完成",
    completed_with_warnings: "已完成但有警告",
    failed: "失败",
    cancelled: "已取消"
  }
};

export const STAGE_LABELS: Record<Language, Record<OpportunityJobStage, string>> = {
  es: {
    uploading: "Cargando",
    inspecting_sheets: "Inspeccionando hojas",
    detecting_headers: "Detectando encabezados",
    confirming_roles: "Confirmando roles",
    normalizing_mpn: "Normalizando MPN",
    grouping_quantities: "Agrupando cantidades",
    finding_matches: "Buscando coincidencias",
    generating_opportunities: "Generando oportunidades",
    completed: "Completado"
  },
  en: {
    uploading: "Uploading",
    inspecting_sheets: "Inspecting sheets",
    detecting_headers: "Detecting headers",
    confirming_roles: "Confirming roles",
    normalizing_mpn: "Normalizing MPN",
    grouping_quantities: "Grouping quantities",
    finding_matches: "Finding matches",
    generating_opportunities: "Generating opportunities",
    completed: "Completed"
  },
  zh: {
    uploading: "正在上传",
    inspecting_sheets: "正在检查工作表",
    detecting_headers: "正在检测表头",
    confirming_roles: "正在确认角色",
    normalizing_mpn: "正在标准化 MPN",
    grouping_quantities: "正在汇总数量",
    finding_matches: "正在查找匹配",
    generating_opportunities: "正在生成销售机会",
    completed: "已完成"
  }
};

export function opportunityFinderCopy(language: Language) {
  return copy[language];
}

export function opportunityReasonLabel(language: Language, code: OpportunityReasonCode) {
  return REASONS[language][code];
}

export function opportunityActionLabel(language: Language, code: OpportunityActionCode) {
  return ACTIONS[language][code];
}

export function opportunityWarningLabel(language: Language, code: OpportunityWarningCode) {
  return WARNINGS[language][code];
}

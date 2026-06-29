# README de valoración empresarial: Quiksol Excel Intelligence System

Documento preparado para valoración comercial, técnica y empresarial del repositorio actual.

Fecha de revisión: 2026-06-29  
Base de revisión: código fuente, rutas Next.js, migraciones Supabase, componentes, servicios, configuración, tests y documentación presente en el repositorio.

> Nota de honestidad técnica: este documento describe lo que existe en el repositorio. Cuando una capacidad depende de migraciones, variables de entorno, proveedores externos o configuración de producción, se marca como "requiere configuración" o "parcial". No se asume que todo esté funcionando en producción si el código o la base de datos actual muestran lo contrario.

> Actualización posterior de implementación: se agregó una fase de hardening para privacidad de chat, auditoría admin separada, directorio de empleados, bio/cargo de perfil y email center manual con adjuntos. La migración nueva es `supabase/migrations/20260630000000_chat_privacy_email_center_profiles.sql` y el reporte técnico está en `docs/CHAT_PRIVACY_AND_EMAIL_CENTER_REPORT.md`.

---

## 1. Resumen ejecutivo

**Quiksol Excel Intelligence System** es una plataforma interna empresarial para centralizar, procesar, auditar y explotar información comercial que normalmente vive dispersa en archivos Excel/CSV. No es una página web simple: es un sistema con frontend administrativo, API backend, autenticación, roles, Supabase Auth, base de datos relacional, RLS, storage, parser de Excel, búsqueda, analítica, IA conectada a datos, voz, correos, alertas, chat interno, avatares, logging, auditoría y módulos de administración.

La propuesta comercial central es:

**Quiksol convierte archivos Excel operativos en una base de inteligencia empresarial consultable, auditada y protegida, reduciendo horas de búsqueda manual y mejorando decisiones sobre MPN, proveedores, clientes, precios, márgenes y cargas internas.**

El proyecto está orientado a empresas que manejan información de compras, ventas, RFQ, márgenes, logística, inventario, proveedores y clientes mediante hojas de cálculo. Su valor está en transformar esa operación manual en un sistema interno con trazabilidad, seguridad, métricas y automatización progresiva.

Estado honesto del producto:

| Clasificación | Evaluación |
|---|---|
| Demo simple | Superado. El repositorio tiene módulos reales de negocio, auth, importación, analytics, administración, IA y migraciones. |
| MVP funcional | Sí, siempre que Supabase, migraciones y variables estén correctamente configuradas. |
| MVP empresarial controlado | Sí como objetivo actual, pero con incidentes pendientes en producción y dependencias de configuración. |
| Producto enterprise listo | Parcial. Requiere hardening, monitoreo, revisión RLS, backups probados, SLA, MFA/CAPTCHA y validación con usuarios reales. |
| SaaS escalable | Todavía no. La arquitectura permite evolucionar, pero faltan multi-tenant formal, billing, workers, colas, observabilidad externa y contratos operativos. |

---

## 2. Problema que resuelve

El sistema ataca problemas típicos en empresas que dependen de Excel para operar:

| Problema | Cómo lo aborda Quiksol |
|---|---|
| Información dispersa en hojas de cálculo | Centraliza cargas en Supabase y registra batches, sheets y records. |
| Dificultad para encontrar MPN, proveedores, clientes, PO, precios y márgenes | Ofrece registros consultables, búsqueda global, buscador ejecutivo y comparador de MPN. |
| Falta de trazabilidad | Registra quién subió qué, cuándo, con qué estado y con qué errores. |
| Errores invisibles en archivos | El parser valida columnas, datos, calidad, duplicados y errores por celda/fila. |
| Control débil de acceso | Implementa roles admin, manager y employee, rutas protegidas, RLS y guardas. |
| Pérdida de tiempo buscando datos | Agrega filtros, búsquedas, analytics y consultas asistidas por IA. |
| Falta de dashboards ejecutivos | Construye dashboard, analytics por categoría, empleados, clientes, proveedores y MPN. |
| Comunicación interna fragmentada | Incluye módulo de chat interno con conversaciones, grupos, adjuntos y realtime si está configurado. |
| Dependencia manual del equipo | Automatiza importación, normalización, alertas, consultas y parte del análisis operativo. |
| Riesgo de fuga de datos | Usa Supabase Auth, service role solo servidor, políticas RLS, CSP, validaciones y restricciones de IA. |

Ejemplo de impacto operativo: en vez de abrir múltiples archivos para saber qué proveedor ofreció mejor precio para un MPN, un usuario puede buscar el MPN, ver ofertas históricas, ranking de proveedores, precio, disponibilidad, lead time y calidad del dato.

---

## 3. Valor de negocio

| Categoría | Valor empresarial |
|---|---|
| Ahorro operativo | Reduce búsqueda manual en Excel, consolidación de datos y revisión de archivos. |
| Reducción de errores | Detecta columnas inválidas, datos faltantes, fórmulas peligrosas, duplicados y errores de importación. |
| Centralización | Convierte múltiples hojas en tablas consultables y auditables. |
| Trazabilidad | Permite saber archivo, usuario, fecha, estado, errores y registros importados. |
| Auditoría | Registra eventos de auditoría, seguridad, logs de sistema, cliente y performance. |
| Seguridad por roles | Segmenta acceso admin, manager y employee; protege rutas y operaciones sensibles. |
| Búsqueda ejecutiva | Permite preguntas operativas en texto natural y filtros estructurados. |
| IA aplicada al negocio | Responde preguntas usando tools controladas sobre datos permitidos, no SQL libre. |
| Automatización de reportes | Incluye reglas de email alerts y eventos de notificación. |
| Colaboración interna | Chat, grupos, canal general, adjuntos y avatares. |
| Decisiones más rápidas | Dashboard, analytics, MPN comparator y consultas por categoría. |
| Preparación SaaS/licencia | Base modular con Next.js, Supabase, RLS, tests, docs y migraciones. |

Ejemplos concretos:

- Un admin carga un Excel de RFQ y el sistema detecta columnas, categoría, errores y calidad.
- Un manager consulta registros con GP menor a cierto porcentaje.
- Un empleado revisa sus propias cargas y registros.
- Un comprador compara proveedores para un MPN por precio, lead time, disponibilidad y score.
- Un admin envía correos internos a empleados filtrados por rol, departamento o región.
- Un equipo usa chat interno para discutir cargas, registros o incidencias operativas.
- Una persona pregunta por voz o texto: "¿Qué archivos tienen más errores?" y recibe respuesta desde datos controlados.

---

## 4. Inventario completo de funciones

### 4.A Funciones grandes / estratégicas

| Función | Descripción | Usuario beneficiado | Valor comercial | Complejidad | Estado | Archivos/rutas/endpoints relacionados |
|---|---|---|---|---|---|---|
| Autenticación empresarial | Login con Supabase Auth, sesión SSR/browser, rutas protegidas y perfiles activos. | admin, manager, employee | Controla acceso y reduce riesgo operativo. | Alta | Implementado, requiere Supabase configurado | `lib/auth/context.ts`, `proxy.ts`, `/login`, `/api/me` |
| Roles admin/manager/employee | Perfiles con rol, guards de UI y restricciones de API. | Todos | Permite operación interna con privilegios diferenciados. | Alta | Implementado; política manager requiere refinamiento formal | `profiles`, `RoleGuard`, `AdminGuard`, `EmployeeGuard` |
| RLS Supabase | Políticas por tabla para perfiles, uploads, records, logs, chat y storage. | Todos | Seguridad de datos a nivel base. | Muy alta | Implementado en migraciones; requiere revisión independiente | `supabase/migrations/*.sql` |
| Importación Excel/CSV | Carga de archivos, parseo, validación, almacenamiento y persistencia de registros. | admin, manager, employee | Núcleo del producto; convierte Excel en datos de negocio. | Muy alta | Implementado | `/upload`, `/api/upload`, `lib/excel/*` |
| Normalización comercial | Mapea columnas variables a estructura común de negocio. | Operaciones, ventas, compras | Hace comparable información de archivos distintos. | Muy alta | Implementado | `lib/excel/normalizer.ts`, `lib/platform/types.ts` |
| Calidad y errores de datos | Detecta problemas por fila/celda, duplicados, faltantes y score de calidad. | Admin, operaciones | Reduce errores y da confianza en los datos. | Alta | Implementado | `lib/excel/data-quality.ts`, `import_errors` |
| Plataforma de registros | Consulta, filtros, paginación y búsqueda sobre registros importados. | Todos | Convierte data histórica en activo consultable. | Alta | Implementado | `/records`, `/api/records`, `/api/search` |
| Dashboard y analítica | Métricas de uploads, records, categorías, clientes, proveedores, empleados y MPN. | admin, manager | Visión ejecutiva de operación y calidad. | Alta | Implementado; producción mostró 500 si esquema/migración no cuadra | `/dashboard`, `/analytics`, `/api/analytics`, `/api/admin/analytics` |
| Categorías de negocio | Clasificación de archivos y registros: Sales Margin, RFQ, Supplier Offers, Logistics, etc. | Operaciones | Ordena información por tipo de proceso. | Media/Alta | Implementado; UI depende de analytics estable | `/categories`, `lib/excel/category-detector.ts` |
| Buscador ejecutivo | Traduce texto natural a filtros sobre records, uploads, errors y users. | Directivos, admins | Reduce barrera de consulta y acelera hallazgos. | Alta | Implementado | `/executive-search`, `/api/executive-search`, `lib/search/executive-query-parser.ts` |
| Comparador MPN | Compara ofertas históricas por MPN con ranking de proveedores. | Compras, ventas, manager | Alto valor directo para negociación y abastecimiento. | Alta | Implementado | `/mpn-comparator`, `/api/mpn-comparator`, `lib/mpn/recommendation.ts` |
| IA por texto | Asistente con OpenAI y tools controladas sobre datos permitidos. | Todos | Preguntas de negocio sin crear SQL manual. | Muy alta | Implementado; requiere `OPEN_IA` u `OPENAI_API_KEY` para LLM | `/api/assistant`, `/api/ai/assistant`, `lib/ai/*` |
| IA por voz | Transcripción, pregunta al asistente y respuesta hablada con ElevenLabs. | Usuarios operativos | Interfaz natural y diferencial comercial. | Muy alta | Implementado; requiere OpenAI, ElevenLabs y flag de voz | `/api/ai/voice/*`, `components/ai/AiVoiceRecorder.tsx` |
| Email alerts | Reglas de alerta por eventos de uploads, errores, calidad, GP y MPN faltante. | admin, manager | Automatiza monitoreo operativo. | Alta | Implementado; requiere proveedor email y migraciones | `/admin/email-alerts`, `/api/admin/email-alerts/*`, `lib/email/*` |
| Admin email center | Envío manual segmentado por usuarios/roles/departamento/región con historial. | admin | Comunicación interna centralizada. | Alta | Implementado; depende de `admin_email_messages` y email provider | `/admin/email-center`, `/api/admin/email-center/*` |
| Recuperación de contraseña por código | Solicitud, verificación y confirmación con código hasheado y token. | Todos | Reduce soporte manual para acceso. | Alta | Parcial en producción: depende de migración/env/email; incidente actual | `/forgot-password`, `/reset-password`, `/api/auth/password-reset/*` |
| Chat interno | Conversaciones 1:1, grupos, canal general, mensajes, adjuntos y realtime. | Todos | Colaboración sobre datos y operación interna. | Muy alta | Implementado en código; producción requiere migración enterprise | `/chat`, `/api/chat/*`, `components/chat/*` |
| Avatares de perfil | Subida, eliminación y lectura de avatar en Supabase Storage. | Todos | Mejora identidad interna y chat. | Media | Implementado; requiere columna/bucket/RPC enterprise | `/profile`, `/api/profile/avatar` |
| Observabilidad interna | Logs de sistema, cliente, performance, auditoría, seguridad y trazas. | admin, soporte | Diagnóstico y control para operar la plataforma. | Alta | Implementado | `/admin/logs`, `/admin/performance`, `/admin/audit-logs`, `/admin/security`, `/admin/traces/[traceId]` |
| Deploy en Render | Configuración esperada de app desplegada con variables de entorno. | propietario, equipo técnico | Permite operación pública/privada cloud. | Media | Usado en producción; requiere env vars completas | `README.md`, `.env.example`, Render URL observada |

### 4.B Funciones medianas / operativas

| Función | Descripción | Usuario | Valor | Complejidad | Estado | Evidencia |
|---|---|---|---|---|---|---|
| Historial de cargas | Lista batches con estado, conteos, errores y archivo original. | admin, manager, employee | Control operativo de importaciones. | Media | Implementado | `/api/upload`, `upload_batches` |
| Storage de Excel original | Guarda archivo original en bucket `excel-uploads`. | admin, auditoría | Evidencia y reproceso. | Media | Implementado; privado por políticas | `excel-uploads`, `/api/upload` |
| Upload sheets | Registra hojas del workbook y estadísticas por hoja. | admin | Auditoría granular. | Media | Implementado | `upload_sheets` |
| Import errors | Guarda errores por fila, columna, tipo y mensaje. | admin, manager | Permite corregir calidad de datos. | Media | Implementado | `import_errors`, `/admin/import-errors` |
| Registros archivables | `archived_at` permite ocultar registros o cargas sin borrado físico inmediato. | admin | Gestión segura del ciclo de vida. | Media | Implementado | `business_records`, admin routes |
| Admin users | Crear, editar, desactivar usuarios y proteger último admin activo. | admin | Administración interna real. | Alta | Implementado | `/admin/users`, `/api/admin/users` |
| Admin uploads | Revisión y archivo de cargas. | admin | Gobernanza de datasets. | Media | Implementado | `/admin/uploads`, `/api/admin/uploads` |
| Admin records | Exploración y gestión de registros. | admin | Control de data consolidada. | Media | Implementado | `/admin/records`, `/api/admin/records` |
| Admin search | Búsqueda admin sobre records/uploads/employees/errors. | admin | Soporte y auditoría. | Media | Implementado | `/admin/search`, `/api/admin/search` |
| Admin errors | Vista de errores técnicos o importación según rutas admin. | admin | Diagnóstico. | Media | Implementado | `/admin/errors`, `/api/admin/errors` |
| Logs de cliente | Recibe errores/eventos desde frontend. | admin, soporte | Diagnóstico UX. | Media | Implementado | `/api/logs/client`, `client_logs` |
| Logs auth | Registra eventos de autenticación desde cliente. | admin, seguridad | Rastreo de login/fallos. | Media | Implementado | `/api/logs/auth` |
| Performance logs | Guarda tiempos, módulos y operaciones. | admin, soporte | Detectar cuellos de botella. | Media | Implementado | `performance_logs`, `lib/logger/performance.ts` |
| Security events | Registra intentos no autorizados y eventos sensibles. | admin, seguridad | Evidencia de seguridad. | Media | Implementado | `security_events`, `logSecurityEvent` |
| Audit logs | Historial de acciones relevantes. | admin, auditoría | Cumplimiento y trazabilidad. | Media | Implementado | `audit_logs`, `logAuditEvent` |
| Rate limiting | Límites para uploads, assistant, voice, chat, MPN, executive search y password reset. | Todos | Reduce abuso y costos. | Alta | Implementado; parte persistente depende de migración | `lib/security/rateLimit.ts`, `api_rate_limits` |
| Multilenguaje ES/EN/ZH | Selector de idioma y textos de UI/IA. | Todos | Mejora venta internacional. | Media | Implementado parcial por componentes/textos | `components/i18n/*`, rutas UI |
| Public config | Expone config segura para cliente. | frontend | Evita filtrar secretos. | Baja/Media | Implementado | `/api/auth/public-config` |
| Demo mode | Respuestas controladas si no hay Supabase en no-producción. | desarrollador/demo | Facilita demos locales. | Media | Implementado | `getAuthContext`, rutas varias |

### 4.C Funciones pequeñas / complementarias

| Función | Descripción | Usuario | Valor | Complejidad | Estado | Evidencia |
|---|---|---|---|---|---|---|
| Validación Zod | Valida requests de APIs y formularios críticos. | todos | Menos errores y ataques triviales. | Media | Implementado | rutas API, `lib/chat/chat-service.ts`, email/password reset |
| Sanitización de fórmulas Excel | Evita inyección de fórmulas al normalizar texto. | seguridad | Reduce riesgo al reexportar/mostrar datos. | Media | Implementado | `lib/excel/normalizer.ts` |
| Límites de tamaño | Controla tamaño de uploads, audio, adjuntos y avatares. | todos | Controla costo/riesgo. | Media | Implementado | `.env.example`, validators |
| Signed URLs de adjuntos | Entrega adjuntos de chat por URL firmada temporal. | usuarios chat | Seguridad de archivos privados. | Media | Implementado | `/api/chat/attachments/[id]` |
| Fallback polling chat | Poll cada 12s si realtime no basta. | usuarios chat | Resiliencia de conversación. | Media | Implementado | `components/chat/ChatLayout.tsx` |
| Registro de traces | Usa traceId/requestId para correlación. | soporte | Diagnóstico más rápido. | Media | Implementado | logger y rutas admin |
| Headers de seguridad | CSP, HSTS, nosniff, frame deny, permissions policy. | seguridad | Endurece superficie web. | Media | Implementado | `next.config.mjs` |
| Configuración por env | `.env.example` documenta Supabase, OpenAI, ElevenLabs, email, límites. | devops | Instalación controlada. | Baja/Media | Implementado | `.env.example` |
| Tests unitarios | Vitest para parser, seguridad, email, chat, analytics, voz, etc. | equipo técnico | Reduce riesgo de regresión. | Media | Implementado, faltan e2e/integración completa | `*.test.ts` |
| Documentación técnica | Documentos de seguridad, performance, backup, deployment y enterprise MVP. | comprador técnico | Aumenta transferibilidad. | Media | Implementado | `docs/*` |

---

## 5. Arquitectura del sistema

### Vista general

| Capa | Tecnología | Función | Importancia | Riesgo si falla |
|---|---|---|---|---|
| Frontend | Next.js App Router, React 18, Tailwind, lucide, Recharts | Interfaz admin/employee, upload, analytics, chat, profile, auth | Alta | Usuarios no pueden operar ni ver errores correctamente. |
| Backend/API | Next.js Route Handlers en `app/api` | Procesamiento de uploads, auth, analytics, IA, chat, email, logs | Muy alta | Se detienen funcionalidades centrales. |
| Base de datos | Supabase Postgres | Perfiles, cargas, registros, errores, logs, email, chat, password reset | Muy alta | Pérdida de funcionalidad y trazabilidad. |
| Auth | Supabase Auth + perfiles propios | Sesiones, usuarios, roles, estado activo | Muy alta | Acceso roto o inseguro. |
| Seguridad DB | Row Level Security y RPCs | Control de lectura/escritura por rol/membresía | Muy alta | Fuga o bloqueo de datos. |
| Storage | Supabase Storage | Excel originales, adjuntos, avatares | Alta | Archivos no disponibles o expuestos incorrectamente. |
| Parser Excel | `xlsx` + módulos propios | Lectura, normalización y validación de hojas | Muy alta | Se pierde el núcleo de transformación de datos. |
| IA texto | OpenAI Responses API + tools internas | Preguntas de negocio sobre data permitida | Alta | Se pierde diferencial comercial; riesgo si no se limita. |
| Voz | OpenAI transcription + ElevenLabs | Interacción por audio y respuesta hablada | Media/Alta | Se pierde feature diferencial, no el core. |
| Email | Resend o SMTP con fallback mock/disabled | Alertas, emails admin, password reset | Alta | No llegan alertas ni recuperación de contraseña. |
| Chat | Supabase tables, RLS, realtime, storage | Comunicación interna con adjuntos | Alta | Colaboración interna falla. |
| Logging | Logger propio + tablas system/client/performance/security/audit | Diagnóstico y evidencia | Alta | Dificulta soporte y venta enterprise. |
| Deploy | Render + Supabase | Ejecución cloud | Alta | Producción puede fallar por env/migraciones. |

### Flujo principal de valor

1. Usuario autenticado entra por `/login`.
2. `proxy.ts` valida sesión, perfil activo y acceso a rutas.
3. Usuario sube Excel/CSV por `/upload`.
4. API `/api/upload` valida archivo, aplica rate limit y lo parsea.
5. Parser detecta hojas, encabezados, categorías, errores y normaliza columnas.
6. Archivo original va a `excel-uploads`.
7. Datos se guardan en `upload_batches`, `upload_sheets`, `business_records` e `import_errors`.
8. Dashboard, records, analytics, categories, executive search, MPN comparator e IA consultan datos normalizados.
9. Logs, auditoría, seguridad y performance registran operación.
10. Email alerts y chat agregan colaboración y comunicación interna.

---

## 6. Mapa de rutas y pantallas

| Ruta | Qué hace | Acceso | Datos principales | Valor |
|---|---|---|---|---|
| `/` | Entrada principal/redirección según app. | Público/según implementación | N/A | Punto de inicio. |
| `/login` | Inicio de sesión con Supabase. | Público | Credenciales, config pública | Acceso controlado. |
| `/forgot-password` | Solicitud de código de recuperación. | Público | Email | Recuperación de acceso; actualmente requiere revisión de producción. |
| `/reset-password` | Verificación de código y cambio de contraseña. | Público | Código, token, nueva contraseña | Cierre del flujo de recuperación. |
| `/dashboard` | Panel principal con resumen operativo. | Usuario autenticado | Uploads, records, errores, métricas | Visión rápida del negocio. |
| `/upload` | Carga de archivos Excel/CSV. | Autenticado | Archivo, resultado de importación | Núcleo de ingesta. |
| `/records` | Consulta de registros importados. | Autenticado | `business_records`, perfiles, uploads | Operación diaria y búsqueda. |
| `/categories` | Vista por categorías detectadas. | Autenticado | Analytics/categorías | Organización de datasets por proceso. |
| `/analytics` | Analítica general. | Autenticado | Métricas agregadas | Decisión ejecutiva. |
| `/employees` | Vista/directorio de empleados según implementación. | Autenticado | `profiles`, actividad | Visibilidad del equipo. |
| `/executive-search` | Búsqueda en lenguaje natural con filtros estructurados. | Autenticado | Records, uploads, errors, users | Búsqueda directiva rápida. |
| `/mpn-comparator` | Comparación de ofertas por MPN. | Autenticado | Registros por MPN, ranking | Decisión de compra/venta. |
| `/chat` | Chat interno. | Autenticado | Conversaciones, miembros, mensajes, adjuntos | Comunicación interna. |
| `/profile` | Perfil del usuario y avatar. | Autenticado | `profiles`, `avatars` | Identidad y experiencia interna. |
| `/admin` | Panel de administración. | Admin | Resumen admin | Gobierno del sistema. |
| `/admin/users` | Gestión de usuarios. | Admin | `profiles`, Supabase Auth | Alta/baja/cambios de usuarios. |
| `/admin/uploads` | Gestión de cargas. | Admin | `upload_batches` | Control de datasets. |
| `/admin/records` | Gestión de registros. | Admin | `business_records` | Control de datos. |
| `/admin/search` | Búsqueda administrativa transversal. | Admin | Records/uploads/users/errors | Soporte y auditoría. |
| `/admin/analytics` | Analítica admin. | Admin | Métricas plataforma | Supervisión ejecutiva. |
| `/admin/categories` | Categorías admin. | Admin | Categorías/importaciones | Control taxonómico. |
| `/admin/import-errors` | Errores de importación. | Admin | `import_errors` | Mejora de calidad. |
| `/admin/logs` | Logs del sistema. | Admin | `system_logs`, `client_logs` | Diagnóstico. |
| `/admin/performance` | Logs de performance. | Admin | `performance_logs` | Detección de lentitud. |
| `/admin/audit-logs` | Auditoría. | Admin | `audit_logs` | Trazabilidad formal. |
| `/admin/security` | Seguridad. | Admin | `security_events` | Monitoreo de accesos/riesgos. |
| `/admin/traces/[traceId]` | Detalle por trace. | Admin | Logs correlacionados | Debug de incidentes. |
| `/admin/email-alerts` | Reglas de alertas por email. | Admin | `email_alert_rules`, eventos | Automatización de avisos. |
| `/admin/email-center` | Envío manual de correos internos. | Admin | `admin_email_messages`, perfiles | Comunicación centralizada. |
| `/admin/errors` | Errores técnicos/operativos según implementación. | Admin | Logs/errores | Diagnóstico admin. |

---

## 7. Mapa de endpoints API

### Auth, sesión y perfil

| Método | Endpoint | Función | Rol | Seguridad | Estado |
|---|---|---|---|---|---|
| GET | `/api/me` | Devuelve usuario/perfil actual. | Autenticado | Supabase Auth, perfil activo | Implementado |
| GET | `/api/auth/public-config` | Expone configuración pública segura. | Público | Sin secretos | Implementado |
| POST | `/api/auth/password-reset/request` | Solicita código de recuperación. | Público | Zod, rate limit, hash, email | Implementado; producción con incidencia |
| POST | `/api/auth/password-reset/verify` | Verifica código y genera token temporal. | Público | Hash HMAC, intentos, expiración | Implementado; depende de tabla |
| POST | `/api/auth/password-reset/confirm` | Actualiza contraseña. | Público | Token HMAC, service role, auditoría | Implementado; depende de env/tabla |
| GET/POST/DELETE | `/api/profile/avatar` | Leer/subir/eliminar avatar. | Autenticado | Validación MIME/tamaño, bucket, RPC | Implementado; requiere migración enterprise |

### Uploads, records, analytics y búsqueda

| Método | Endpoint | Función | Rol | Seguridad | Estado |
|---|---|---|---|---|---|
| GET | `/api/upload` | Historial de cargas. | Autenticado | Auth, RLS/filtros | Implementado |
| POST | `/api/upload` | Cargar y procesar Excel/CSV. | Autenticado | Auth, rate limit, validación archivo, auditoría | Implementado |
| GET | `/api/records` | Listar registros con filtros y paginación. | Autenticado | Auth, Zod, RLS, rate limit | Implementado |
| GET | `/api/search` | Búsqueda global sobre registros. | Autenticado | Auth, rate limit | Implementado |
| GET | `/api/analytics` | Métricas para dashboard/analytics. | Autenticado | Auth, columnas controladas, logs | Implementado; producción mostró 500 si esquema no coincide |
| POST | `/api/executive-search` | Búsqueda ejecutiva con parser de texto natural. | Autenticado | Auth, Zod, rate limit, logs | Implementado |
| GET | `/api/executive-search/suggest` | Sugerencias de búsqueda ejecutiva. | Autenticado | Auth | Implementado |
| GET | `/api/mpn-comparator` | Comparación y ranking por MPN. | Autenticado | Auth, rate limit, logs | Implementado |
| GET | `/api/mpn-comparator/suggest` | Sugerencias MPN. | Autenticado | Auth | Implementado |
| GET | `/api/employees` | Listado/directorio de empleados. | Autenticado | Auth/RLS | Implementado |

### IA y voz

| Método | Endpoint | Función | Rol | Seguridad | Estado |
|---|---|---|---|---|---|
| POST | `/api/assistant` | Asistente IA por texto. | Autenticado | Auth, rate limit, tools controladas | Implementado; LLM requiere API key |
| POST | `/api/ai/assistant` | Alias/reexport del assistant. | Autenticado | Igual que assistant | Implementado |
| POST | `/api/ai/voice/transcribe` | Transcribe audio. | Autenticado | Auth, flag voz, rate limit, tamaño/MIME | Implementado; requiere OpenAI |
| POST | `/api/ai/voice/ask` | Audio/texto -> assistant -> posible audio respuesta. | Autenticado | Auth, rate limit, OpenAI/ElevenLabs | Implementado; requiere proveedores |
| POST | `/api/ai/voice/speak` | Texto a voz. | Autenticado | Auth, límites, ElevenLabs | Implementado; requiere ElevenLabs |

### Chat

| Método | Endpoint | Función | Rol | Seguridad | Estado |
|---|---|---|---|---|---|
| GET | `/api/chat/users` | Lista usuarios disponibles para chat. | Autenticado | Auth, RPC/fallback, logs | Implementado; producción depende de `profiles`/RPC |
| GET | `/api/chat/conversations` | Lista conversaciones del usuario. | Autenticado | Auth, membresía/RLS | Implementado; requiere tablas chat |
| POST | `/api/chat/conversations` | Crea conversación directa o grupo. | Autenticado; grupo admin | Zod, rate limit, RPC | Implementado; requiere tablas/RPC |
| GET | `/api/chat/conversations/[id]/messages` | Mensajes de conversación. | Miembro | UUID, RLS/membresía | Implementado |
| POST | `/api/chat/conversations/[id]/messages` | Enviar mensaje. | Miembro | Zod, rate limit, membresía | Implementado |
| PATCH | `/api/chat/conversations/[id]/read` | Marca mensajes como leídos. | Miembro | Auth/membresía | Implementado |
| POST | `/api/chat/conversations/[id]/attachments` | Sube adjunto al chat. | Miembro | MIME/tamaño, storage privado, rollback | Implementado |
| GET | `/api/chat/attachments/[id]` | Entrega URL firmada de adjunto. | Miembro | Signed URL temporal | Implementado |
| POST/PATCH | `/api/chat/groups/*` | Gestión de grupos/miembros según rutas existentes. | Admin/miembro autorizado | Auth, RLS, validación | Implementado parcial según rutas |

### Admin, logs, email y observabilidad

| Método | Endpoint | Función | Rol | Seguridad | Estado |
|---|---|---|---|---|---|
| GET/POST/PATCH/DELETE | `/api/admin/users` | Gestión de usuarios. | Admin | `requireAdmin`, service role, protecciones último admin | Implementado |
| GET/PATCH | `/api/admin/uploads` | Gestión de cargas. | Admin | Admin, auditoría | Implementado |
| GET/PATCH | `/api/admin/records` | Gestión de registros. | Admin | Admin | Implementado |
| GET | `/api/admin/search` | Búsqueda admin. | Admin | Admin | Implementado |
| GET | `/api/admin/analytics` | Métricas admin. | Admin | Admin | Implementado |
| GET | `/api/admin/logs` | Logs sistema/cliente. | Admin | Admin | Implementado |
| GET | `/api/admin/performance` | Performance logs. | Admin | Admin | Implementado |
| GET | `/api/admin/audit-logs` | Auditoría. | Admin | Admin | Implementado |
| GET | `/api/admin/security` | Eventos de seguridad. | Admin | Admin | Implementado |
| GET | `/api/admin/traces/[traceId]` | Trace detallado. | Admin | Admin | Implementado |
| POST | `/api/logs/client` | Recibe logs de frontend. | Público/autenticado según evento | Validación, rate limit esperado | Implementado |
| POST | `/api/logs/auth` | Recibe logs de auth cliente. | Público | Sanitización | Implementado |
| GET/POST | `/api/admin/email-alerts` | Lista/crea reglas. | Admin | Admin, Zod | Implementado |
| PATCH/DELETE | `/api/admin/email-alerts/[id]` | Edita/elimina reglas. | Admin | Admin | Implementado |
| GET | `/api/admin/email-alerts/events` | Historial de eventos. | Admin | Admin | Implementado |
| POST | `/api/admin/email-alerts/test` | Prueba envío/alerta. | Admin | Admin, email provider | Implementado |
| GET | `/api/admin/email-center` | Historial/config de correos. | Admin | Admin | Implementado |
| POST | `/api/admin/email-center/send` | Envía correos manuales. | Admin | Admin, validación, chunks | Implementado; requiere email provider |
| POST | `/api/admin/email-center/test` | Prueba email center. | Admin | Admin | Implementado |
| GET | `/api/admin/email-center/history` | Historial de correos. | Admin | Admin | Implementado |

---

## 8. Base de datos y Supabase

### Tablas principales

| Tabla | Propósito | Datos principales | Lectura/escritura | RLS | Valor negocio |
|---|---|---|---|---|---|
| `profiles` | Perfil extendido de usuarios. | email, full_name, role, department, region, active, avatar_path en migración enterprise | Usuario propio, admin, reglas por rol | Sí | Base de permisos, ownership y directorio. |
| `upload_batches` | Cargas de archivos. | archivo, estado, conteos, categoría, storage path, usuario | Dueño/admin/según políticas | Sí | Trazabilidad de importación. |
| `upload_sheets` | Hojas dentro de cada archivo. | sheet name, filas, columnas, errores | Relacionado a batch | Sí | Auditoría granular del workbook. |
| `business_records` | Registros normalizados de negocio. | customer, supplier, MPN, PO, qty, cost, price, GP, categoría, raw_data, searchable_text | Según RLS/ownership/rol | Sí | Activo de datos central. |
| `import_errors` | Errores de importación. | fila, columna, tipo, mensaje, severidad | Dueño/admin/según políticas | Sí | Calidad y corrección de datos. |
| `audit_logs` | Auditoría de acciones. | actor, acción, módulo, metadata | Admin/servicio | Sí | Evidencia para compliance. |
| `security_events` | Eventos de seguridad. | usuario, evento, severidad, metadata | Admin/servicio | Sí | Monitoreo de riesgo. |
| `system_logs` | Logs backend. | traceId, module, action, status, error | Admin/servicio | Sí | Diagnóstico técnico. |
| `client_logs` | Logs frontend. | ruta, evento, browser, mensaje | Admin/usuario propio inserta | Sí | Diagnóstico de UX. |
| `performance_logs` | Métricas de duración. | operación, duración, módulo, trace | Admin/servicio | Sí | Performance y soporte. |
| `email_alert_rules` | Reglas de alertas. | tipo evento, condiciones, destinatarios, activo | Admin | Sí | Automatización de comunicación. |
| `email_notification_events` | Historial de alertas. | regla, evento, estado, destinatarios | Admin | Sí | Trazabilidad de notificaciones. |
| `password_reset_codes` | Códigos de recuperación. | user_id, code_hash, token_hash, expiración, intentos, usado | Servidor/service role | Sí | Recuperación segura de contraseña. |
| `api_rate_limits` | Rate limiting persistente. | key, action, count, window | Servidor | Sí/servidor | Control de abuso/costo. |
| `admin_email_messages` | Correos enviados por admin. | asunto, cuerpo, recipients, estado | Admin | Sí | Historial de comunicación. |
| `chat_conversations` | Conversaciones de chat. | tipo, título, company, timestamps | Miembros/admin por RLS | Sí | Colaboración interna. |
| `chat_conversation_members` | Membresía de conversaciones. | conversation_id, profile_id, role, last_read | Miembros/admin | Sí | Control de acceso al chat. |
| `chat_messages` | Mensajes de chat. | sender, body, tipo, metadata | Miembros | Sí | Historial de comunicación. |
| `chat_attachments` | Archivos de chat. | storage path, mime, size, message | Miembros | Sí | Evidencia/soporte operativo. |

### Buckets Supabase Storage

| Bucket | Propósito | Acceso esperado | Estado |
|---|---|---|---|
| `excel-uploads` | Archivos originales cargados. | Privado; dueño/admin según políticas. | Implementado en migración plataforma. |
| `chat-attachments` | Adjuntos de chat. | Privado; acceso por membresía y signed URL. | Implementado en migración enterprise. |
| `avatars` | Avatares de usuario. | Público o controlado según política; escritura por dueño. | Implementado en migración enterprise. |

### Funciones/RPC importantes

| RPC/función | Propósito | Valor | Estado |
|---|---|---|---|
| `set_updated_at` | Mantiene `updated_at`. | Integridad temporal. | Implementado |
| `handle_new_user` | Crea perfil al crear usuario auth. | Onboarding. | Implementado |
| `current_profile_role` | Obtiene rol actual. | Políticas RLS. | Implementado |
| `current_profile_department` | Obtiene departamento actual. | Políticas/segmentación. | Implementado |
| `current_profile_region` | Obtiene región actual. | Políticas/segmentación. | Implementado |
| `is_admin` | Evalúa admin. | RLS/admin. | Implementado |
| `is_manager` | Evalúa manager. | RLS/manager. | Implementado |
| `is_active_profile` | Verifica usuario activo. | Seguridad. | Implementado |
| `can_read_profile` | Permiso de lectura de perfil. | Directorio/seguridad. | Implementado |
| `can_read_upload` | Permiso de lectura de carga. | Seguridad de datasets. | Implementado |
| `consume_api_rate_limit` | Rate limit persistente. | Protección de endpoints. | Migración enterprise |
| `is_conversation_member` | Verifica membresía chat. | Seguridad chat. | Migración enterprise |
| `can_manage_conversation` | Gestión de conversación. | Seguridad chat. | Migración enterprise |
| `list_chat_users` | Lista usuarios para chat. | UX/performance. | Migración enterprise; código tiene fallback |
| `create_chat_conversation` | Crea conversación directa/grupo. | Chat operativo. | Migración enterprise |
| `set_my_avatar_path` | Actualiza avatar propio. | Perfil/avatar seguro. | Migración enterprise |
| `add_profile_to_company_chat` | Agrega perfil a canal general. | Chat general. | Migración enterprise |
| `get_employee_activity_directory` | Directorio con actividad. | Empleados/analytics. | Migración enterprise |

### Observación crítica de base actual

El repositorio incluye migración enterprise `20260629000000_enterprise_mvp.sql`, pero en la base de datos revisada se observaron faltantes compatibles con migración no aplicada o esquema desalineado:

- `profiles.avatar_path` no existía.
- `password_reset_codes` no existía.
- `chat_conversations` no existía.
- `list_chat_users` no existía.

Impacto: password reset, chat, avatares y algunas pantallas pueden fallar en producción aunque el código esté implementado.

---

## 9. Seguridad

### Controles implementados

| Control | Evidencia | Valor |
|---|---|---|
| Supabase Auth | Login, `getAuthContext`, sesiones SSR/browser | Identidad centralizada. |
| Perfiles activos | Bloqueo si `profiles.active` no está activo | Evita acceso de usuarios deshabilitados. |
| Roles | admin, manager, employee | Separación operacional. |
| Rutas protegidas | `proxy.ts` protege dashboard/upload/records/analytics/categories/chat/profile/admin | Reduce exposición. |
| Admin-only | `/admin/*` bloquea no-admin y registra evento | Control administrativo. |
| RLS | Migraciones aplican políticas por tabla | Protección en base de datos. |
| Service role servidor | Operaciones sensibles solo desde backend | Evita secretos en frontend. |
| Storage privado | Buckets y políticas para Excel/chat | Protege archivos. |
| Zod | Validaciones de requests | Reduce entrada inválida. |
| Rate limiting | Límites por acción y usuario/IP | Evita abuso. |
| Password reset seguro | Código y token hasheados con HMAC, expiración e intentos | Evita guardar códigos planos. |
| Logs de seguridad | `security_events` | Evidencia de intentos no autorizados. |
| Auditoría | `audit_logs` | Trazabilidad formal. |
| CSP/headers | `next.config.mjs` | Reduce XSS/clickjacking/exposición. |
| Restricción IA | Tools controladas, sin SQL libre, sin secretos/raw UUIDs | Reduce fuga por IA. |
| Validación de archivos | Excel, audio, chat attachments, avatares | Control de MIME/tamaño. |
| Chat por membresía | RLS y funciones de miembro | Evita chats ajenos. |

### Riesgos pendientes de seguridad

| Riesgo | Impacto | Urgencia | Dificultad | Recomendación |
|---|---|---|---|---|
| MFA no implementado | Mayor riesgo si roban credenciales | Alta | Media | Activar MFA en Supabase o flujo propio para admins. |
| CAPTCHA ausente en auth/password reset | Riesgo de abuso de endpoints públicos | Alta | Media | Agregar CAPTCHA/Turnstile en login/reset. |
| Pen test no evidenciado | Riesgos desconocidos antes de venta enterprise | Alta | Media/Alta | Hacer revisión externa antes de contrato grande. |
| Revisión independiente de RLS | Posibles huecos por políticas complejas | Alta | Alta | Auditar políticas con casos admin/manager/employee. |
| Manager policy no completamente formalizada | Manager podría tener alcance no definido | Media/Alta | Media | Definir si manager ve equipo, departamento, región o compañía. |
| Backups restaurados no probados | Riesgo de recuperación real | Alta | Media | Ejecutar restore drill documentado. |
| Retención legal de chat/correo | Riesgo legal/contractual | Media | Media | Definir retención, exportación y borrado. |
| Monitoreo externo | Fallos pueden detectarse tarde | Alta | Media | Agregar Sentry/Logtail/Uptime/alerts. |
| Dominio Resend/SMTP no verificado | Emails pueden no llegar | Alta | Baja/Media | Verificar dominio, SPF, DKIM, DMARC. |
| SSO/SAML no implementado | Limitación para enterprise grande | Media | Alta | Planificar SSO si se vende a corporativo. |

---

## 10. Inteligencia artificial

### Qué hace

El sistema incluye IA por texto y voz conectada a datos empresariales mediante herramientas controladas. La IA no debería ejecutar SQL libre ni inventar acceso a datos. Su flujo esperado es:

1. Usuario autenticado pregunta por texto o voz.
2. El sistema aplica permisos por rol.
3. Se enruta la intención a tools internas.
4. Las tools consultan Supabase con filtros controlados.
5. OpenAI genera una respuesta basada únicamente en el resultado controlado.
6. Si es voz, ElevenLabs puede generar audio de respuesta.

### Tools/casos de uso existentes

| Caso | Tool o módulo relacionado | Estado |
|---|---|---|
| Último archivo subido | `getLatestUpload` | Implementado |
| Buscar registros | `searchBusinessRecords` | Implementado |
| Registros por MPN | `getRecordsByMpn` | Implementado |
| Uploads por usuario | `getUploadsByUser` | Implementado |
| Errores de importación | `getImportErrors` | Implementado |
| Resumen dashboard | `getDashboardSummary` | Implementado |
| Comparación MPN/precio | `getMpnPriceComparison` | Implementado |
| Resumen de empleado | `getEmployeeSummary` | Implementado |
| GP bajo | `getLowGpRecords` | Implementado |
| Registros sin MPN | `getMissingMpnRecords` | Implementado |

### Ejemplos reales de preguntas soportadas por intención

- "¿Cuál fue el último Excel subido?"
- "Muéstrame registros con GP menor al 15%."
- "¿Qué proveedor tiene mejor precio para este MPN?"
- "Resume mis registros."
- "¿Qué archivos tienen errores?"
- "¿Qué subió Luis esta semana?"
- "Busca Tesla con GP mayor a 25%."
- "Dame registros sin MPN."

### Límites de seguridad

| Límite | Motivo |
|---|---|
| No SQL libre desde el usuario | Evita inyección, fuga o consultas destructivas. |
| No exponer secretos, service role ni variables privadas | Seguridad operacional. |
| No responder con UUIDs/campos raw innecesarios | Minimiza fuga de datos internos. |
| Permisos por rol | Employee se restringe a sus datos; admin puede consultar más. |
| Fallback sin API key | Si no hay OpenAI, devuelve resumen controlado o error manejado. |

### Estado

| Submódulo | Estado |
|---|---|
| IA por texto | Implementada; requiere `OPEN_IA` u `OPENAI_API_KEY` para respuesta LLM completa. |
| Tools de base de datos | Implementadas; dependen de Supabase y permisos. |
| IA por voz/transcripción | Implementada; requiere flag de voz y OpenAI. |
| Respuesta hablada | Implementada; requiere ElevenLabs. |
| Política manager | Parcial: el código contempla scopes, pero la definición exacta de alcance manager debe cerrarse antes de venta enterprise. |

---

## 11. Email, alertas y comunicación

### Módulos existentes

| Módulo | Descripción | Estado |
|---|---|---|
| Email service | Selecciona proveedor `resend`, `smtp`, `mock` o `disabled`. | Implementado |
| Resend | Envío vía API si `RESEND_API_KEY` existe. | Requiere configuración |
| SMTP | Envío con nodemailer si SMTP está configurado. | Requiere configuración |
| Mock | Simula envío si no hay proveedor y no está disabled. | Útil para dev, no envía emails reales |
| Email alerts | Reglas por eventos de upload/calidad/GP/MPN. | Implementado |
| Email notification events | Historial de eventos de alertas. | Implementado |
| Admin email center | Envío manual segmentado y registro de historial. | Implementado; requiere tabla enterprise |
| Password reset email | Envía código de recuperación. | Implementado en código; fallando si migración/env/provider no están listos |

### Eventos de alertas soportados

- `upload_completed`
- `upload_failed`
- `upload_has_many_errors`
- `low_gp_rate`
- `missing_mpn_threshold`
- `weekly_report`
- `new_dataset_published`
- `import_quality_below_threshold`

### Condiciones de reglas soportadas

- `error_count_gt`
- `gp_rate_lt`
- `missing_mpn_gt`
- `quality_score_lt`

### Incidencia actual: recuperación de contraseña por correo

En producción se observó que la pantalla de recuperación muestra error al consumir `/api/auth/password-reset/request`. El frontend reportó una respuesta no JSON o vacía en algún momento, y el endpoint también puede devolver 500/503 si el backend no tiene tabla, variables o proveedor correctamente configurados.

No se debe inventar la causa única. Desde el código, las causas probables se separan así:

| Área | Qué revisar | Evidencia esperada |
|---|---|---|
| Endpoint | `POST /api/auth/password-reset/request` | Debe responder JSON siempre, incluso en error. |
| Tabla | `password_reset_codes` | Debe existir por migración `20260629000000_enterprise_mvp.sql`. |
| Variable secreta | `PASSWORD_RESET_SECRET` | En producción debe existir y tener al menos 32 caracteres. |
| TTL/intentos | `PASSWORD_RESET_TTL_MINUTES`, `PASSWORD_RESET_MAX_ATTEMPTS`, `PASSWORD_RESET_RESEND_COOLDOWN_SECONDS` | Opcionales con defaults/clamps, pero deben ser coherentes. |
| Proveedor email | `ENABLE_EMAIL_ALERTS`, `RESEND_API_KEY` o SMTP vars | Sin proveedor real, el email no llega. |
| Remitente | `EMAIL_FROM` o `SMTP_FROM` | Debe ser dominio válido/verificado para entregabilidad. |
| Service role | `SUPABASE_SERVICE_ROLE_KEY` | Necesario para buscar usuario/perfil y actualizar auth en confirm. |
| Logs backend | `system_logs`, logs Render, logger server | Deben mostrar `password_reset_request_started/completed/failed` o equivalente. |
| Logs cliente | `/api/logs/client` y consola | Deben mostrar si frontend no pudo parsear JSON o recibió status 500/503. |

Cómo diferenciar errores:

| Síntoma | Diagnóstico probable | Prueba |
|---|---|---|
| Respuesta 503 con mensaje de migración | Falta `password_reset_codes` | Consultar tabla en Supabase o ejecutar migración enterprise. |
| Respuesta 500 por secret | Falta o es débil `PASSWORD_RESET_SECRET` | Revisar env vars en Render. |
| Respuesta 200 pero no llega correo | Proveedor en `mock`, `disabled`, dominio no verificado, SMTP/Resend mal configurado o email cae en spam | Revisar provider usado en logs y panel Resend/SMTP. |
| Error frontend `Unexpected end of JSON input` | API devolvió cuerpo vacío/no JSON en una falla | Ver Network response body y logs Render. |
| 401 en `/api/logs/client` | Log cliente no autenticado o endpoint protegido | No necesariamente causa del reset, pero impide observar desde cliente. |
| Confirmación falla aunque llegó código | Token/código expirado, intentos agotados, secret cambió o service role falla | Revisar `password_reset_codes` y logs confirm/verify. |

Pruebas manuales mínimas:

1. En Render, verificar `NEXT_PUBLIC_APP_URL`, Supabase URL/keys, `SUPABASE_SERVICE_ROLE_KEY`, `PASSWORD_RESET_SECRET`, `ENABLE_EMAIL_ALERTS`, `RESEND_API_KEY` o SMTP.
2. En Supabase, confirmar que existe `password_reset_codes`.
3. Hacer `POST /api/auth/password-reset/request` con un email real registrado.
4. Confirmar que la respuesta es JSON y no 500 HTML/vacío.
5. Revisar logs Render con traceId/requestId.
6. Revisar panel Resend/SMTP para entrega, rechazo, bounce o dominio sin verificar.
7. Probar `/api/auth/password-reset/verify` con el código recibido.
8. Probar `/api/auth/password-reset/confirm` con una contraseña fuerte.

Qué falta corregir si aplica:

- Aplicar migración enterprise en Supabase si falta la tabla.
- Configurar secret robusto en producción.
- Configurar proveedor real de correo.
- Asegurar que todos los errores del endpoint devuelvan JSON.
- Agregar test/integración con proveedor mock y respuesta JSON en errores.
- Agregar monitoreo específico de password reset.

---

## 12. Chat interno

### Capacidades existentes

| Capacidad | Descripción | Estado |
|---|---|---|
| Chat uno a uno | Conversaciones directas entre usuarios. | Implementado en código; requiere tablas/RPC. |
| Grupos | Conversaciones grupales, con creación restringida. | Implementado; grupo requiere admin según ruta principal. |
| Canal general | Migración incluye función para agregar perfiles a company chat. | Implementado en migración enterprise. |
| Miembros | Tabla de miembros con roles y lectura. | Implementado en migración. |
| Mensajes | Textos y referencias de registros/uploads. | Implementado. |
| Adjuntos | PDF, TXT, CSV, XLS/XLSX, imágenes permitidas. | Implementado. |
| Avatares | Integración visual con perfiles. | Implementado; requiere `avatar_path`/bucket. |
| Historial | Mensajes persistidos en `chat_messages`. | Implementado. |
| RLS por membresía | Políticas y funciones de miembro. | Implementado en migración. |
| Storage privado | Bucket `chat-attachments` y signed URLs. | Implementado. |
| Realtime | Publicación de `chat_messages` en realtime. | Migración enterprise; UI también usa polling fallback. |

### Valor empresarial

- Centraliza conversaciones relacionadas con datasets y operaciones.
- Reduce dependencia de WhatsApp/correos externos para discusiones internas.
- Permite adjuntar evidencia y mantener historial.
- Puede conectar conversaciones con registros o cargas específicas.

### Limitaciones pendientes

| Limitación | Impacto | Recomendación |
|---|---|---|
| Producción sin tablas chat | Chat falla con 500/503 | Ejecutar migración enterprise y validar RLS. |
| Retención legal no definida | Riesgo contractual | Definir política de retención/exportación/borrado. |
| Moderación/admin de chat limitada | Riesgo operativo | Agregar panel de moderación si se usa enterprise. |
| Notificaciones push/email no evidenciadas | Menor engagement | Agregar notificaciones si el chat es crítico. |
| E2E chat no evidenciado | Riesgo de regresión | Tests de flujo completo conversación/mensaje/adjunto. |

---

## 13. Rendimiento

### Mejoras existentes

| Mejora | Evidencia | Beneficio |
|---|---|---|
| Paginación | `/api/records`, búsquedas y admin endpoints | Evita payloads grandes. |
| Límites de consulta | MPN comparator limita a 500, search limita resultados | Controla tiempo/costo. |
| Chunk insert | Upload inserta registros por chunks | Evita sobrecargar una sola operación. |
| Índices | Migraciones agregan índices en tablas críticas | Mejora consultas. |
| Columnas controladas en analytics | Analytics evita traer `raw_data/searchable_text` pesados | Reduce payload. |
| RPC para usuarios/chat | `list_chat_users`, directorios | Reduce consultas complejas desde API. |
| Performance logs | Duración por operación | Permite detectar cuellos de botella. |
| Lazy/client components | App Router y componentes por pantalla | Carga modular de UI. |

### Escala esperada

| Volumen | Comportamiento esperado | Riesgo |
|---|---|---|
| 10.000 registros | Debería funcionar con índices, paginación y payload controlado. | Analytics puede requerir optimización según filtros. |
| 50.000 registros | Aún posible, pero uploads grandes y analytics agregados pueden sentirse lentos. | Necesidad de vistas/materialización/cache. |
| 100.000+ registros | Requiere arquitectura de procesamiento más robusta. | Parser en request HTTP, queries agregadas y dashboards podrían fallar/lentificarse. |

### Recomendaciones para escala grande

| Recomendación | Motivo |
|---|---|
| Vistas materializadas para analytics | Evitar recalcular métricas pesadas en cada request. |
| Cache por dashboard/analytics | Reducir presión en Supabase. |
| Worker para Excel | No procesar archivos grandes dentro del request HTTP. |
| Cola de procesamiento | Manejar uploads grandes/reintentos. |
| Worker para correos | Evitar timeouts al enviar muchos emails. |
| Virtualización de tablas | UI fluida con muchos registros. |
| Monitoreo externo | Alertar antes de que usuario reporte. |
| Métricas por tenant/empresa | Preparar SaaS real. |
| Background jobs para alertas | Procesamiento fiable de reglas y reportes. |

---

## 14. Testing y calidad

### Estado de pruebas

Framework: **Vitest**.

Pruebas detectadas: aproximadamente **24 archivos de test** y **55 casos `it(...)`** en el repositorio revisado.

| Área cubierta | Ejemplos |
|---|---|
| Excel parser | Header detector, normalizer, parser, validators, category detector. |
| Seguridad | CSP, env, password reset. |
| Plataforma | Analytics, query columns. |
| Chat | Permisos y rutas de conversations/users. |
| Email | Email alerts, admin email. |
| IA | Permisos de IA. |
| Voz | ElevenLabs, transcription. |
| MPN | Recommendation/ranking. |
| Search | Executive query parser. |
| Profile | Avatar. |
| Supabase helpers | Node client options, schema errors. |

### Verificaciones recientes registradas

| Comando | Resultado observado |
|---|---|
| `npm test` | Pasó: 24 archivos, 55 tests. |
| `npm run typecheck` | Pasó. |
| `npm run lint` | Pasó. |
| `npm run build` | Pasó después de resolver bloqueo local de artefactos `.next`. |

### Qué falta probar

| Pendiente | Impacto | Recomendación |
|---|---|---|
| E2E login/upload/dashboard | Riesgo de demos rotas | Playwright/Cypress contra entorno staging. |
| Password reset completo con email real | Alto | Test manual y automatizado con provider sandbox. |
| Chat realtime completo | Alto | E2E conversación, grupo, adjunto, signed URL. |
| RLS con usuarios reales por rol | Muy alto | Test matrix admin/manager/employee en Supabase. |
| Render production smoke tests | Alto | Script de healthcheck post-deploy. |
| Migraciones aplicadas en staging/prod | Muy alto | Checklist y comando controlado. |
| Uploads grandes | Medio/Alto | Pruebas con 10k/50k filas. |
| Recuperación ante fallos de email/IA/voice | Medio | Tests de degradación. |

### Checklist QA antes de demo

- Login admin y employee.
- Upload de Excel real con varias hojas.
- Ver records y filtros.
- Dashboard sin 500.
- Categories sin spinner infinito.
- Analytics sin 500.
- Buscador ejecutivo con 3 consultas reales.
- MPN comparator con MPN conocido.
- IA texto con API key y sin API key.
- Voz con micrófono y archivo de audio.
- Email alert test.
- Email center test.
- Password reset end-to-end.
- Chat direct, grupo y adjunto.
- Avatar upload/delete.
- Admin logs/security/audit/performance.
- Revisión de consola sin errores rojos críticos.

---

## 15. Estado actual del producto

### Clasificación honesta

El producto está más avanzado que una demo y tiene estructura real de **MVP empresarial controlado**, pero no debe venderse como "enterprise listo" sin corregir configuración/migraciones y hacer hardening.

| Estado | Evaluación |
|---|---|
| Listo | Auth base, roles, parser Excel, normalización, registros, admin base, logging, documentación, tests unitarios. |
| Parcial | Manager scope, password reset en producción, chat en producción, avatares, email real, voz según env, analytics si esquema no está alineado. |
| Requiere configuración | Supabase migrations, Render env vars, OpenAI, ElevenLabs, Resend/SMTP, storage buckets. |
| Pendiente antes de vender caro | RLS audit, MFA/CAPTCHA, staging, monitoring, backup restore, e2e tests, SLA, retención chat/email, escalabilidad con workers. |
| Validación con usuarios reales | Flujo upload -> analytics -> búsqueda -> MPN -> IA -> chat -> email en operación real. |

### Fallos/incidentes actuales conocidos por síntomas observados

| Área | Síntoma | Estado recomendado |
|---|---|---|
| Password reset | Error en `/api/auth/password-reset/request`, posible JSON vacío/500/503 | Revisar migración `password_reset_codes`, env vars y proveedor email. |
| Analytics/Categories | 500 en `/api/analytics` y UI "Unable to load analytics" o carga infinita | Verificar esquema, migraciones y logs; código ajustado para no depender de `avatar_path`, pero producción debe validarse. |
| Chat | 500 en `/api/chat/users` y `/api/chat/conversations` | Aplicar migración enterprise y validar funciones/tables. |
| Avatares | `profiles.avatar_path` faltante en DB observada | Aplicar migración enterprise. |
| Supabase CLI | Error parseando `.env.local` por encoding/BOM observado | Corregir encoding de `.env.local` antes de usar CLI. |

---

## 16. Factores de valoración

### 16.1 Costo de reposición

Construir un sistema equivalente desde cero con un equipo profesional implicaría:

| Perfil | Meses estimados | Rango mensual USD | Subtotal estimado |
|---|---:|---:|---:|
| Full-stack senior | 3-6 | 6.000-12.000 | 18.000-72.000 |
| Backend/Supabase | 2-4 | 5.000-10.000 | 10.000-40.000 |
| Frontend/product | 2-4 | 4.000-8.000 | 8.000-32.000 |
| QA/automation | 1-2 | 3.000-6.000 | 3.000-12.000 |
| DevOps/security review | 1-2 | 4.000-10.000 | 4.000-20.000 |
| Product/PM/documentación | 1-2 | 3.000-8.000 | 3.000-16.000 |

Rango razonable de reposición: **USD 45.000 a USD 190.000**, según calidad, seniority, velocidad y nivel enterprise exigido. El costo no equivale automáticamente a precio de venta, pero sirve como ancla para negociación.

### 16.2 Valor por módulos

| Módulo | Valor técnico/comercial aproximado USD | Comentario |
|---|---:|---|
| Auth/roles/RLS | 6.000-18.000 | Muy valioso si se audita bien. |
| Excel parser/importación | 12.000-35.000 | Núcleo diferencial del producto. |
| Normalización columnas | 8.000-25.000 | Alto valor por conocimiento operativo. |
| Calidad de datos/errores | 6.000-18.000 | Reduce pérdidas por datos malos. |
| Dashboard/analytics | 8.000-25.000 | Necesita estabilización en producción. |
| Admin panel | 7.000-22.000 | Gestión real de usuarios/data/logs. |
| Buscador ejecutivo | 6.000-18.000 | Diferencial para dirección. |
| MPN comparator | 6.000-20.000 | Valor directo para compras/ventas. |
| IA texto | 10.000-35.000 | Alto valor si se demuestra con datos reales. |
| Voz | 6.000-18.000 | Diferencial comercial, no core. |
| Email alerts/center | 6.000-20.000 | Requiere provider confiable. |
| Password reset seguro | 3.000-8.000 | Necesario, no diferencial si falla. |
| Chat interno | 10.000-30.000 | Alto valor, depende de migración/RLS. |
| Avatares/perfil | 2.000-6.000 | Complementario. |
| Seguridad headers/rate limit/logs | 8.000-25.000 | Importante para venta enterprise. |
| Documentación/tests | 5.000-15.000 | Aumenta transferibilidad. |
| Deploy/config | 3.000-10.000 | Necesita hardening. |

### 16.3 Valor estratégico

Para una empresa que vive de cotizaciones, proveedores, MPN, márgenes y archivos Excel, el sistema puede ahorrar tiempo diario y reducir errores que afectan compras/ventas. El valor estratégico aumenta si:

- La empresa tiene muchos archivos históricos.
- Varios empleados suben y consultan información.
- Hay costos reales por errores de MPN, GP, proveedor o PO.
- La dirección necesita trazabilidad y métricas.
- Se desea convertir operación Excel en activo de datos.

### 16.4 Valor como licencia interna

Si se vende solo como uso interno sin código fuente, el precio depende de implementación, soporte y número de usuarios. El rango razonable inicial puede ser menor, pero con margen recurrente.

### 16.5 Valor con código fuente

Entregar código fuente completo transfiere control, capacidad de modificar, desplegar y reutilizar. Debe cobrarse más que una implementación interna porque reduce dependencia del vendedor.

### 16.6 Valor con exclusividad

La exclusividad por industria, región o cliente debe tener prima fuerte porque limita futuras ventas. No conviene vender exclusividad barata si el producto puede convertirse en licencia repetible.

### 16.7 Valor tipo adquisición

Una compra total incluye código, derechos, documentación, transferencia técnica, soporte inicial y posiblemente marca/conocimiento. Debe considerar costo de reposición, riesgo pendiente y potencial de ahorro/uso del comprador.

### Rangos globales de valoración

| Rango | USD | Condiciones que lo justifican |
|---|---:|---|
| Bajo | 15.000-35.000 | Venta rápida, sin exclusividad, con bugs/configuración pendiente, soporte limitado. |
| Realista | 40.000-85.000 | MVP empresarial controlado, migraciones corregidas, demo estable, transferencia básica. |
| Agresivo | 90.000-180.000 | Producción estable, password reset/chat/email/IA funcionando, e2e tests, documentación y soporte. |
| Adquisición estratégica | 180.000-350.000+ | Comprador con dolor fuerte, datos reales, ahorro probado, exclusividad/derechos completos y transición técnica. |

---

## 17. Rangos de precio propuestos

| Escenario | Qué incluye | Qué no incluye | Rango USD | Riesgo vendedor | Recomendación |
|---|---|---|---:|---|---|
| A. Piloto pago | Setup limitado, demo con datos reales, 2-4 semanas, usuarios clave | Código fuente, exclusividad, SLA enterprise | 5.000-15.000 | Bajo/medio | Buen primer paso para validar valor. |
| B. Implementación interna sin código fuente | Deploy, configuración, entrenamiento, uso interno | Propiedad del código, reventa, exclusividad | 18.000-45.000 | Medio | Ideal si se quiere mantener IP. |
| C. Licencia empresarial | Uso anual/mensual, soporte, mejoras pactadas | Código fuente completo salvo acuerdo | 2.000-8.000/mes o 25.000-90.000/año | Medio | Mejor modelo si hay relación continua. |
| D. Venta con código fuente | Repo completo, documentación, transferencia básica | Exclusividad total, soporte largo | 55.000-130.000 | Alto | Cobrar prima por entregar control. |
| E. Venta con exclusividad | Código/fuente o licencia exclusiva por industria/región | Soporte infinito, garantías no pactadas | 120.000-250.000 | Muy alto | Solo con contrato claro y prima fuerte. |
| F. Compra total/adquisición | Derechos, código, docs, transferencia, handover | Responsabilidad indefinida si no se pacta | 180.000-350.000+ | Muy alto | Exigir alcance legal/técnico detallado. |
| G. Transición técnica mensual | Soporte de transferencia, fixes, capacitación | Nuevos módulos grandes | 4.000-12.000/mes | Medio | Recomendada por 2-3 meses si venden fuente. |
| H. Soporte opcional | Mantenimiento, bugs, monitoreo básico | Desarrollo mayor, SLA 24/7 | 1.000-5.000/mes | Medio | Útil para ingresos recurrentes. |
| I. Hardening enterprise adicional | MFA/CAPTCHA, RLS audit, e2e, monitoring, backups, workers | Compra de IP si no se pacta | 20.000-75.000 | Medio | Necesario para vender caro. |

### Recomendación final para presentar a Quicksol

Para una negociación seria con Quicksol, una posición razonable sería:

- **Piloto pago inicial:** USD 8.000-12.000.
- **Implementación interna sin código fuente:** USD 30.000-45.000.
- **Venta con código fuente, sin exclusividad:** USD 75.000-120.000, condicionada a corregir migraciones/env y demo estable.
- **Venta con exclusividad o adquisición total:** no bajar de USD 150.000 si se entrega IP relevante, y apuntar a USD 200.000+ si se estabiliza producción, se documenta transferencia y se prueba valor con datos reales.

La recomendación comercial más inteligente es no vender barato el código fuente antes de estabilizar password reset, chat, analytics y email, porque esos fallos reducen poder de negociación.

---

## 18. Argumentario comercial

### Frase corta

Quiksol transforma Excel operativos dispersos en inteligencia empresarial segura, consultable y auditada.

### Pitch de 30 segundos

Quiksol Excel Intelligence System es una plataforma interna para empresas que manejan cotizaciones, MPN, proveedores, clientes, precios y márgenes en Excel. Permite subir archivos, normalizar datos, detectar errores, consultar registros, analizar métricas, comparar proveedores, usar IA y voz sobre datos controlados, administrar usuarios, enviar alertas y colaborar por chat interno. No reemplaza solo una hoja de cálculo: convierte la operación diaria en un sistema auditable y escalable.

### Pitch de 2 minutos

Muchas empresas tienen información crítica en archivos Excel: ofertas de proveedores, RFQ, clientes, PO, precios, costos, GP, inventario y logística. El problema es que esa información queda dispersa, difícil de auditar y dependiente de la memoria del equipo. Quiksol resuelve eso con una plataforma interna que recibe Excel/CSV, detecta encabezados, normaliza columnas, clasifica categorías, guarda errores, conserva el archivo original y transforma cada fila en un registro consultable.

Sobre esa base, el sistema agrega dashboard, analytics, búsqueda ejecutiva, comparador de MPN, roles, RLS, logs, auditoría, alertas por correo, chat interno, perfiles, avatares e IA conectada a datos mediante herramientas controladas. Un admin puede revisar calidad y actividad, un manager puede analizar márgenes o errores, y un employee puede consultar sus datos sin abrir decenas de archivos.

El valor no está solo en la interfaz: está en la estructura de datos, la seguridad, la trazabilidad y la capacidad de convertir operación manual en inteligencia de negocio.

### Para dueño de empresa

Esto le da control sobre información que hoy depende de archivos sueltos y personas específicas. Puede saber qué se subió, quién lo subió, qué errores tiene, qué proveedor conviene y dónde están los márgenes críticos.

### Para gerente operativo

Reduce tiempo de búsqueda, mejora la calidad de datos y permite revisar cargas, errores, proveedores, MPN y métricas sin reconstruir reportes manualmente.

### Para comprador técnico

El sistema está construido con Next.js, Supabase Auth/Postgres/Storage, RLS, API routes, migraciones, Zod, logging, tests unitarios, OpenAI, ElevenLabs, Resend/SMTP y arquitectura modular. Tiene deuda pendiente, pero no es un prototipo vacío.

### Para inversionista

Es una base de producto verticalizable para empresas que operan con Excel comerciales. Puede venderse como implementación interna, licencia empresarial o evolucionar a SaaS con multi-tenancy, billing, workers y hardening.

### Por qué esto vale más que una página web

- Tiene autenticación, roles y base de datos.
- Procesa archivos reales y convierte datos en registros.
- Aplica reglas de calidad y normalización.
- Incluye storage privado y trazabilidad.
- Tiene panel admin, logs, auditoría y seguridad.
- Usa IA conectada a datos, no solo un chatbot genérico.
- Incluye voz, email, chat y endpoints internos.
- Requiere conocimiento de negocio, no solo diseño visual.

### Por qué esto puede justificar una valoración alta

- Ataca un dolor empresarial concreto y costoso: Excel operativo disperso.
- Tiene módulos que normalmente se cotizan por separado.
- Puede ahorrar tiempo recurrente, no solo entregar una página.
- Puede mejorar decisiones de compra/venta por MPN, precio y margen.
- Tiene base para escalar a licencias repetibles.
- Incluye activos técnicos transferibles: código, migraciones, tests y documentación.

---

## 19. Limitaciones y pendientes

| Pendiente | Impacto | Urgencia | Dificultad | Recomendación |
|---|---|---|---|---|
| Aplicar migración enterprise en producción | Password reset, chat, avatars y email center pueden fallar | Crítica | Media | Ejecutar/verificar `20260629000000_enterprise_mvp.sql` en Supabase. |
| Correo de recuperación no estable | Usuarios no recuperan acceso | Crítica | Media | Revisar tabla, secret, provider, logs y respuesta JSON. |
| Analytics/categories con 500 observado | Dashboard pierde confianza en demo | Alta | Media | Validar esquema, logs y queries en producción. |
| Chat con 500 observado | Módulo colaborativo no usable | Alta | Media | Aplicar tablas/RPC, probar users/conversations/messages. |
| Env vars incompletas | Features fallan silenciosamente | Alta | Baja/Media | Checklist Render/Supabase antes de demo. |
| Resend/SMTP no confirmado | Emails no llegan | Alta | Baja/Media | Verificar dominio, SPF/DKIM/DMARC y logs provider. |
| MFA/CAPTCHA faltante | Riesgo de seguridad | Alta | Media | Agregar antes de venta enterprise. |
| Backups/restores no probados | Riesgo operacional | Alta | Media | Documentar y ejecutar restore drill. |
| Monitoreo externo faltante | Incidentes tardíos | Alta | Media | Sentry/uptime/log drain/alerts. |
| SLA no definido | Riesgo contractual | Media | Baja | Definir soporte, tiempos, exclusiones. |
| Escalabilidad de uploads grandes | Riesgo con 50k/100k filas | Media/Alta | Alta | Workers, colas y procesamiento async. |
| SSO no implementado | Limitación para corporativos | Media | Alta | Planificar SAML/OIDC enterprise. |
| Revisión RLS pendiente | Riesgo de fuga/bloqueo de datos | Alta | Alta | Auditoría técnica con casos por rol. |
| Pen test pendiente | Riesgo antes de venta grande | Alta | Media/Alta | Contratar revisión externa. |
| Pruebas con usuarios reales | UX y flujo pueden fallar en operación | Alta | Media | Piloto con usuarios reales y dataset real. |
| Retención legal chat/correo | Riesgo legal | Media | Media | Definir política y exportación. |
| Manager scope exacto | Permisos ambiguos | Media/Alta | Media | Cerrar regla por equipo/departamento/región. |
| `.env.local` con posible BOM | Supabase CLI puede fallar | Media | Baja | Guardar `.env.local` como UTF-8 sin BOM. |

---

## 20. Checklist para demo empresarial

### Infraestructura

- [ ] Supabase project correcto.
- [ ] Migraciones aplicadas en orden: plataforma, observabilidad, email alerts, enterprise MVP.
- [ ] Buckets `excel-uploads`, `chat-attachments`, `avatars` creados y con políticas.
- [ ] Render deploy actualizado.
- [ ] Variables Render completas.
- [ ] `NEXT_PUBLIC_APP_URL` apunta al dominio correcto.
- [ ] `PASSWORD_RESET_SECRET` fuerte.
- [ ] `SUPABASE_SERVICE_ROLE_KEY` configurada solo en servidor.
- [ ] Resend o SMTP real verificado.
- [ ] OpenAI configurado si se mostrará IA.
- [ ] ElevenLabs configurado si se mostrará voz.

### Usuarios

- [ ] Login admin.
- [ ] Login manager.
- [ ] Login employee.
- [ ] Usuario inactivo bloqueado.
- [ ] No-admin bloqueado de `/admin`.

### Flujo de datos

- [ ] Upload Excel real.
- [ ] Archivo original guardado en `excel-uploads`.
- [ ] Batches/sheets/records creados.
- [ ] Import errors visibles si existen.
- [ ] Dashboard carga sin error.
- [ ] Records filtra y pagina.
- [ ] Search encuentra MPN/cliente/proveedor.
- [ ] Categories carga sin infinito.
- [ ] Analytics carga sin 500.
- [ ] MPN comparator con MPN conocido.
- [ ] Executive search con al menos 3 frases.

### IA y voz

- [ ] IA texto responde sobre último upload.
- [ ] IA texto respeta permisos employee.
- [ ] Voz transcribe audio.
- [ ] Voz responde con audio si ElevenLabs está activo.
- [ ] Fallback de voz/texto maneja errores sin romper UI.

### Comunicación

- [ ] Email alert test llega.
- [ ] Email center envía a destinatario de prueba.
- [ ] Password reset envía código real.
- [ ] Password reset verifica código.
- [ ] Password reset cambia contraseña.
- [ ] Chat lista usuarios.
- [ ] Chat crea conversación directa.
- [ ] Chat crea grupo si admin.
- [ ] Chat envía mensaje.
- [ ] Chat sube adjunto y genera signed URL.
- [ ] Avatar sube y elimina correctamente.

### Observabilidad y seguridad

- [ ] `/admin/logs` muestra eventos.
- [ ] `/admin/security` registra acceso no autorizado.
- [ ] `/admin/audit-logs` registra acciones.
- [ ] `/admin/performance` muestra tiempos.
- [ ] Trace detail abre con traceId.
- [ ] Consola browser sin errores críticos.
- [ ] Network sin 500 en flujos demo.

---

## 21. Conclusión para negociación

Quiksol Excel Intelligence System tiene una base técnica y comercial valiosa: no es un sitio informativo, sino una plataforma interna con ingesta de datos, normalización, seguridad, roles, analítica, IA, voz, email, chat, auditoría y documentación. Su valor más fuerte está en resolver un problema muy concreto: empresas que tienen información crítica atrapada en Excel y necesitan convertirla en datos consultables y gobernables.

La oportunidad comercial es real, pero el precio final depende de estabilizar producción. Los incidentes actuales de password reset, analytics/categories y chat reducen el valor percibido en una demo si no se corrigen antes. Con migraciones aplicadas, env vars completas, email real funcionando, IA/voz configuradas y pruebas E2E básicas, el proyecto puede defender una valoración mucho más alta.

Recomendación de negociación:

- No presentarlo como "enterprise listo" todavía.
- Presentarlo como "MVP empresarial avanzado con módulos enterprise en proceso de hardening".
- Vender primero un piloto pago o implementación interna.
- Reservar código fuente/exclusividad para rangos altos.
- Corregir password reset, chat y analytics antes de una demo decisiva.

### Valoración recomendada resumida

| Tipo de venta | Rango recomendado |
|---|---:|
| Piloto pago | USD 8.000-12.000 |
| Implementación interna sin fuente | USD 30.000-45.000 |
| Licencia empresarial anual | USD 25.000-90.000/año |
| Venta con código fuente | USD 75.000-120.000 |
| Exclusividad/adquisición | USD 150.000-350.000+ |

### Riesgos principales

1. Migración enterprise no aplicada o incompleta en producción.
2. Recuperación de contraseña por correo no estable.
3. Analytics/categories con errores 500 observados.
4. Chat dependiente de tablas/RPC faltantes.
5. Email real dependiente de Resend/SMTP y dominio verificado.
6. Falta de MFA/CAPTCHA, pen test, monitoreo externo y restore drill.
7. Escalabilidad limitada si se procesan archivos muy grandes dentro del request.

### Comandos y fuentes revisadas

Durante la revisión se usaron inspecciones del repositorio y verificaciones de calidad, incluyendo:

- `git status --short --branch`
- `Get-Content` sobre la solicitud adjunta.
- `Get-Content` sobre rutas clave de MPN y búsqueda ejecutiva.
- Revisión de `package.json`, `README.md`, `.env.example`, `next.config.mjs`, `proxy.ts`.
- Búsquedas con `rg` sobre rutas, endpoints, tests, migraciones y servicios.
- Revisión de migraciones en `supabase/migrations`.
- Revisión de documentación en `docs`.
- Verificaciones recientes: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`.

### Siguiente acción técnica recomendada

Antes de presentar el sistema a Quicksol o a un comprador:

1. Aplicar/verificar migración `20260629000000_enterprise_mvp.sql`.
2. Confirmar `password_reset_codes`, `chat_*`, `profiles.avatar_path`, buckets y RPCs.
3. Configurar `PASSWORD_RESET_SECRET`, `RESEND_API_KEY` o SMTP y `EMAIL_FROM`.
4. Hacer smoke test de `/api/analytics`, `/api/auth/password-reset/request`, `/api/chat/users` y `/api/chat/conversations`.
5. Grabar demo estable con dataset real y logs limpios.

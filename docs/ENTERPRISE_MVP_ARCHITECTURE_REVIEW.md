# Revisión de arquitectura para MVP empresarial

Fecha: 2026-06-29
Sistema: Quiksol Excel Intelligence System
Alcance: aplicación Next.js, Supabase, datos Excel/CSV, Auth, RLS, Storage, observabilidad, IA, correo y colaboración.

## Resumen ejecutivo

Quiksol ya contaba con una base funcional sólida para un MVP: Next.js App Router, TypeScript estricto, Supabase Auth, políticas RLS para los datos de negocio, almacenamiento privado de Excel, separación visual de administración, validación de cargas, trazas, auditoría, IA de texto/voz y alertas de correo.

La revisión encontró cuatro riesgos que impedían presentarlo como MVP empresarial sin reservas:

1. El límite de solicitudes original existía solo en memoria del proceso de Render.
2. La IA mezclaba intención, consultas y prompting, y varias consultas estaban codificadas en un archivo grande.
3. No existían recuperación por código, colaboración interna ni historial de correo administrativo con RLS.
4. Analítica descargaba columnas JSON grandes que no utilizaba y el directorio de empleados hacía consultas N+1.

La implementación de esta fase corrige esos puntos, agrega una migración empresarial idempotente y mantiene las funciones previas. La aplicación queda lista para una demostración empresarial controlada después de ejecutar la migración, configurar secretos de producción, verificar el dominio de correo y completar las pruebas manuales descritas en el reporte de implementación.

## 1. Estado actual de la arquitectura

### Frontend

- Next.js 16 con App Router y React 18.
- Shell compartido con navegación, idioma, perfil y asistente flotante.
- Componentes cliente para paneles interactivos; API routes como límite de confianza.
- Diseño diferenciado: área admin naranja y área operativa azul/neutral.
- Estados de carga y error presentes en los nuevos flujos.
- Gráficas Recharts cargadas de forma diferida al abrir el modal.

### Backend

- Route Handlers de Next.js ejecutados en runtime Node.js.
- `getAuthContext` y `requireAdmin` centralizan sesión, perfil y autorización.
- Service role restringido a operaciones de servidor: administración de Auth, recuperación de contraseña, logs confiables y evaluación automática de alertas.
- Zod valida las entradas nuevas y las rutas sensibles aplican rate limiting.
- Auditoría persistente para acciones administrativas y eventos de seguridad.

### Datos y Supabase

- Esquema relacional para perfiles, cargas, hojas, registros, errores, auditoría y observabilidad.
- RLS para datos de negocio con ámbitos admin, manager y employee.
- Migración empresarial agrega recuperación, rate limits, email center, chat, adjuntos, avatares e índices.
- Buckets privados: `excel-uploads` y `chat-attachments`.
- Bucket público controlado: `avatars`; solo el propietario puede escribir o eliminar su ruta.

## 2. Riesgos técnicos encontrados

| Riesgo | Estado | Tratamiento |
|---|---|---|
| Rate limit en memoria | Corregido para rutas críticas | Estado persistente en `api_rate_limits`, con fallback local |
| IA acoplada a consultas | Corregido | Router, permisos y diez tools cerradas |
| N+1 en directorio de empleados | Corregido con fallback | RPC `get_employee_activity_directory` |
| Payload analítico con JSON no usado | Corregido | Selección explícita de columnas |
| Límites fijos de 5.000/10.000 filas en analítica | Pendiente para escala grande | Crear vistas agregadas o materializadas antes de superar esos volúmenes |
| Estado local de UI sin caché compartida | Aceptable para MVP | Evaluar React Query/SWR cuando haya más tráfico |
| Reporte semanal sin scheduler dedicado | Pendiente | Programar Render Cron o Supabase Cron |
| Chat sin presencia, reacciones ni edición visual | Aceptable para MVP | Evolución posterior; el esquema ya soporta edición y borrado lógico |

## 3. Riesgos de seguridad encontrados

### Corregidos

- La IA ya no construye ni ejecuta SQL generado por el modelo.
- Los códigos de recuperación se guardan como HMAC SHA-256, nunca en texto plano.
- El token posterior a la verificación también se guarda únicamente como hash.
- Recuperación protegida contra enumeración, reenvío rápido, fuerza bruta y reutilización.
- Centro de correo resuelve destinatarios desde perfiles activos en el servidor.
- Mensajes de correo escapan HTML administrado por usuarios.
- Adjuntos de chat son privados y se descargan mediante URL firmada después de validar membresía.
- Exportación CSV neutraliza fórmulas que comienzan con `=`, `+`, `-`, `@`, tab o retorno.
- CSP de producción elimina `unsafe-eval`; se agregan HSTS y políticas cross-origin.

### Requieren configuración operativa

- Rotar cualquier key que se haya pegado en chats, capturas, tickets o repositorios.
- Configurar `PASSWORD_RESET_SECRET` con mínimo 32 caracteres aleatorios.
- Verificar dominio propio en Resend antes de enviar a empleados distintos del propietario de la cuenta.
- Activar protección de bots/CAPTCHA y revisar límites de Auth en Supabase. El login usa Supabase Auth directamente.
- Revisar periódicamente usuarios con service role y logs de acceso de Render.

### Riesgo de alcance manager

La política actual permite a manager leer usuarios/cargas cuando coincide departamento **o** región. Esto respeta el modelo heredado, pero puede ser más amplio de lo esperado. Antes de una venta se debe confirmar si la regla comercial correcta es:

- mismo departamento;
- misma región;
- ambos;
- o una tabla explícita de equipos administrados.

## 4. Problemas de rendimiento

- Analítica leía `raw_data`, `normalized_data` y `searchable_text` aunque no eran necesarios.
- El directorio admin ejecutaba tres consultas por usuario.
- Recharts formaba parte del bundle inicial del dashboard.
- Algunos endpoints administrativos aún cargan hasta 100/200 elementos; es aceptable para MVP pero deben paginarse antes de miles de filas.

Los cambios y métricas están en `docs/PERFORMANCE_REVIEW.md`.

## 5. Problemas de base de datos

- Faltaban tablas para recuperación, mensajes administrativos y chat.
- Faltaban índices compuestos para lote/fecha, MPN/GP y mensajes por conversación.
- No existía directorio agregado de actividad de empleados.
- Realtime no estaba preparado para mensajes.

La migración `20260629000000_enterprise_mvp.sql` cubre estos puntos y es idempotente.

## 6. Problemas de experiencia de usuario

### Corregidos

- Recuperación de contraseña reemplaza el flujo ambiguo por pasos de código y cambio de contraseña.
- Alertas usan nombres humanos, ejemplos, métricas, estados, edición, prueba y errores reales.
- Centro de correo permite buscar y seleccionar perfiles, aplicar plantillas y revisar historial.
- Chat ofrece conversaciones, búsqueda, no leídos, grupos, adjuntos, referencias y avatares.
- Nuevas pantallas incluyen empty, loading y error states.

### Pendientes

- Traducir todo el contenido interno nuevo, no solo navegación, a inglés y chino.
- Añadir notificaciones push/browser opcionales para chat.
- Incorporar confirmación visual y progreso para adjuntos muy grandes.

## 7. Partes listas para MVP empresarial

- Login y sesiones con Supabase Auth.
- Roles admin/manager/employee con RLS base.
- Carga y validación de Excel/CSV.
- Storage privado de originales.
- Registros paginados y buscador ejecutivo.
- Dashboards operativos para volúmenes MVP.
- Logs, trazas, auditoría y eventos de seguridad.
- IA controlada por tools y ámbito de rol.
- Recuperación de contraseña por código.
- Alertas y centro de correo auditables.
- Chat interno básico y avatares.

## 8. Partes que necesitan hardening adicional

- Prueba de penetración externa y revisión independiente de RLS.
- SSO/SAML, MFA obligatorio y políticas de sesión si el cliente lo exige.
- Vistas agregadas/materializadas para analítica de cientos de miles de filas.
- Cola de trabajos para correos masivos y procesamiento de archivos grandes.
- Retención, exportación y borrado legal de chats/correos.
- Backup restaurado en un proyecto Supabase alterno, no solo backup configurado.
- Monitoreo externo con alertas de disponibilidad y latencia.

## 9. Plan recomendado por fases

1. **Despliegue controlado:** ejecutar migración, cargar env vars y validar smoke tests.
2. **Seguridad operativa:** rotar secrets, verificar dominio, activar CAPTCHA/MFA y revisar RLS con dos usuarios reales.
3. **Carga y escala:** medir consultas reales con `pg_stat_statements` y mover agregados a SQL cuando el dataset crezca.
4. **Gobierno:** definir retención de archivos, chat, logs y correo.
5. **Venta empresarial:** prueba de penetración, SLA, plan de recuperación y documentación de soporte.

## 10. Archivos principales tocados

- `supabase/migrations/20260629000000_enterprise_mvp.sql`
- `lib/security/password-reset.ts`
- `lib/security/persistent-rate-limit.ts`
- `lib/ai/database-tools.ts`
- `lib/ai/ai-query-router.ts`
- `lib/ai/ai-permissions.ts`
- `lib/chat/*`
- `lib/email/admin-email.ts`
- `app/api/auth/password-reset/*`
- `app/api/admin/email-center/*`
- `app/api/chat/*`
- `app/api/profile/avatar/route.ts`
- `app/forgot-password`, `app/reset-password`, `app/admin/email-center`, `app/chat`, `app/profile`
- `components/chat/*`
- `components/email/*`
- `next.config.mjs`, `proxy.ts`, `.env.example`

## 11. Migraciones necesarias

Ejecutar en este orden si el proyecto remoto aún no las tiene:

1. `20260624000000_quiksol_platform.sql`
2. `20260624010000_observability_logs.sql`
3. `20260626010000_email_alerts.sql`
4. `20260629000000_enterprise_mvp.sql`

No desplegar las nuevas rutas a producción sin la cuarta migración: las pantallas mostrarán errores de setup y el rate limit caerá al respaldo local.

## 12. Variables de entorno

Obligatorias en producción:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `NEXT_PUBLIC_APP_URL`
- `PASSWORD_RESET_SECRET`
- `RESEND_API_KEY` o configuración SMTP
- `EMAIL_FROM`
- `OPEN_IA` o `OPENAI_API_KEY`

Recomendadas/ajustables:

- `ENABLE_RATE_LIMITING=true`
- `ENABLE_EMAIL_ALERTS=true`
- `PASSWORD_RESET_CODE_TTL_MINUTES=15`
- `PASSWORD_RESET_MAX_ATTEMPTS=5`
- `PASSWORD_RESET_RESEND_SECONDS=60`
- `CHAT_MAX_ATTACHMENT_MB=15`
- `AVATAR_MAX_SIZE_MB=5`

## 13. Pruebas necesarias

- Unitarias: hash/código, password policy, permisos IA/chat, sanitización de email, validación avatar.
- Integración: cada nueva API con admin, manager, employee y sin sesión.
- RLS: dos empleados no deben leer chats, cargas ni adjuntos ajenos.
- E2E: recuperación completa, correo admin, alerta, pregunta IA, chat directo/grupo y avatar.
- Carga: Excel válido, inválido, máximo de filas, máximo de tamaño y fórmula maliciosa.
- Rendimiento: p50/p95 de dashboard, records, chat y upload antes/después.

## Checklists

### Seguridad

- [x] Zod en nuevas entradas.
- [x] RLS en nuevas tablas.
- [x] Storage privado para adjuntos.
- [x] Service role solo en servidor.
- [x] IA sin SQL libre.
- [x] Rate limit persistente en rutas críticas nuevas.
- [x] Auditoría en acciones administrativas.
- [ ] MFA/CAPTCHA activado en Supabase.
- [ ] Pen test externo.

### Performance

- [x] Columnas analíticas explícitas.
- [x] Directorio agregado sin N+1 cuando la migración está activa.
- [x] Índices compuestos y de chat.
- [x] Recharts lazy-loaded.
- [x] Límites y paginación de mensajes.
- [ ] Agregados SQL/materializados para más de 10.000 registros activos.

### Supabase

- [ ] Cuatro migraciones ejecutadas en producción.
- [ ] RLS verificado con usuarios reales de cada rol.
- [ ] Buckets `chat-attachments` y `avatars` creados.
- [ ] Realtime habilitado para `chat_messages`.
- [ ] Backups y restauración probados.

### Render

- [ ] Env vars cargadas sin espacios o comillas accidentales.
- [ ] Build `npm ci && npm run build`.
- [ ] Start `npm run start`.
- [ ] Health/smoke test posterior al deploy.
- [ ] Secrets rotados después de cualquier exposición.

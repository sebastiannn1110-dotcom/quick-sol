# Chat privacy, employee directory and email center report

Fecha: 2026-06-29

## Cambios implementados

- Se reforzo el chat normal para que liste solo conversaciones donde el usuario actual es miembro.
- Se agregaron verificaciones explicitas de membresia antes de leer mensajes, enviar mensajes, marcar como leido, subir adjuntos y abrir adjuntos.
- Se creo `/admin/chat-audit` como vista separada de auditoria administrativa.
- Se agregaron campos publicos de perfil: `bio` y `job_title`.
- Se agrego endpoint `PATCH /api/profile` para que cada usuario edite su descripcion y cargo visible sin cambiar su rol real.
- Se mejoro `/employees` como directorio interno con avatar, cargo, area, region, bio y boton para abrir chat.
- Se actualizo el chat visual con burbujas tipo WhatsApp, avatar de remitente y preview de imagenes adjuntas.
- Se reemplazo el bloque visual `QS` por `QuiksolIcon` reutilizable basado en `/logo-ia.png`.
- Se amplio `/admin/email-center` para enviar correos manuales a correos internos o externos con multiples adjuntos.
- Se mantiene `/admin/email-alerts` como automatizacion avanzada, no como flujo principal.

## Privacidad del chat

Regla del chat normal:

- A y B ven su conversacion privada.
- C no ve esa conversacion, no lee mensajes y no descarga adjuntos.
- Un grupo solo aparece a sus miembros.
- El canal general `Todos` sigue separado como `all_company`.
- Admin no ve todo mezclado en `/chat`; la auditoria vive en `/admin/chat-audit`.

Endpoints reforzados:

- `GET /api/chat/conversations`
- `GET /api/chat/conversations/[id]/messages`
- `POST /api/chat/conversations/[id]/messages`
- `PATCH /api/chat/conversations/[id]/read`
- `POST /api/chat/conversations/[id]/attachments`
- `GET /api/chat/attachments/[id]`

## Como probar A/B/C

1. Crear tres usuarios activos: A, B y C.
2. Entrar como A y crear chat directo con B.
3. Enviar mensaje y adjunto.
4. Entrar como B y confirmar que ve la conversacion.
5. Entrar como C y confirmar que la conversacion no aparece en `/chat`.
6. Intentar abrir URL directa de mensajes o adjunto con C; debe responder 403/404.
7. Entrar como admin y abrir `/admin/chat-audit`; ahi si debe poder auditar en solo lectura.

## Admin audit

Ruta:

- `/admin/chat-audit`

API:

- `GET /api/admin/chat-audit`

Caracteristicas:

- Solo admin.
- Usa service role en servidor.
- Lista conversaciones directas, grupos y canal general.
- Filtra por tipo y usuario.
- Abre mensajes en modo lectura.
- Registra auditoria con `admin_opened_chat_audit`.

## Perfil y directorio

Nuevos campos:

- `profiles.bio`
- `profiles.job_title`

Endpoints:

- `PATCH /api/profile`
- `GET /api/employees`

Reglas:

- Usuario edita su bio/cargo visible.
- Usuario no puede cambiar su rol real.
- Admin puede editar bio/cargo desde `/admin/users`.
- El directorio muestra perfiles activos con datos no sensibles.

## Email center con adjuntos

Ruta principal:

- `/admin/email-center`

API:

- `GET /api/admin/email-center`
- `POST /api/admin/email-center/send`
- `GET /api/admin/email-center/history`

Nuevas capacidades:

- Destinatarios manuales externos.
- Seleccion de empleados internos.
- Envio individual o multiple.
- Asunto y mensaje.
- Multiples adjuntos en un solo envio.
- Imagenes y documentos seguros.
- Historial con adjuntos.
- Envio individual por destinatario para no exponer correos entre personas.

Archivos permitidos:

- PDF
- TXT
- CSV
- XLS/XLSX
- JPG/PNG/WebP

## Migracion nueva

Archivo:

- `supabase/migrations/20260630000000_chat_privacy_email_center_profiles.sql`

Incluye:

- Columnas `bio` y `job_title`.
- RPC `update_my_profile_public`.
- RPC `list_employee_directory`.
- RPC `list_chat_users` actualizado con avatar, bio y job title.
- Refuerzo de politicas RLS de chat por membresia.
- Tabla `admin_email_attachments`.
- Bucket `email-attachments`.
- Politicas storage para adjuntos de correo.

## Variables nuevas

Opcional:

- `ADMIN_EMAIL_ATTACHMENT_MAX_MB`

Default: 20 MB, con limite maximo interno de 25 MB.

## Riesgos pendientes

- Aplicar migracion en Supabase antes de probar produccion.
- Validar RLS con usuarios reales A/B/C.
- Confirmar `SUPABASE_SERVICE_ROLE_KEY` en Render para `/admin/chat-audit`.
- Confirmar provider real Resend/SMTP para adjuntos.
- Revisar limites reales de adjuntos del proveedor de correo.
- Agregar Playwright E2E para flujo completo chat + email con archivos.

# Quiksol Excel Intelligence System - Estado y arquitectura

## Estado actual

Quiksol es una aplicacion Next.js con Supabase para autenticacion, base de datos, storage, permisos y auditoria. El sistema tiene panel administrativo, carga y analisis de Excel, categorias, analitica, chat privado, directorio de empleados, perfiles, recuperacion de contrasena y centro de correos.

## Recuperacion de contrasena por correo

Flujo real esperado:

1. El usuario escribe su correo en `/forgot-password`.
2. `POST /api/auth/password-reset/request` valida el formato del correo.
3. El servidor busca el correo activo en `profiles`.
4. Si el correo no existe, responde el mismo mensaje generico y no crea codigo.
5. Si el correo existe, crea una fila en `password_reset_codes`.
6. Despues de crear el codigo, intenta enviar el correo real con Resend o SMTP.
7. `/reset-password` verifica el codigo y permite guardar una nueva contrasena.

El mensaje publico se mantiene generico para no revelar si un correo existe:

```json
{
  "message": "Si el correo esta registrado, enviaremos un codigo de recuperacion.",
  "cooldownSeconds": 60
}
```

Los logs del servidor si muestran el diagnostico real. Eventos principales:

```txt
password_reset_request_started
password_reset_user_lookup_done
password_reset_user_not_found
password_reset_code_created
password_reset_email_provider_selected
password_reset_email_send_started
password_reset_email_sent
password_reset_email_failed
```

Por seguridad, los logs no imprimen el codigo de recuperacion, passwords, API keys ni service role key.

## Diagnostico de correo

Endpoint admin:

```txt
GET /api/admin/email-center/debug
```

Respuesta esperada:

```json
{
  "provider": "resend",
  "hasResendApiKey": true,
  "hasSmtpConfig": false,
  "emailFrom": "Quiksol Alerts <onboarding@resend.dev>",
  "canSendRealEmail": true,
  "warnings": [
    "Using onboarding@resend.dev may be limited. Verify a custom domain in Resend for production delivery."
  ]
}
```

Variables requeridas para correo real en Render:

```env
PASSWORD_RESET_SECRET=...
NEXT_PUBLIC_APP_URL=https://quick-sol.onrender.com
RESEND_API_KEY=...
EMAIL_FROM=Quiksol Alerts <correo@dominio-verificado.com>
```

Alternativa SMTP:

```env
SMTP_HOST=...
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
SMTP_FROM=Quiksol Alerts <correo@dominio.com>
```

Notas:

- Si `RESEND_API_KEY` existe, se usa `resend`.
- Si no hay Resend pero existe SMTP completo, se usa `smtp`.
- Si no hay proveedor real, queda en `mock` y no envia correo real.
- Si `ENABLE_EMAIL_ALERTS=false`, queda en `disabled`.
- `onboarding@resend.dev` puede servir para pruebas limitadas, pero en produccion conviene verificar un dominio propio en Resend y usar un remitente de ese dominio.

## Email Center

El endpoint admin acepta el payload de la UI y tambien este payload simple para pruebas desde consola:

```json
{
  "recipients": ["correo@gmail.com"],
  "subject": "Asunto",
  "body": "Mensaje",
  "attachments": []
}
```

Campos de la UI compatibles:

```json
{
  "manualEmails": ["externo@dominio.com"],
  "userIds": ["00000000-0000-4000-8000-000000000001"],
  "roles": ["employee"],
  "allEmployees": false,
  "department": null,
  "region": null,
  "subject": "Asunto",
  "body": "Mensaje"
}
```

El envio queda registrado en `admin_email_messages`. Los adjuntos se guardan en el bucket `email-attachments` y se registran en `admin_email_attachments`.

## Arquitectura

Capas principales:

1. Frontend Next.js App Router: paginas en `app/*`, componentes en `components/*`.
2. API routes: endpoints en `app/api/*` para auth, admin, chat, logs, analitica, categorias y correo.
3. Servicios de dominio: logica compartida en `lib/*`.
4. Supabase: Auth, Postgres, RLS, Storage y service role solo en servidor.
5. Email provider: Resend o SMTP mediante `lib/email/email-service.ts`.
6. Observabilidad: logger interno, `system_logs`, `client_logs` y logs de Render.

Tablas clave:

```txt
profiles
password_reset_codes
admin_email_messages
admin_email_attachments
chat_conversations
chat_members
chat_messages
system_logs
client_logs
```

## Checklist de produccion

1. Confirmar que `profiles.email` existe y `is_active=true` para el usuario.
2. Confirmar que existe `password_reset_codes`.
3. Confirmar `PASSWORD_RESET_SECRET`.
4. Confirmar `RESEND_API_KEY` o SMTP completo.
5. Revisar `/api/admin/email-center/debug` como admin.
6. Evitar `onboarding@resend.dev` para produccion; usar dominio verificado.
7. Probar `/forgot-password` con un correo registrado.
8. Revisar logs Render por `password_reset_email_sent` o `password_reset_email_failed`.

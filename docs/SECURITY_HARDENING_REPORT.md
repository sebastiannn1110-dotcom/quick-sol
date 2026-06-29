# Reporte de hardening de seguridad

## Modelo de confianza

- El navegador no es confiable.
- La sesión se valida con `supabase.auth.getUser()` en las APIs.
- RLS es la última barrera de datos.
- Service role solo se crea en código servidor y nunca se devuelve al frontend.
- OpenAI recibe resultados limitados de herramientas controladas, no credenciales ni acceso SQL.

## Cambios implementados

### Recuperación de contraseña

- Código exacto de cuatro letras y cuatro números.
- HMAC SHA-256 con `PASSWORD_RESET_SECRET`.
- Expiración configurable, 15 minutos por defecto.
- Cinco intentos por defecto.
- Cooldown de 60 segundos.
- Rate limit por IP y correo.
- Mensaje genérico para evitar enumeración.
- Token de confirmación aleatorio, de un solo uso y también hasheado.
- Auditoría del cambio y evento de seguridad al agotar intentos.

### IA

- Diez funciones de datos permitidas.
- Router determinista de intención.
- Ámbito explícito: company, team o own.
- Employee fuerza `uploaded_by = user.id` además de RLS.
- Solicitudes globales bloqueadas para no-admin.
- Límites de filas y campos explícitos.
- Log de pregunta truncada, tool, resumen y tiempo.

### Correo

- Solo admin.
- Destinatarios resueltos desde `profiles` activos.
- Máximo 100 por envío y rate limit.
- Envío individual para no exponer la lista completa entre destinatarios.
- HTML escapado.
- Historial y estado por destinatario.
- Auditoría sin guardar secrets.

### Chat

- RLS por membresía en conversaciones, miembros, mensajes y adjuntos.
- Creación transaccional mediante RPC validada.
- Solo admin crea grupos globales o grupales.
- Bucket privado y URL firmada.
- Tipos y tamaño de archivo restringidos.
- Rate limits para conversaciones, mensajes y adjuntos.
- Canal general preparado con miembros activos presentes y futuros.

### Avatar

- JPG, PNG o WebP.
- Máximo configurable, 5 MB por defecto.
- Carpeta obligatoria por `auth.uid()`.
- RPC que solo permite modificar la ruta propia.
- Sin permiso de actualizar rol/email desde el flujo de avatar.

### Headers

- CSP con `unsafe-eval` únicamente en desarrollo.
- HSTS.
- `frame-ancestors 'none'` y X-Frame-Options DENY.
- `nosniff`.
- Permissions Policy restringida.
- Cross-Origin-Opener/Resource Policy.

### Archivos y exportaciones

- Los adjuntos se validan por MIME y tamaño.
- Los Excel conservan validaciones anteriores de tipo, extensión, hojas, filas y tamaño.
- CSV exportado neutraliza formula injection.

## Variables secretas

Nunca deben tener prefijo `NEXT_PUBLIC_`:

- `SUPABASE_SERVICE_ROLE_KEY`
- `PASSWORD_RESET_SECRET`
- `RESEND_API_KEY`
- `SMTP_PASS`
- `OPEN_IA` / `OPENAI_API_KEY`
- `ELEVENLABS_API_KEY`

Las únicas variables Supabase públicas son URL y publishable/anon key. Estas no reemplazan RLS.

## Riesgos residuales

1. El login se ejecuta directamente contra Supabase Auth. La protección de login se configura en Supabase (rate limits, CAPTCHA, MFA).
2. El fallback local de rate limit no es compartido entre instancias; solo se usa si la migración/RPC persistente no está disponible.
3. El bucket de avatares es público. No debe utilizarse para documentos o imágenes sensibles.
4. Los cuerpos de chat y correo están almacenados en base de datos. Se necesita política de retención y acceso legal.
5. La política manager heredada usa coincidencia de departamento **o** región. Debe confirmarse con el cliente.
6. `script-src 'unsafe-inline'` sigue presente por compatibilidad con Next.js. Un nonce por solicitud es una mejora futura.

## Pruebas RLS obligatorias

1. Employee A crea un chat con Employee B.
2. Employee C intenta consultar conversación, mensajes y adjunto: debe recibir cero filas/403.
3. Employee intenta crear grupo: 403.
4. Manager consulta datos de fuera de su ámbito: cero filas.
5. Employee pregunta a IA por todos los registros: respuesta de permiso denegado.
6. Usuario intenta actualizar `profiles.role` desde cliente: debe fallar.
7. Usuario sube avatar bajo carpeta de otro UUID: debe fallar.
8. URL firmada de adjunto vence después de 60 segundos.

## Operación segura antes del deploy

- Rotar keys expuestas anteriormente.
- Ejecutar migraciones desde una cuenta controlada.
- Configurar secreto de recuperación aleatorio de 32+ caracteres.
- Verificar dominio de Resend y usar remitente del dominio.
- Activar MFA para admins.
- Confirmar backup diario y ejecutar una restauración de prueba.
- Revisar logs por `failed_permission_check`, `password_reset_attempts_exhausted` y `ai_company_scope_denied`.

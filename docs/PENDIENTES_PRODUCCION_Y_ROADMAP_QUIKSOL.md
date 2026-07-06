# Pendientes de produccion y roadmap Quiksol

Este documento concentra pendientes tecnicos, operativos y comerciales para dejar Quiksol listo para produccion, demo empresarial, venta y hardening futuro.

## 1. Pendientes criticos antes de demo

- Verificar envio real de correos.
- Terminar configuracion de proveedor de email.
- Probar password reset end-to-end.
- Probar chat privado A/B/C.
- Probar adjuntos de chat como miembro y como no miembro.
- Probar admin chat audit.
- Probar Email Center con multiples destinatarios.
- Probar Email Center con adjuntos.
- Probar IA texto con datos reales de Excel.
- Probar IA voz con datos reales.
- Probar usuario admin, manager y employee.
- Revisar consola del navegador sin errores criticos.
- Revisar logs de Render.

## 2. Pendiente especial: dominio Resend / DNS

Ahora mismo no tenemos acceso al DNS de `quiksol.com`, por lo tanto no podemos verificar ese dominio en Resend desde el codigo.

Para produccion real se necesita que Quicksol, o quien administre el dominio, agregue los registros DNS que Resend entregue:

- DKIM
- SPF
- MX

Estos registros se copian desde Resend y se pegan en el proveedor del dominio, por ejemplo GoDaddy, Cloudflare, Namecheap, Hostinger, cPanel u otro panel DNS.

Pasos futuros:

1. Entrar a Resend.
2. Ir a Domains.
3. Agregar el dominio real de Quicksol.
4. Copiar registros DKIM, SPF y MX.
5. Enviar registros al administrador del dominio.
6. Esperar verificacion en Resend.
7. Cambiar en Render:

```env
EMAIL_FROM=Quiksol Alerts <no-reply@dominio-verificado.com>
```

8. Hacer redeploy en Render.
9. Probar `/forgot-password`.
10. Revisar logs de Resend y Render.

Alternativas temporales:

- Usar SMTP temporal con un remitente real.
- Usar un dominio propio de demo ya verificado.
- Usar `onboarding@resend.dev` solo con limitaciones de prueba.
- No depender de `onboarding@resend.dev` para produccion.

## 3. Pendientes de seguridad

- Rotar `RESEND_API_KEY` porque fue expuesta en capturas.
- Rotar cualquier secret expuesto.
- Generar `PASSWORD_RESET_SECRET` real, no placeholder.
- Activar MFA para admins.
- Activar CAPTCHA o Turnstile en login y password reset.
- Auditar RLS con usuarios reales.
- Ejecutar pen test externo.
- Probar backups y restauracion.
- Activar monitoreo externo.
- Definir politica de retencion de chats y correos.
- Definir alcance exacto de manager.

## 4. Pendientes de rendimiento

- Optimizar audio y voz.
- Reducir latencia del assistant.
- Medir tiempos de `/api/assistant`, `/api/ai/voice/ask`, `/api/ai/voice/transcribe` y `/api/ai/voice/speak`.
- Agregar streaming si el presupuesto tecnico lo permite.
- Cachear respuestas de datos cuando aplique.
- Usar consultas SQL/RPC eficientes.
- Usar vistas materializadas para analytics cuando haya muchos registros.
- Mover procesos pesados a worker o cola.

## 5. Pendientes de IA y voz

- Mejorar naturalidad del texto.
- Mejorar pronunciacion de voz.
- Evitar que lea puntuacion o simbolos de forma antinatural.
- Responder con voz solo cuando el usuario habla por voz.
- Responder con texto solo cuando el usuario escribe por texto.
- Mejorar conversacion en tiempo real.
- Mejorar velocidad de transcripcion.
- Mejorar velocidad de generacion de respuesta.
- Mejorar velocidad de ElevenLabs.
- Mejorar busqueda exacta en Supabase.
- Mejorar multilenguaje espanol, ingles y chino simplificado.

## 6. Pendientes comerciales

- Preparar demo estable.
- Preparar pitch.
- Preparar valoracion.
- Preparar propuesta de venta con exclusividad.
- Preparar propuesta de salario o rol.
- Preparar documento de transferencia tecnica.
- Preparar checklist de entrega.

## 7. Pendientes posteriores a esta fase de IA

- Evaluar streaming real para texto y voz.
- Separar jobs largos de voz en una cola si Render queda lento.
- Crear datasets de prueba con MPN, proveedores, clientes, PO, GP y errores.
- Agregar pruebas E2E con usuarios admin, manager y employee.
- Medir calidad de respuestas en preguntas reales de negocio.
- Crear dashboard ejecutivo de salud de IA: latencia, errores, idioma, herramienta usada y TTS.

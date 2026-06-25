# Quiksol Voice Recording Tests

Fecha: 2026-06-25

## Cambio clave

El navegador no podia grabar porque la app enviaba este header:

```txt
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
```

`microphone=()` bloquea el microfono aunque el codigo use `navigator.mediaDevices.getUserMedia`.

La correccion deja el microfono permitido para la misma app:

```txt
Permissions-Policy: camera=(), microphone=(self), geolocation=(), payment=(), usb=()
```

## Variables necesarias

En Render deben existir estas variables:

```txt
OPEN_IA=<OpenAI API key>
ELEVENLABS_API_KEY=<ElevenLabs API key opcional>
ENABLE_VOICE_ASSISTANT=true
VOICE_MAX_AUDIO_MB=15
OPENAI_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe
```

Si ElevenLabs falla, el chat debe responder en texto. Si OpenAI falla, debe mostrar un error claro de transcripcion.

## Prueba 1: HTTPS y permisos

1. Abre `https://quick-sol.onrender.com`.
2. Inicia sesion.
3. Abre el asistente flotante.
4. Haz clic en el boton de microfono.
5. El navegador debe pedir permiso para usar el microfono.
6. Acepta el permiso.

Resultado esperado:

- El boton cambia a detener.
- Se ve el estado `Grabando... 0s`, `Grabando... 1s`, etc.
- No debe aparecer `Your browser cannot record audio`.

## Prueba 2: grabar, detener y responder

1. Graba una frase corta, por ejemplo: `Dime cual fue el ultimo Excel subido`.
2. Haz clic en detener.
3. Espera la respuesta.

Resultado esperado:

- El chat muestra tu transcripcion como mensaje de usuario.
- El asistente responde con texto.
- Si ElevenLabs esta configurado, aparece y funciona el boton `Reproducir respuesta`.

## Prueba 3: permisos bloqueados

1. Bloquea el microfono desde el candado de la barra de direcciones.
2. Haz clic en el microfono otra vez.

Resultado esperado:

- La app muestra un mensaje humano indicando que el navegador bloqueo el microfono.
- Aparece el boton alternativo para subir archivo de audio.

## Prueba 4: fallback por archivo

1. Haz clic en el boton de subir archivo de audio si aparece.
2. Selecciona `.webm`, `.mp3`, `.wav`, `.m4a` u `.ogg`.

Resultado esperado:

- La app sube el audio a `/api/ai/voice/ask`.
- El asistente responde igual que con grabacion directa.

## Prueba 5: revisar Network

En DevTools > Network busca:

```txt
POST /api/ai/voice/ask
POST /api/logs/client
```

Resultado esperado:

- `/api/ai/voice/ask` devuelve `200` si OpenAI transcribe correctamente.
- Si hay error de transcripcion, devuelve error JSON claro y el chat no se rompe.
- `/api/logs/client` puede devolver `200`; si falla por sesion, no debe romper la grabacion.

## Logs esperados

Cliente:

```txt
voice_permission_requested
voice_permission_granted
voice_permission_denied
voice_recording_started
voice_recording_stopped
voice_audio_blob_created
voice_audio_upload_started
voice_audio_upload_failed
```

Servidor:

```txt
voice_upload_received
voice_transcription_started
voice_transcription_completed
voice_transcription_failed
ai_voice_query_started
ai_voice_query_completed
ai_voice_query_failed
elevenlabs_tts_started
elevenlabs_tts_completed
elevenlabs_tts_failed
```

## Diagnostico rapido

- Si no aparece la ventana de permisos: revisa el header `Permissions-Policy`.
- Si aparece permiso denegado: revisa el candado del navegador y permite microfono.
- Si dice que requiere HTTPS: usa Render o `localhost`, no una URL HTTP externa.
- Si transcribe vacio: graba de nuevo despues de que aparezca el contador.
- Si responde texto pero no audio: revisa `ELEVENLABS_API_KEY`; la IA debe seguir funcionando en texto.

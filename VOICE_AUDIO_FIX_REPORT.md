# Voice Audio Fix Report

Fecha: 2026-06-26

## Problemas detectados

1. El navegador bloqueaba la reproduccion de la respuesta de voz por CSP:

```txt
media-src was not explicitly set, so default-src is used as a fallback
```

2. El frontend intentaba reproducir audio con `new Audio(data:...)`. Eso depende de que `data:` este permitido y puede terminar en:

```txt
NotSupportedError: Failed to load because no supported source was found.
```

3. OpenAI podia rechazar algunos audios WebM grabados en navegador con:

```txt
400 Audio file might be corrupted or unsupported
```

## Cambios implementados

- Se agrego `media-src 'self' data: blob: https:` a la CSP en `next.config.mjs`.
- El reproductor de la IA ahora convierte `audioBase64` a `Uint8Array`, crea un `Blob` y usa `URL.createObjectURL`.
- El audio ya no depende de autoplay.
- El widget muestra un reproductor compacto tipo nota de voz con play, pausa, progreso y replay.
- El backend reconstruye el archivo para OpenAI desde `arrayBuffer()` usando `toFile` del SDK oficial de OpenAI.
- Si OpenAI no puede leer el audio, el usuario recibe un error claro y la app no se rompe.
- Si ElevenLabs falla, el endpoint conserva la respuesta de texto y devuelve audio nulo.

## Variables necesarias

```txt
OPEN_IA=
OPENAI_MODEL=
OPENAI_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe
ELEVENLABS_API_KEY=
ELEVENLABS_MODEL_ID=
ELEVENLABS_VOICE_ES=
ELEVENLABS_VOICE_EN=
ELEVENLABS_VOICE_ZH=
```

## Pruebas manuales

1. Abrir el asistente flotante.
2. Grabar una nota de 5 a 8 segundos.
3. Confirmar que `/api/ai/voice/ask` no devuelve error CSP.
4. Confirmar que aparece el texto transcrito.
5. Confirmar que aparece respuesta de texto.
6. Confirmar que el reproductor de audio aparece como nota de voz.
7. Presionar play, pause y replay.
8. Confirmar que no aparece `NotSupportedError`.

## Notas

- Abrir `/api/ai/voice/ask` directamente en el navegador puede mostrar 405 porque el endpoint espera `POST`.
- El envio de audio requiere sesion activa de Supabase.
- Los audios originales no se guardan en base de datos; se usan para transcribir y responder.

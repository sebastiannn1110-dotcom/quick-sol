# AI Voice Assistant Improvement Report

## Que estaba mal

- La respuesta de texto y la respuesta para voz usaban practicamente el mismo contenido.
- ElevenLabs podia recibir markdown, tablas, URLs largas o IDs internos y leerlos de forma poco natural.
- El flujo de voz no exponia tiempos separados de transcripcion, busqueda de datos, LLM y TTS.
- Los logs de voz existian, pero no seguian una nomenclatura unica para diagnostico.
- La deteccion de idioma estaba duplicada entre texto y voz.
- El usuario no veia tiempos de procesamiento al final de una interaccion.

## Que se mejoro

- Se agrego `lib/ai/response-normalizer.ts` con dos modos:
  - `normalizeTextResponse`: conserva formato util para pantalla.
  - `normalizeSpeechResponse`: elimina markdown pesado, tablas, URLs largas, IDs internos y simbolos que TTS puede leer mal.
- Se agrego `lib/ai/language-detection.ts` para detectar y normalizar `es`, `en` y `zh`.
- `answerAssistantQuestion` ahora recibe `channel: "text" | "voice"`.
- El canal texto responde solo texto y no llama ElevenLabs.
- El canal voz genera `answerText` para pantalla y `speechText` limpio para ElevenLabs.
- El endpoint `/api/ai/voice/ask` devuelve tiempos:
  - `transcriptionMs`
  - `dataLookupMs`
  - `llmMs`
  - `ttsMs`
  - `totalMs`
- Si ElevenLabs falla, el endpoint devuelve texto y un `audioError` amigable.
- La UI muestra estados progresivos y tiempo total de procesamiento.
- El widget tiene boton de nueva pregunta.

## Texto vs voz

### Entrada por texto

Endpoint principal:

```txt
POST /api/ai/assistant
```

Reglas:

- Responde solo texto.
- No llama ElevenLabs.
- Usa formato limpio para pantalla.
- Mantiene permisos del usuario.
- Devuelve `timings`.

### Entrada por voz

Endpoint principal:

```txt
POST /api/ai/voice/ask
```

Reglas:

- Transcribe audio.
- Detecta idioma.
- Consulta datos controlados.
- Genera respuesta textual.
- Normaliza respuesta para TTS.
- Intenta generar voz con ElevenLabs.
- Si falla TTS, devuelve texto sin romper la UI.

Respuesta esperada:

```json
{
  "transcript": "Busca el ultimo Excel",
  "answerText": "Respuesta para pantalla",
  "speechText": "Respuesta limpia para voz",
  "detectedLanguage": "es",
  "audioBase64": "...",
  "audioMimeType": "audio/mpeg",
  "audioError": null,
  "timings": {
    "transcriptionMs": 800,
    "dataLookupMs": 120,
    "llmMs": 1500,
    "ttsMs": 900,
    "totalMs": 3400
  }
}
```

## Multilenguaje

Idiomas soportados:

- Espanol: `es`
- Ingles: `en`
- Chino simplificado: `zh`

La deteccion usa texto del usuario, idioma sugerido por transcripcion y configuracion de UI. Si no hay voz configurada para un idioma, ElevenLabs usa fallback de `lib/voice/elevenlabs.ts` y registra el error si falla.

Variables relacionadas:

```env
OPEN_IA=...
OPENAI_API_KEY=...
OPENAI_MODEL=...
OPENAI_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe
ELEVENLABS_API_KEY=...
ELEVENLABS_MODEL_ID=eleven_multilingual_v2
ELEVENLABS_VOICE_ES=...
ELEVENLABS_VOICE_EN=...
ELEVENLABS_VOICE_ZH=...
VOICE_DEFAULT_LANGUAGE=es
VOICE_MAX_AUDIO_MB=15
```

## Conexion a Supabase

El asistente no ejecuta SQL libre generado por el modelo. El servidor decide una herramienta controlada en:

```txt
lib/ai/ai-query-router.ts
lib/ai/database-tools.ts
lib/ai/ai-permissions.ts
```

El resultado se estructura con:

```ts
type AiToolResult = {
  ok: boolean;
  tool: string;
  scope: "own" | "team" | "company";
  total?: number;
  rows?: unknown[];
  summary?: string;
  warning?: string;
  error?: string;
};
```

Permisos:

- Admin puede consultar alcance company.
- Employee queda forzado a sus propios datos.
- Manager queda en el alcance definido por la politica actual.
- Si no hay permiso, el servidor bloquea antes del LLM.

## Como probar

### Espanol

```txt
Muestrame el ultimo Excel subido.
Busca el MPN ABC123.
Que registros tienen GP bajo?
```

### Ingles

```txt
Show me the latest uploaded Excel.
Find supplier price for MPN ABC123.
Which records have low GP?
```

### Chino simplificado

```txt
帮我查找最新上传的 Excel。
查找 MPN ABC123。
哪些记录的 GP 比较低？
```

### Consulta exacta a Supabase

1. Subir o confirmar registros reales en `business_records`.
2. Preguntar por un MPN existente.
3. Revisar que el log muestre la herramienta `getRecordsByMpn` o `getMpnPriceComparison`.
4. Confirmar que employee solo ve sus registros.
5. Confirmar que admin puede ver alcance global.

## Logs a revisar

```txt
ai_data_lookup_started
ai_data_lookup_done
ai_llm_started
ai_llm_done
ai_llm_failed
ai_voice_transcription_started
ai_voice_transcription_done
ai_tts_started
ai_tts_done
ai_tts_failed
ai_voice_total_done
ai_voice_failed
ai_text_started
ai_text_done
ai_text_failed
```

## Pendientes futuros

- Streaming real de texto.
- Streaming o cola para TTS.
- Dashboard de calidad de IA.
- Dataset formal de pruebas con MPN, proveedor, cliente, PO, GP, comision y errores.
- E2E con navegador para microfono en Chrome.
- Ajustar voz exacta de ElevenLabs por marca y pais.

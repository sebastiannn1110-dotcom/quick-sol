# quick-sol

Quiksol Data Intelligence Platform built with Next.js, TypeScript and Supabase.

The UI includes a language toggle for Spanish, English and Simplified Chinese. Translations live in `lib/i18n.ts` and are applied through `components/LanguageProvider.tsx`.

Deployment/debugging notes are documented in [README_DEPLOYMENT_REPORT.md](README_DEPLOYMENT_REPORT.md).

Technical vocabulary is documented in [README_TECHNICAL_GLOSSARY.md](README_TECHNICAL_GLOSSARY.md).

Latest correction report is documented in [CHANGELOG_QUIKSOL_CORRECTIONS.md](CHANGELOG_QUIKSOL_CORRECTIONS.md).

Commercial valuation and full product scope are documented in [README_VALORACION_PRODUCTO.md](README_VALORACION_PRODUCTO.md).

## Enterprise MVP

- [Architecture review](docs/ENTERPRISE_MVP_ARCHITECTURE_REVIEW.md)
- [Security hardening report](docs/SECURITY_HARDENING_REPORT.md)
- [Performance review](docs/PERFORMANCE_REVIEW.md)
- [Implementation and test guide](docs/ENTERPRISE_MVP_IMPLEMENTATION_REPORT.md)

Run `supabase/migrations/20260629000000_enterprise_mvp.sql` after the existing platform, observability and email-alert migrations before enabling password recovery, email center, chat or avatars in production.

## Voice Assistant Environment

Server-side voice features use OpenAI transcription and ElevenLabs TTS. Add these in Render as secret/server environment variables, never as `NEXT_PUBLIC_*`:

```env
OPEN_IA=
OPENAI_MODEL=gpt-5.5
OPENAI_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe
ELEVENLABS_API_KEY=
ELEVENLABS_MODEL_ID=eleven_multilingual_v2
ELEVENLABS_VOICE_ES=tomkxGQGz4b1kE0EM722
ELEVENLABS_VOICE_EN=c6SfcYrb2t09NHXiT80T
ELEVENLABS_VOICE_ZH=bhJUNIXWQQ94l8eI2VUf
VOICE_MAX_AUDIO_MB=15
VOICE_MAX_SECONDS=120
VOICE_DEFAULT_LANGUAGE=auto
ENABLE_VOICE_ASSISTANT=true
```

If ElevenLabs fails or is not configured, the assistant still returns the text answer.

# Quiksol - Render and Supabase Deployment Report

Este documento resume el incidente de despliegue, los errores observados, las soluciones aplicadas y las verificaciones recomendadas. Esta version esta pensada para compartirla con otro asistente o con soporte tecnico sin exponer secretos.

## Estado resumido

- Proyecto: Quiksol Data Intelligence Platform.
- Stack: Next.js 16, React, TypeScript, Supabase, TailwindCSS.
- Hosting: Render.
- URL publica: `https://quick-sol.onrender.com`.
- Supabase project host: `niaqaiiiphjfcysmxeqj.supabase.co`.
- Rama principal: `main`.
- Problema principal: el deploy quedaba sirviendo una version antigua o no configurada porque los builds nuevos fallaban antes de arrancar.

## Errores observados

### 1. Login fallaba con Supabase 401

Errores vistos en navegador:

```txt
POST https://niaqaiiiphjfcysmxeqj.supabase.co/auth/v1/token?grant_type=password 401
No API key found in request
Invalid API key
UNAUTHORIZED_INVALID_API_KEY
```

Sintoma adicional en el endpoint de diagnostico:

```json
{
  "configured": false,
  "supabaseUrl": "https://niaqaiiiphjfcysmxeqj.supabase.co",
  "supabasePublishableKey": ""
}
```

En una fase previa tambien se vio una key placeholder:

```txt
TU_PUBLISHABLE_KEY
```

Causa probable:

- Render tenia la URL de Supabase, pero la public key estaba vacia, mal escrita o con placeholder.
- El bundle del navegador intentaba autenticar con una key invalida o sin header `apikey`.
- Como algunos deploys nuevos fallaron, Render seguia sirviendo una version anterior.

Soluciones aplicadas:

- Se agrego `app/api/auth/public-config/route.ts` para leer la config publica en runtime.
- Se actualizo el login para cargar la config desde `/api/auth/public-config`.
- Se agrego validacion de public key: solo acepta keys que empiezan por `sb_publishable_` o legacy JWT `eyJ`.
- Se agrego fallback entre `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` y `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
- Se evita aceptar placeholders como `TU_PUBLISHABLE_KEY`.

Verificacion esperada:

```txt
https://quick-sol.onrender.com/api/auth/public-config
```

Debe devolver:

```json
{
  "configured": true,
  "supabaseUrl": "https://niaqaiiiphjfcysmxeqj.supabase.co",
  "supabasePublishableKey": "sb_publishable_..."
}
```

## 2. Render fallo por TailwindCSS

Error de build:

```txt
Error: Cannot find module 'tailwindcss'
Import trace:
  ./app/globals.css
  ./app/layout.tsx
```

Causa probable:

- Render ejecutaba `npm install; npm run build`.
- La variable `NODE_ENV=production` estaba definida en Render.
- Con `NODE_ENV=production`, `npm install` omite `devDependencies`.
- `tailwindcss`, `postcss` y `autoprefixer` estaban en `devDependencies`, pero Next los necesita durante `next build`.

Solucion aplicada:

- Se movieron a `dependencies`:
  - `tailwindcss`
  - `postcss`
  - `autoprefixer`

Verificacion local aplicada:

```txt
npm ls tailwindcss postcss autoprefixer --omit=dev --depth=0
npm run build
```

## 3. Render fallo por TypeScript faltante

Error de build:

```txt
It looks like you're trying to use TypeScript but do not have the required package(s) installed.
Please install typescript, @types/react, and @types/node
```

Causa probable:

- Mismo origen que el error de Tailwind.
- `typescript`, `@types/react` y `@types/node` estaban en `devDependencies`.
- Render no los instalaba por `NODE_ENV=production`.
- Next necesita TypeScript y los tipos durante `next build`.

Solucion aplicada:

- Se movieron a `dependencies`:
  - `typescript`
  - `@types/node`
  - `@types/react`
  - `@types/react-dom`

Verificacion local aplicada:

```txt
npm ls typescript @types/node @types/react @types/react-dom --omit=dev --depth=0
npm run build
```

## 4. Render fallo por Vitest durante el typecheck

Error de build:

```txt
./vitest.config.ts:2:30
Type error: Cannot find module 'vitest/config' or its corresponding type declarations.
```

Causa probable:

- `tsconfig.json` incluia todos los archivos `**/*.ts` y `**/*.tsx`.
- Por eso Next typecheckeaba `vitest.config.ts`.
- `vitest` correctamente seguia en `devDependencies`, porque no se necesita para producir ni ejecutar la app.
- Como Render omitia `devDependencies`, `vitest/config` no existia durante el build.

Solucion aplicada:

- Se excluyeron del `tsconfig.json` de produccion:
  - `vitest.config.ts`
  - `**/__tests__/**`
  - `**/*.test.ts`
  - `**/*.test.tsx`
  - `**/*.spec.ts`
  - `**/*.spec.tsx`

Razon tecnica:

- El build de Next debe typecheckear la aplicacion, no el runner de tests.
- Los tests siguen pudiendo ejecutarse con `npm run test` en un entorno con devDependencies.

## Variables requeridas en Render

Estas variables deben existir en Render antes de desplegar:

```env
NEXT_PUBLIC_SUPABASE_URL=https://niaqaiiiphjfcysmxeqj.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_...
SUPABASE_SERVICE_ROLE_KEY=<service_role_real_solo_servidor>
NODE_ENV=production
ENABLE_RATE_LIMITING=true
MAX_UPLOAD_SIZE_MB=25
MAX_EXCEL_ROWS=20000
MAX_EXCEL_SHEETS=30
SUPABASE_INSERT_CHUNK_SIZE=500
```

Notas de seguridad:

- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` es publica y puede llegar al navegador.
- `SUPABASE_SERVICE_ROLE_KEY` es secreta. No debe escribirse en README, GitHub, capturas ni prompts publicos.
- No usar placeholders como `TU_PUBLISHABLE_KEY`.

## Recomendacion para Render

Build command actual observado:

```txt
npm install; npm run build
```

Con los cambios aplicados deberia funcionar. Aun asi, una alternativa mas clara en Render seria:

```txt
npm install --include=dev; npm run build
```

La alternativa instala devDependencies durante build, que es lo normal en muchos proyectos Next.js. Pero si se mantiene `NODE_ENV=production` durante el build, este repo ya mueve las dependencias necesarias a `dependencies` y excluye configs de test.

Start command:

```txt
npm run start
```

## Checklist de verificacion

1. Render debe hacer checkout del ultimo commit de `main`.
2. `npm install; npm run build` debe terminar con `Build successful`.
3. El servicio debe arrancar con `npm run start`.
4. Abrir:

```txt
https://quick-sol.onrender.com/api/auth/public-config
```

5. Confirmar:

```json
"configured": true
```

6. Probar login en:

```txt
https://quick-sol.onrender.com/login
```

7. Si el navegador sigue mostrando JS viejo, hacer hard refresh o probar en incognito.

## Hipotesis principal del incidente

El problema no era un unico bug. Fue una cadena:

1. La public key de Supabase en Render estaba ausente o invalida.
2. Los fixes de config no se veian en produccion porque los builds nuevos fallaban.
3. Los builds fallaban porque `NODE_ENV=production` hacia que `npm install` omitiera dependencias necesarias para compilar.
4. Despues de mover dependencias de build a produccion, el typecheck encontro archivos de test que no debian participar en el build.

## Commits relevantes

- `af4d281` - Endurece la carga de public key de Supabase.
- `36fe33d` - Mueve herramientas CSS de build a dependencias de produccion.
- `5aeb98b` - Mueve dependencias TypeScript necesarias para build a produccion.
- Fix actual - Excluye configuracion/tests de Vitest del typecheck de produccion.

## Datos utiles para otro analisis

- El endpoint `/api/auth/public-config` es el primer diagnostico a revisar.
- Si `configured` es `false`, el login no puede funcionar aunque Supabase tenga usuarios.
- Si Render muestra `Build failed`, la web publica probablemente sigue sirviendo el ultimo deploy exitoso, no el ultimo commit.
- Si Supabase responde `Invalid API key`, revisar primero las env publicas de Render.
- Si Supabase responde `Invalid login credentials`, la key ya funciona y el problema pasa a credenciales/usuario.
- Si `/dashboard` redirige a `/login`, eso es normal sin sesion.
- Si `/dashboard` muestra `Supabase is not configured for protected route`, el servidor no ve una key publica valida.

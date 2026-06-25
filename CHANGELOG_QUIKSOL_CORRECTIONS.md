# Quiksol Corrections Changelog

Fecha: 2026-06-25

## Correcciones Implementadas

- Se corrigio la apertura/descarga del Excel original para admin con signed URLs privadas de Supabase Storage.
- Se agrego `createSupabaseAdminClient()` server-side con fallback controlado:
  - `SUPABASE_SERVICE_ROLE_KEY`
  - `SUPABASE_SECRET_KEY`
- Se reemplazo el error generico `Service role key is not configured` por:
  - `Server storage access is not configured. Please add SUPABASE_SERVICE_ROLE_KEY in Render environment variables.`
- Se registra `service_role_missing` cuando falta acceso server-side a Storage.
- Se agrego auditoria `admin_opened_employee_excel` al abrir Excel original.
- Se mejoro `/admin/uploads` con columnas administrativas y acciones:
  - Archivo
  - Subido por
  - Email empleado
  - Categoria
  - Estado
  - Filas
  - Errores
  - Data quality score
  - Fecha
  - Excel
  - Abrir Excel
  - Descargar Excel
  - Ver registros
  - Ver errores
  - Ver trazabilidad
- Se agrego modal `Import Error Details` con resumen, filtros, severidad, tipo de error, columna y sugerencia de correccion.
- Se mejoro la normalizacion de MPN para variantes como `Part Number`, `PN`, `P/N`, `Manufacturer Part Number`, `Mfr Part Number`, `MFG Part Number`, `Part No`, `Item Number`, `Component`, `Clean MPN` y `MPN Quoted`.
- `Top MPNs` ya no pone `Unspecified` como MPN principal; usa `Missing MPN` separado como advertencia de calidad.
- Se agrego metrica `Records missing MPN`.
- Se agregaron tooltips y modales de graficas con Recharts para cards principales.
- Se agrego selector de tipo de grafica: bar, line, pie, area, donut y table.
- Se agrego export CSV desde el modal de analitica.
- Se mejoro `/admin/users` para crear, editar, renombrar, cambiar email, departamento, region, rol, activar y desactivar empleados.
- La eliminacion de empleados se maneja como soft delete/desactivacion.
- Se protege contra desactivar o degradar el ultimo admin activo.
- Se agrego busqueda global admin en `/admin/search`.
- Se mejoro la IA para buscar en Supabase por rol sin enviar archivos Excel completos ni `raw_data` masivo a OpenAI.
- Se agrego endpoint compatible `/api/ai/assistant`.
- Se genero Excel limpio de prueba con 1,000 filas en `test-files/quiksol_perfect_upload_clean.xlsx`.

## Archivos Principales Modificados

- `lib/security/env.ts`
- `lib/supabase/server.ts`
- `lib/logger/logger.ts`
- `app/api/admin/uploads/[uploadId]/download/route.ts`
- `app/api/admin/uploads/route.ts`
- `app/api/admin/users/route.ts`
- `app/api/admin/errors/route.ts`
- `app/api/admin/records/route.ts`
- `app/api/admin/search/route.ts`
- `app/api/assistant/route.ts`
- `app/api/ai/assistant/route.ts`
- `app/admin/uploads/page.tsx`
- `app/admin/users/page.tsx`
- `app/admin/search/page.tsx`
- `components/AdminUploadsTable.tsx`
- `components/AnalyticsCards.tsx`
- `components/charts/AnalyticsModal.tsx`
- `components/charts/ChartTypeSelector.tsx`
- `components/charts/MetricCard.tsx`
- `lib/excel/normalizer.ts`
- `lib/platform/analytics.ts`
- `scripts/generate-perfect-quiksol-excel.mjs`
- `test-files/README.md`
- `test-files/quiksol_perfect_upload_clean.xlsx`

## Render Variables Requeridas

Configurar en Render:

```env
NEXT_PUBLIC_SUPABASE_URL=https://TU_PROYECTO.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=TU_PUBLISHABLE_KEY
NEXT_PUBLIC_SUPABASE_ANON_KEY=TU_ANON_KEY_SI_APLICA
SUPABASE_SERVICE_ROLE_KEY=TU_SERVICE_ROLE_KEY
OPEN_IA=TU_OPENAI_KEY
OPENAI_MODEL=gpt-5.5
NODE_ENV=production
```

Notas:

- No usar `NEXT_PUBLIC_` para `SUPABASE_SERVICE_ROLE_KEY`.
- No poner `OPEN_IA` en frontend.
- Si tu entorno ya usa `SUPABASE_SECRET_KEY`, el backend lo acepta como fallback, pero el nombre recomendado para Render es `SUPABASE_SERVICE_ROLE_KEY`.

## Como Abrir Excel Original

1. Entrar como admin.
2. Ir a `/admin/uploads`.
3. Buscar la carga del empleado.
4. Clic en `Abrir Excel` o `Download Excel`.
5. El backend crea una signed URL privada de 120 segundos sobre el bucket `excel-uploads`.

Si falta la variable server-side, solo falla esta accion y muestra mensaje claro; no rompe toda la app.

## Como Gestionar Empleados

1. Entrar como admin.
2. Ir a `/admin/users`.
3. Usar `Create Employee` para crear usuario Auth y profile.
4. Usar `Edit` para renombrar, cambiar email, departamento, region o rol.
5. Usar `Deactivate` para desactivar sin borrar historico.
6. Usar `View Uploads`, `View Records` o `View Analytics` para revisar actividad.

Ejemplo: para renombrar `Quiksol Employee 01` a `Luis`, abrir `Edit`, cambiar `Full name` a `Luis` y guardar. Los uploads anteriores siguen ligados al mismo UUID.

## Como Usar Graficas Emergentes

1. Abrir dashboard o admin analytics.
2. En una card, pulsar `View details`.
3. Cambiar tipo de grafica: bar, line, pie, area, donut o table.
4. Exportar CSV si se necesita revisar los datos agregados.

## Como Usar IA Para Buscar Datos

El asistente flotante consulta Supabase, no lee Excels completos.

Ejemplos:

- `Busca el MPN TPS585995PWR`
- `Que subio Luis esta semana`
- `Muestrame errores del ultimo Excel`
- `Cual supplier genera mas GP`

Reglas:

- Employee: solo sus records/uploads/errores.
- Admin: busqueda global.
- Maximo contexto enviado a OpenAI:
  - 20 records relevantes
  - 10 uploads recientes
  - 10 errores relevantes
  - agregaciones server-side

## Como Probar El Excel Perfecto

Archivo:

`test-files/quiksol_perfect_upload_clean.xlsx`

O regenerar:

```bash
node scripts/generate-perfect-quiksol-excel.mjs
```

Subir como:

- `Sales Margin`
- o `Auto Detect`

Resultados esperados:

- `1000` records
- errores cercanos a `0`
- categoria esperada `Sales Margin`
- metricas pobladas: `QTY`, `Total Price`, `GP`, `Commission`, `Potential_Amount_USD`

## Riesgos Pendientes

- Las agregaciones avanzadas por cada metrica todavia usan los agregados existentes de analytics; si la base crece mucho, conviene crear RPC SQL/materialized views para cada modal.
- La busqueda global muestra resultados JSON compactos; puede mejorarse con tarjetas por tipo.
- La IA depende de `OPEN_IA` y `OPENAI_MODEL`; si el modelo configurado no existe en la cuenta, respondera con error 502 controlado.
- La accion de cambiar email requiere service role server-side.
- `npm audit` reporta vulnerabilidades heredadas de dependencias; revisar antes de un entorno productivo sensible.

## Pasos Para Deploy

1. Confirmar variables Render.
2. Push a `main`.
3. Render ejecuta:
   - `npm install`
   - `npm run build`
   - `npm run start`
4. Probar:
   - login admin
   - `/api/auth/public-config`
   - `/admin/uploads`
   - abrir Excel
   - `/admin/users`
   - renombrar empleado
   - asistente IA
   - subir `test-files/quiksol_perfect_upload_clean.xlsx`

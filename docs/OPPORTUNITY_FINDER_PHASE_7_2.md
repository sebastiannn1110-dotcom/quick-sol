# Fase 7.2 — Two-File Opportunity Finder

Fecha de implementación y validación: 2026-07-27

## Estado de entrega

La ruta principal es `/opportunity-finder` y queda disponible para `employee`, `manager` y `admin`. El módulo compara exactamente dos archivos dentro de un job privado y aislado. No consulta ni escribe `business_records`, no usa un LLM para clasificar o hacer matching y no expone precios, costos, GP, margen, comisión ni `raw_data`.

No se hizo commit, push ni se ejecutó ninguna migración. El SQL se entrega para revisión y aplicación manual en:

`supabase/migrations/20260727090000_opportunity_finder.sql`

## A. Auditoría del MPN Comparator anterior

El flujo anterior de `/mpn-comparator`:

- consulta el universo global de `business_records`, no dos archivos aislados;
- limita la consulta de comparación y sugerencias, por lo que puede ocultar resultados;
- mezcla registros de cargas históricas;
- incluye conceptos de precio, costo y rentabilidad que no pertenecen al nuevo buscador;
- registra el MPN buscado en algunos eventos;
- trabaja como consulta interactiva contra datos importados, no como job de archivos grandes.

Se mantuvo la ruta por compatibilidad, pero se retiró del menú principal del vendedor.

## B. Auditoría de Opportunities anterior

El flujo de `/opportunities` y `/admin/opportunities`:

- agrega datos globales de varias cargas;
- recorre hasta 30 uploads y hasta 5.000 filas por upload;
- usa conceptos de confianza que no aplican a la Fase 7.2;
- puede truncar datos y mezclar archivos, usuarios o periodos;
- no administra una reserva única de stock entre varias necesidades;
- depende de `business_records`.

Las rutas siguen disponibles para compatibilidad. No se modificaron ni redirigieron.

## C. Qué se reutilizó

- `normalizePartNumberForMatch` como llave exacta estable.
- Patrones del worker existente: claim con `FOR UPDATE SKIP LOCKED`, heartbeat, reintentos, cancelación y escritura por lotes.
- ExcelJS en modo streaming y `csv-parse`.
- Autenticación de `getAuthContext`, Sidebar, `EmployeeGuard`, `LanguageProvider` y componentes visuales base.
- Patrones de Supabase para bucket privado, URL firmada y service role.

`normalizedMpnDisplay` no se reutilizó para el valor visible porque fuerza mayúsculas. La nueva presentación conserva letras, ceros y guiones del archivo.

## D. Qué quedó obsoleto para este flujo

- consultar la base global para comparar MPN;
- topes arbitrarios de uploads o filas;
- confidence levels;
- matching fuzzy como oportunidad automática;
- procesar archivos grandes en una petición HTTP;
- insertar los archivos temporales en `business_records`;
- mostrar campos comerciales sensibles.

## E–G. Ruta y flujo de dos archivos

El módulo implementa cuatro pasos:

1. Dos dropzones independientes y exactamente dos archivos.
2. Resultado del perfilado y confirmación/corrección de roles.
3. Progreso persistido del worker, cancelación y reintento.
4. Resumen, filtros, cards, posibles coincidencias y exportación.

El POST inicial sólo crea el job, dos registros de archivo y URLs firmadas. El navegador sube directamente al bucket privado y confirma la carga. El perfilado, parsing y matching ocurren en el worker.

Formatos aceptados:

- `.xlsx`;
- `.csv`.

Se rechazan `.xls`, `.xlsm`, `.xlsb`, extensiones ejecutables, firmas incompatibles, paquetes con `vbaProject.bin` y archivos mayores al límite. El límite predeterminado es 64 MB y 250.000 filas por archivo.

## H. Clasificador determinístico

El clasificador usa:

- nombres y cantidad de hojas;
- bloques de encabezados reales;
- aliases de columnas;
- estructura repetida de tablas;
- evidencia explícita de exceso.

El nombre del archivo sólo funciona como contexto explícito o desempate; nunca es la única señal.

Resultado de perfilado local en modo lectura:

| Archivo | Tipo detectado | Hojas útiles | Filas inspeccionadas | Puntaje | Tiempo |
| --- | --- | ---: | ---: | ---: | ---: |
| `07142026.xlsx` | `supplier_offer` | 7 | 385 | 21 | 252 ms |
| `Actual Spend -- Cube Wk 16 Apr-2026 (1).xlsx` | `received_history` | 2 | 71.371 | 27 | 4.188 ms |
| `AMERICAS Actual Spend -- Cube Wk 29 July-2026.xlsx` | `received_history` | 2 | 29.189 | 27 | 1.717 ms |
| `A_RAgingSummary-USD-US team-7.13.xlsx` | `financial` | 1 | 40 | 24 | 20 ms |
| `Excess Stock List.xlsx` | `excess` | 1 | 103 | 24 | 20 ms |
| `Planned 391.xlsx` | `demand` | 1 | 152.382 | 30 | 22.073 ms |
| `Sales Report-US Team-7.13.xlsx` | `sales_history` | 1 | 15 | 24 | 46 ms |
| `STOCK ON HAND (ic).xlsx` | `stock` | 1 | 812 | 24 | 49 ms |

La verificación confirmó:

- `Planned PO 391` con encabezado en fila 1;
- dos bloques en `Mobile PC`;
- encabezado desplazado en `Sam tablets`;
- orden distinto en `Kingston SSD`;
- una hoja vacía ignorada;
- dos tablas independientes en Sales Report;
- `ITEM#` excluido como MPN automático de Sales Report;
- A/R bloqueado como financiero.

El PDF mencionado no estaba presente en el directorio entregado. No se inventó información del PDF; los encabezados se verificaron directamente en los Excel.

## I. Matriz de compatibilidad

Permitidas:

- `demand + stock`;
- `demand + excess`;
- `demand + supplier_offer`;
- `demand + received_history`;
- `demand + sales_history`.

Las dos combinaciones históricas sólo producen `historical_signal`; nunca disponibilidad.

Bloqueadas:

- dos fuentes de oferta;
- dos historiales;
- cualquier combinación con `financial`;
- cualquier combinación sin una fuente de demanda.

Un archivo `unknown` exige selección manual. `financial` no puede convertirse manualmente en una oportunidad.

## J. Normalización del MPN

Cada fila conserva:

- `rawMpn`;
- `displayMpn`;
- `normalizedMpn`;
- `reviewKey`, sólo para posibles coincidencias.

Reglas:

- siempre string;
- conserva ceros iniciales, letras y guiones;
- elimina espacios exteriores;
- elimina separadores de miles sólo cuando el texto completo es un número agrupado;
- la llave exacta usa mayúsculas/minúsculas normalizadas;
- nunca convierte el MPN a `Number`;
- no elimina guiones para oportunidades automáticas.

Las variantes sin símbolos se guardan exclusivamente en `opportunity_finder_possible_matches`.

## K. Asignación y no doble conteo

1. La oferta se agrupa por `normalizedMpn`.
2. Sólo cantidades positivas y válidas forman disponibilidad.
3. La demanda se agrupa por MPN, contexto, fecha requerida y unidad.
4. Se ordena por fecha requerida y después por orden original.
5. La disponibilidad restante se reduce después de cada asignación.
6. Una unidad nunca se reutiliza en otra card.
7. Conflictos de unidad o fabricante generan revisión y no una venta confirmada.
8. Si falta unidad, se compara con una advertencia visible.

El worker de producción consulta la demanda ordenada por índice, conserva en memoria un MPN a la vez y persiste resultados por lotes.

## L–M. Resultados y cards

Tipos:

- `full_sale`;
- `partial_sale`;
- `sourcing_needed`;
- `excess_resale`;
- `supplier_offer_match`;
- `supply_without_demand`;
- `historical_signal`;
- `review_required`.

Cada card usa campos seguros: MPN, fabricante, contextos, cantidades, cobertura, fecha, unidad, archivos/hojas, cantidad de filas agrupadas, `reasonCode`, `actionCode` y advertencias.

No se seleccionan, guardan, muestran o exportan precio, costo, Unit Cost, Price Book, GP, GP rate, margen, comisión ni `raw_data`.

## N. Responsive

El flujo usa cards y grids; no hay tablas anchas. Se ajustaron Sidebar y Navbar para que su contenido no fuerce el ancho global.

Validación automatizada real con Chrome headless:

| Viewport | Overflow horizontal | Targets menores de 44 px |
| --- | --- | --- |
| 360 × 800 | No | 0 |
| 390 × 844 | No | 0 |
| 430 × 900 | No | 0 |
| 768 × 1.024 | No | 0 |
| 1.024 × 900 | No | 0 |
| 1.366 × 900 | No | 0 |
| 1.440 × 1.000 | No | 0 |
| 1.920 × 1.080 | No | 0 |

Evidencia y reporte local:

`outputs/opportunity-finder-responsive/`

Comando reproducible:

```powershell
npm run verify:opportunity-responsive -- http://localhost:3107/opportunity-finder outputs/opportunity-finder-responsive
```

## O. i18n

El módulo tiene copia completa en:

- español;
- inglés;
- chino simplificado.

Incluye navegación, pasos, dropzones, clasificación, roles, compatibilidad, estados, etapas, cards, resumen, filtros, warnings, errores, acciones, estados vacíos y exportación. Backend y DB almacenan códigos; la interfaz los traduce.

## P. Worker

Worker dedicado:

```powershell
npm run worker:opportunity-finder
```

Ejecución de un solo job:

```powershell
npm run worker:opportunity-finder:once
```

El worker:

- reclama un job de forma atómica;
- descarga los dos archivos privados a un directorio temporal;
- perfila y pausa en `awaiting_roles`;
- reanuda después de la confirmación;
- parsea por lotes;
- escribe sólo columnas canónicas;
- hace matching exacto e incremental;
- persiste progreso real;
- atiende cancelación;
- recupera locks vencidos;
- aplica reintentos idempotentes;
- elimina resultados/filas parciales antes del reintento;
- limpia temporales;
- registra sólo IDs, etapa, duración, conteos y códigos de error.

No se modificó el worker de imports existente.

## Q–R. Modelo de datos y SQL

Tablas dedicadas:

- `opportunity_finder_jobs`;
- `opportunity_finder_files`;
- `opportunity_finder_rows`;
- `opportunity_finder_results`;
- `opportunity_finder_possible_matches`.

También se crea:

- bucket privado `opportunity-finder`;
- índices por owner/job/estado/rol/MPN/fecha/tipo;
- RPC `claim_opportunity_finder_job`;
- constraint de idempotencia por usuario.

El SQL exacto está en `supabase/migrations/20260727090000_opportunity_finder.sql`. No fue ejecutado.

## S. Seguridad y RLS

- Todas las APIs validan sesión.
- Toda lectura de job incluye `created_by = userId`.
- RLS limita jobs, files, results y possible matches al propietario.
- Las filas canónicas no tienen policy para usuarios autenticados; sólo service role.
- Las rutas limpian y validan UUID.
- El path del objeto comienza con el UID.
- El bucket es privado y sólo se entregan URLs firmadas temporales.
- MIME, extensión, ZIP, contenido macro y tamaño se validan.
- No se guardan base64 ni URLs firmadas.
- No se usa `select("*")`.
- Los logs del worker no incluyen nombres de archivos, MPN, clientes, proveedores o contenido de filas.

No existe función de compartir en este MVP.

## T. Retención

Decisión implementada:

- archivos: 72 horas;
- jobs, filas y resultados: 14 días;
- eliminación manual anticipada disponible cuando el job no está activo.

Limpieza programable:

```powershell
npm run cleanup:opportunity-finder
```

Primero elimina objetos vencidos del bucket y después jobs vencidos, con cascada a staging y resultados.

## U. Exportación

Formatos:

- CSV UTF-8 con BOM;
- XLSX.

El export respeta el idioma seleccionado y puede generar todo el job o una card. Las columnas son explícitas y seguras. El nombre es:

`opportunity-finder-YYYY-MM-DD.xlsx`

## V–W. Tests y resultado de comandos

Pruebas automatizadas nuevas:

- normalización;
- clasificación;
- compatibilidad;
- parser sintético multibloque;
- matching y asignación;
- seguridad e integración;
- acceso y compatibilidad de rutas;
- i18n y responsive por estructura.

Resultados:

| Comando | Resultado |
| --- | --- |
| `npx vitest run lib/opportunity-finder/__tests__` | 7 archivos, 48 tests, todos pasan |
| `npm run test -- --run` | 62 archivos, 255 tests, todos pasan |
| `npm run typecheck` | pasa |
| `npm run lint` | pasa |
| `npm run build` | pasa; 42 páginas generadas y `/opportunity-finder` incluida |

OneDrive mantenía un lock sobre `.next/build`. La validación de producción se ejecutó con:

```powershell
$env:NEXT_BUILD_DIR='.next-stale-opportunity-verify'
npm run build
```

Después se restauraron los cambios automáticos de Next en `next-env.d.ts` y `tsconfig.json`.

## X. Rendimiento con archivos reales

Par probado:

- `Planned 391.xlsx`;
- `STOCK ON HAND (ic).xlsx`.

Medición local repetida desde OneDrive, con perfilado y parser reales:

| Métrica | Resultado |
| --- | ---: |
| Filas de workbook inspeccionadas | 153.194 |
| Filas canónicas | 145.188 |
| Perfilado de ambos archivos | 42,926 s |
| Parsing de ambos archivos | 50,606 s |
| Matching puro | 4,308 s |
| Total del harness | 98,858 s |
| Throughput de parsing | 3.027 filas/s |
| Pico RSS del harness | 440 MB |
| Staging canónico aproximado como JSON | 81,11 MB |
| Resultados aproximados como JSON | 101,94 MB |
| Resultados generados | 144.923 |

El harness local conserva todas las filas y resultados para probar la función pura, por eso sus 440 MB son un límite conservador y no una medición del worker desplegado. El worker implementado pagina demanda ordenada, mantiene sólo un MPN en memoria y escribe resultados inmediatamente por lotes.

No se midieron upload de red ni consulta Supabase porque la restricción prohibía ejecutar la migración y no existían las tablas dedicadas en producción. La primera página está limitada y respaldada por índices, pero el objetivo `< 2 s` debe verificarse en staging después de aplicar la migración. No se promete un tiempo total fijo.

Comandos reproducibles:

```powershell
npx tsx scripts/verify-opportunity-files.ts "C:\ruta\info hash"
npx tsx scripts/benchmark-opportunity-finder.ts "C:\ruta\Planned 391.xlsx" "C:\ruta\STOCK ON HAND (ic).xlsx"
```

Los scripts sólo imprimen estructura, tiempos y conteos; no imprimen filas ni MPN.

## Y. Archivos modificados

Núcleo:

- `lib/opportunity-finder/types.ts`
- `lib/opportunity-finder/normalization.ts`
- `lib/opportunity-finder/classifier.ts`
- `lib/opportunity-finder/compatibility.ts`
- `lib/opportunity-finder/parser.ts`
- `lib/opportunity-finder/matcher.ts`
- `lib/opportunity-finder/api.ts`
- `lib/opportunity-finder/validation.ts`
- `lib/opportunity-finder/worker.ts`
- `lib/opportunity-finder/i18n.ts`

Interfaz:

- `app/opportunity-finder/page.tsx`
- `components/opportunity-finder/OpportunityFinder.tsx`
- `components/opportunity-finder/OpportunityCard.tsx`
- `components/Sidebar.tsx`
- `components/Navbar.tsx`
- `components/LanguageToggle.tsx`
- `components/LogoutButton.tsx`
- `components/search/GlobalExecutiveSearch.tsx`
- `lib/i18n.ts`
- `proxy.ts`

APIs:

- `app/api/opportunity-finder/jobs/route.ts`
- `app/api/opportunity-finder/jobs/[id]/route.ts`
- `app/api/opportunity-finder/jobs/[id]/profile/route.ts`
- `app/api/opportunity-finder/jobs/[id]/confirm/route.ts`
- `app/api/opportunity-finder/jobs/[id]/cancel/route.ts`
- `app/api/opportunity-finder/jobs/[id]/retry/route.ts`
- `app/api/opportunity-finder/jobs/[id]/export/route.ts`

Operación y QA:

- `scripts/opportunity-finder-worker.ts`
- `scripts/cleanup-opportunity-finder.ts`
- `scripts/profile-opportunity-files.mjs`
- `scripts/verify-opportunity-files.ts`
- `scripts/benchmark-opportunity-finder.ts`
- `scripts/verify-opportunity-responsive.mjs`
- `supabase/migrations/20260727090000_opportunity_finder.sql`
- tests en `lib/opportunity-finder/__tests__/`
- `package.json`
- `lib/logger/types.ts`

No se tocó `cleanup duplicates`.

## Z. Pasos exactos para producción

1. Crear una rama de QA y revisar el diff. No desplegar todavía.
2. Ejecutar en CI:

   ```powershell
   npm ci
   npm run typecheck
   npm run lint
   npm run test
   npm run build
   ```

3. Revisar el SQL exacto, backup y funciones requeridas (`profiles`, `is_active_profile`, `set_updated_at`).
4. Aplicar `20260727090000_opportunity_finder.sql` primero en staging.
5. Confirmar que el bucket `opportunity-finder` es privado y tiene límite de 64 MB.
6. Configurar, si se desean valores distintos:

   ```text
   OPPORTUNITY_FINDER_MAX_FILE_SIZE_MB=64
   OPPORTUNITY_FINDER_MAX_ROWS_PER_FILE=250000
   OPPORTUNITY_WORKER_POLL_INTERVAL_MS=5000
   OPPORTUNITY_FINDER_TEMP_DIR=<directorio temporal privado>
   ```

7. Desplegar la app web.
8. Desplegar `npm run worker:opportunity-finder` como proceso separado y permanente con service role.
9. Programar `npm run cleanup:opportunity-finder` al menos cada hora.
10. Probar acceso con cuentas `employee`, `manager` y `admin`; confirmar redirect a login sin sesión.
11. Ejecutar en staging los seis casos manuales:

    - Planned + Stock: asignación única y ventas completas/parciales/sourcing.
    - Planned + Excess: sólo exactos y reventa.
    - Planned + 07142026: múltiples hojas/bloques y sin Price.
    - Sales + A/R: combinación financiera bloqueada.
    - Spend abril + Spend julio: dos historiales bloqueados y no sumados.
    - Stock + Excess: dos fuentes de oferta bloqueadas.

12. Verificar por Network que el POST inicial responde con `jobId` sin esperar el parser.
13. Medir en staging upload, pico RSS real del worker, tamaño de tablas y primera página después de completar; exigir `< 2 s` antes de producción.
14. Intentar acceder a job, file y result de otro usuario; debe responder 404/denegado por backend y RLS.
15. Descargar CSV/XLSX en ES, EN y ZH y verificar que no existan campos prohibidos.
16. Cancelar, reintentar y eliminar un job; confirmar que no quedan duplicados ni objetos privados.
17. Confirmar que `/mpn-comparator`, `/opportunities`, upload existente, stock-needs, clientes y login siguen funcionando.
18. Después de QA, desplegar a producción. Mantener las rutas antiguas durante la transición; los redirects quedan para una fase posterior.

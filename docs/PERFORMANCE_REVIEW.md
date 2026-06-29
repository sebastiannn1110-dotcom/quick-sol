# Revisión de rendimiento

## Objetivo

Reducir transferencia, consultas repetidas y tiempo de interacción sin cambiar los resultados visibles del MVP.

## Hallazgos

### Analítica

Antes, `/api/analytics` y `/api/admin/analytics` solicitaban `business_records.*`. Cada fila incluía `raw_data`, `normalized_data` y `searchable_text`, campos grandes que no se usan para construir la mayoría de métricas.

Cambio:

- `lib/platform/query-columns.ts` contiene selecciones explícitas.
- Se excluyen los JSON/textos grandes.
- Se mantienen los campos escalares requeridos por `buildPlatformAnalytics`.

Impacto esperado: reducción importante del payload entre Supabase y Render, especialmente en archivos anchos.

### Directorio de empleados

Antes, el listado admin realizaba:

- una consulta para perfiles;
- dos conteos y una consulta de última carga por cada perfil.

Para 100 usuarios esto podía producir aproximadamente 301 consultas.

Cambio:

- RPC `get_employee_activity_directory()` calcula perfiles, conteos y última carga en una consulta SQL.
- El endpoint conserva fallback al comportamiento anterior si la migración todavía no está aplicada.

### Gráficas

Antes, Recharts se importaba con el dashboard inicial.

Cambio:

- `AnalyticsModal` se carga con `next/dynamic` cuando se necesita.
- La vista inicial usa barras CSS livianas.

### Chat

- Mensajes paginados a 50 por defecto y máximo 100.
- Conversaciones limitadas a 100.
- Realtime para inserciones y polling de 12 segundos como respaldo.
- Índice `(conversation_id, created_at desc)`.
- URLs de adjuntos firmadas por 60 segundos.

### Búsquedas e índices

La migración agrega índices para:

- propietario y fecha de cargas;
- categoría y fecha;
- lote y fecha de registros;
- MPN + GP;
- proveedor + MPN;
- cliente + GP;
- tipo de error + fecha;
- email normalizado;
- conversación + fecha;
- remitente + fecha.

## Límites actuales

- Analítica employee: máximo 5.000 registros y 1.000 cargas.
- Analítica admin: máximo 10.000 registros y 5.000 cargas.
- Estos límites evitan bloquear Render, pero pueden subcontar un dataset mayor.

Antes de superar esos límites se recomienda crear una vista/RPC agregada por categoría, empleado, cliente, proveedor y fecha, o una vista materializada refrescada después de cada carga.

## Cómo medir

1. Abrir DevTools > Network y registrar TTFB y tamaño de `/api/analytics`.
2. Revisar `/admin/performance` para `analytics_query` y consultas lentas.
3. Medir p50, p95 y p99 en al menos 30 solicitudes por ruta.
4. En Supabase habilitar `pg_stat_statements` y revisar tiempo total, media y filas.
5. Medir con datasets de 1k, 10k y 100k registros.

Metas MVP sugeridas en producción caliente:

- página operativa visible: menos de 2,5 s p95;
- API simple: menos de 500 ms p95;
- analítica: menos de 2 s p95;
- envío de chat: menos de 700 ms p95;
- confirmación inicial de upload: menos de 1 s, sin contar procesamiento completo.

## Trabajo futuro

- Agregados SQL/materializados.
- Cola para parsing y correo masivo.
- Caché por usuario/rol con invalidación después de upload.
- Virtualización para tablas mayores de 500 filas.
- Paginación por cursor en historial administrativo y logs.

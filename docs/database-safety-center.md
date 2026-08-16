# Database Safety Center

## Alcance y autorización

`/admindev` usa la sesión real de Supabase Auth. El proxy y cada API comprueban un perfil activo con el rol exacto `super_admin_dev`; `employee`, `manager` y `admin` no heredan acceso. El login paralelo antiguo queda deshabilitado. La provisión está preparada en `scripts/provision-admin-users.ts --super-admin-dev`, pero requiere `QUIKSOL_SUPERADMIN_BOOTSTRAP_PASSWORD`; sin el segundo flag `--apply` solo informa la preparación y no modifica usuarios.

Las APIs mutativas exigen mismo `Origin`, aplican rate limit persistente y responden con `Cache-Control: no-store`. La reautenticación se hace con Supabase Auth. La contraseña, el access token y la conexión PostgreSQL nunca se guardan ni se registran.

## Backup

El servidor ejecuta `pg_dump --format=custom --no-owner --no-privileges --schema=public` sin shell. La conexión llega únicamente por la variable privada `QUIKSOL_BACKUP_DATABASE_URL`/`PGDATABASE`. El resultado es:

`backup-respaldo-base-datos-general-YYYY-MM-DD-HHMMSS.dump`

El archivo se crea en un subdirectorio aleatorio del directorio temporal con permisos de directorio `0700` y archivo `0600`. Se exige tamaño positivo, se calcula SHA-256 y se valida con `pg_restore --list`. El manifest contiene versión, fecha, proyecto, versiones de esquema/migración/datos, formato, hash, tamaño y número de tablas; no contiene credenciales. La descarga usa POST con verificación de origen. Cuando el navegador soporta File System Access API, el stream va directamente al archivo elegido. El fallback con Blob está limitado a 100 MiB y exige un `Content-Length` válido; para archivos mayores se bloquea la descarga en memoria y se indica usar un navegador compatible con escritura directa a disco. El temporal se elimina al completar o fallar el stream. No se crea bucket, blob/base64 ni copia persistente.

Si `pg_dump` o `pg_restore` no están disponibles en el runtime, la API responde `BACKUP_UNAVAILABLE` y mantiene `DELETE LOCKED`; no intenta continuar con un respaldo sin verificar.

El dump cubre únicamente `public`, incluyendo estructura, datos, secuencias, relaciones y funciones de ese esquema. No contiene los blobs físicos de Supabase Storage y no representa un backup independiente de Supabase Auth. `auth`, `storage.objects` y `storage.buckets` se preservan durante la eliminación, pero sus respaldos requieren protocolos separados.

Render debe disponer de clientes PostgreSQL compatibles con la versión del servidor (`pg_dump` y `pg_restore`). Verificación/restauración manual segura contra un Supabase local o proyecto temporal compatible, nunca producción:

```text
pg_restore --list backup-respaldo-base-datos-general-....dump
pg_restore --clean --if-exists --no-owner --no-privileges --dbname "$TEMPORARY_SUPABASE_DATABASE_URL" backup-respaldo-base-datos-general-....dump
```

El destino temporal debe tener los schemas administrados por Supabase (`auth`, `storage`, etc.) de una versión compatible antes de restaurar `public`; no se debe usar este comando contra producción.

## Protocolo destructivo

1. Se genera el dump sobre un snapshot consistente.
2. SHA-256 y `pg_restore --list` deben pasar.
3. La DB registra solo el manifest y exige que su `data_version` siga vigente.
4. El stream vuelve a verificar tamaño, SHA y `pg_restore --list` antes de descargar.
5. La DB marca la descarga solo cuando el stream termina; el operador además confirma que lo guardó.
6. Se exige la frase exacta `ELIMINAR INFORMACION QUIKSOL`.
7. Supabase Auth reautentica al mismo usuario. AAL2 puede hacerse obligatorio mediante configuración privada.
8. El servidor genera 256 bits aleatorios y persiste únicamente el hash, ligado a usuario, sesión, backup, SHA, versión de datos y acción, con TTL de cinco minutos.
9. La DB impone 30 segundos antes de ejecutar; la UI ofrece cancelar durante todo el countdown.
10. El POST final llama una única función SQL transaccional. Bloquea la operación con `FOR UPDATE`, toma locks de escritura en orden determinista sobre toda la allowlist y vuelve a comprobar el watermark. Así, un escritor previo causa `BACKUP_STALE` y uno nuevo espera hasta el commit. El challenge se acepta una sola vez y un segundo POST ya completado recibe el mismo resultado.
11. Antes de borrar vuelve a comprobar descarga, edad, hash del manifest, `data_version` y versión de migración. Cualquier cambio empresarial u operativo relevante produce `BACKUP_STALE`. Rate limits, códigos de reset, outbox y logs no mueven el watermark para que los propios controles de seguridad no invaliden el backup; aun así se incluyen en el dump y la limpieza.
12. Se ejecuta `DELETE` únicamente sobre la allowlist, de hojas a raíces. No hay `DROP DATABASE`, `DROP SCHEMA`, reset, `TRUNCATE` ni `CASCADE` agregado por esta operación.
13. Un fallo revierte toda la función SQL. Luego se registra un código seguro de fallo; nunca contenido de filas.

La auditoría protegida conserva actor, timestamps, operation ID, hash de IP con secreto privado, manifest/SHA, tablas, conteos antes/después y resultado. No conserva contraseña, token, conexión ni valores empresariales.

## Matriz exacta del esquema

La cantidad es `COUNT(*)` en tiempo de ejecución y se muestra únicamente mediante **Simular eliminación**; la carga normal del panel no recorre tablas grandes. No está hardcodeada y en esta revisión no se consultó producción. La allowlist se derivó de las 21 migraciones locales existentes: 60 tablas públicas antes de esta función, más cuatro tablas protegidas nuevas.

| Tablas | Cantidad | Categoría | Acción | Razón |
|---|---:|---|---|---|
| `admin_email_attachments`, `admin_email_messages` | runtime | BUSINESS DATA | DELETE | Contenido y metadatos de correo empresarial |
| `ai_messages`, `ai_conversations` | runtime | BUSINESS DATA | DELETE | Conversaciones y contenido de IA |
| `chat_attachments`, `chat_messages`, `chat_conversation_members`, `chat_conversations` | runtime | BUSINESS DATA | DELETE | Contenido, adjuntos y membresías de chat |
| `clients`, `client_private_details`, `client_upload_assignments` | runtime | BUSINESS DATA | DELETE | Maestro privado y relaciones de clientes |
| `business_records`, `business_mpn_summaries`, `business_opportunity_entities` | runtime | BUSINESS DATA | DELETE | Registros, agregados y entidades empresariales |
| `opportunity_finder_jobs`, `opportunity_finder_files`, `opportunity_finder_rows`, `opportunity_finder_rejected_rows` | runtime | BUSINESS DATA | DELETE | Entradas y ciclo de procesamiento de oportunidades |
| `opportunity_finder_demand_events`, `opportunity_finder_demand_part_options`, `opportunity_finder_supply_lots`, `opportunity_finder_historical_signals` | runtime | BUSINESS DATA | DELETE | Demanda, oferta e historial comercial |
| `opportunity_finder_possible_matches`, `opportunity_finder_results`, `opportunity_finder_allocations` | runtime | BUSINESS DATA | DELETE | Candidatos, resultados y asignaciones |
| `opportunity_finder_result_commercials`, `opportunity_finder_result_financials`, `opportunity_finder_review_decisions` | runtime | BUSINESS DATA | DELETE | Datos comerciales/financieros y revisiones |
| `opportunity_finder_output_runs`, `opportunity_finder_output_items` | runtime | BUSINESS DATA | DELETE | Salidas materializadas |
| `opportunity_finder_dataset_snapshots`, `opportunity_finder_dataset_snapshot_rows` | runtime | BUSINESS DATA | DELETE | Snapshots virtuales y filas |
| `upload_batches`, `upload_sheets`, `business_upload_versions`, `business_scope_counters`, `file_schema_profiles` | runtime | OPERATIONAL DATA | DELETE | Estado operativo de cargas y perfiles detectados |
| `import_jobs`, `import_job_errors`, `import_job_error_summary`, `import_errors` | runtime | OPERATIONAL DATA | DELETE | Cola, errores y warnings de importación |
| `email_alert_rules`, `email_notification_events` | runtime | OPERATIONAL DATA | DELETE | Reglas y entregas empresariales |
| `password_reset_codes`, `api_rate_limits`, `observability_log_outbox` | runtime | OPERATIONAL DATA | DELETE | Estado efímero y colas técnicas |
| `audit_logs`, `security_events`, `system_logs`, `client_logs`, `performance_logs`, `opportunity_finder_audit_events` | runtime | AUDIT DATA | DELETE | Auditoría previa que puede correlacionar datos empresariales |
| `profiles` | runtime | AUTH/IDENTITY | PRESERVE | Identidades activas, incluido Super Admin Dev |
| `opportunity_finder_tenants`, `opportunity_finder_tenant_memberships` | runtime | SYSTEM CONFIG | PRESERVE | Límites y autorización tenant |
| `opportunity_finder_manufacturer_registry_versions`, `opportunity_finder_manufacturers`, `opportunity_finder_manufacturer_aliases` | runtime | SYSTEM CONFIG | PRESERVE | Registro de normalización aprobado |
| `opportunity_finder_part_equivalence_versions`, `opportunity_finder_part_equivalences` | runtime | SYSTEM CONFIG | PRESERVE | Equivalencias aprobadas |
| `database_safety_state` | runtime | SYSTEM CONFIG | PRESERVE | Watermark monotónico |
| `database_backup_manifests`, `database_destruction_operations`, `database_safety_audit_events` | runtime | AUDIT DATA | PRESERVE | Evidencia, idempotencia y ledger protegido |
| `auth.users` | runtime | AUTH/IDENTITY | PRESERVE | Supabase Auth administrado |
| `supabase_migrations.schema_migrations` | runtime | MIGRATIONS/SCHEMA | PRESERVE | Historial de migraciones |
| `storage.objects`, `storage.buckets` | runtime | STORAGE METADATA | PRESERVE | Metadatos/configuración; blobs fuera del dump |

## Dependencias y rollback

El orden explícito elimina hijos antes de padres para todas las FKs `RESTRICT`/`NO ACTION`: adjuntos antes de mensajes; mensajes/miembros antes de conversaciones; errores y registros antes de hojas/batches; detalles/asignaciones antes de clientes; output items antes de output runs; financieros/comerciales/alocaciones antes de results; snapshot rows antes de snapshots; rows/results/files antes de jobs. Cinco relaciones históricas usan explícitamente `ON DELETE CASCADE` o `ON DELETE SET NULL` y no requieren ese orden para mantener integridad; esta migración no agrega ni amplía esos cascades. Las raíces protegidas (`profiles`, tenants y catálogos) nunca entran en la allowlist y la operación no confía en una blacklist.

La prueba SQL de integración está bloqueada por `quiksol.allow_destructive_runtime_test=on`, debe ejecutarse solo en una base desechable y termina con `ROLLBACK`.

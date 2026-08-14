# Opportunity Finder: modo de un archivo

El modo `single_file` compara un archivo subido con un snapshot inmutable de las entidades canónicas que el usuario ya puede consultar. No escanea `business_records` durante la petición y no utiliza el cliente `service_role` para leer el universo existente.

## Dependencias locales

Requiere las migraciones aditivas:

- `20260813120000_performance_scalability.sql`
- `20260814120000_opportunity_finder_single_file.sql`

La segunda crea la proyección versionada `business_opportunity_entities`, las tablas de snapshot y RPC estrechas para confirmar y persistir el job. La migración no se aplica automáticamente ni forma parte de un deploy.

Después de aplicar la migración en un entorno aprobado, el worker de resúmenes debe reconstruir las cargas activas. Hasta que `summary_version` y `opportunity_entity_version` coincidan con `data_version`, la API responde `OPPORTUNITY_DATASET_SUMMARY_NOT_READY` y no inicia la comparación.

## Fallback seguro

Si las tablas, columnas o RPC nuevas aún no existen en un ambiente remoto, el modo de dos archivos sigue disponible. El modo de un archivo falla de forma cerrada con un error de migración/dataset no disponible; nunca descarga toda `business_records`, nunca usa un agregado MPN que fusione eventos y nunca omite RLS para simular compatibilidad.

## Seguridad y reproducibilidad

La lectura del manifiesto y de candidatos usa el cliente autenticado y las políticas RLS existentes. Solo se consultan MPN presentes en el archivo. El job guarda el hash del archivo, rol, scope, versión de dataset, manifiesto, versión de pipeline y snapshot. El worker consume ese snapshot y reutiliza el parser, matcher y asignador transaccional existentes.

Los históricos quedan como señales; no se materializan como inventario vivo. Las ofertas de proveedor requieren cantidad positiva y vigencia explícita futura. Costos y datos comerciales restringidos no se copian a la proyección visible por RLS.

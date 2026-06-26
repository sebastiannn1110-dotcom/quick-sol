# README de valoracion comercial - Quiksol Excel Intelligence System

Fecha de revision: 2026-06-26

Este documento resume las funciones, modulos tecnicos, alcance real del producto y factores de precio del sistema Quiksol. Esta pensado para explicar el valor del programa a un cliente, socio, comprador o inversionista.

## 1. Resumen ejecutivo

Quiksol Excel Intelligence System es una plataforma web interna para cargar, limpiar, normalizar, consultar y auditar archivos Excel operativos. El sistema convierte hojas de calculo dispersas en una base de datos consultable con metricas, control por roles, analitica, auditoria, trazabilidad y asistente de IA por texto y voz.

El producto no es solo una pagina web. Incluye:

- Aplicacion web con Next.js, React y TypeScript.
- Autenticacion y permisos por rol con Supabase.
- Carga masiva de Excel y CSV.
- Normalizacion automatica de columnas de negocio.
- Deteccion de categorias.
- Analisis de calidad de datos.
- Guardado del Excel original en storage privado.
- Busqueda avanzada de registros.
- Panel de empleado.
- Panel de administrador diferenciado.
- Dashboard y graficas.
- Logs, auditoria, seguridad y performance.
- Asistente de IA con contexto de datos reales.
- Soporte multilenguaje: espanol, ingles y chino simplificado.
- Voz: transcripcion con OpenAI y respuesta hablada con ElevenLabs.
- Tests automatizados y documentacion tecnica.

## 2. Problema que resuelve

Muchas empresas operan con informacion comercial y logistica repartida en Excel: MPN, clientes, proveedores, precios, GP, comisiones, cantidades, fechas, PO, inventario y comentarios. Ese modelo manual genera problemas:

- Archivos duplicados o perdidos.
- Dificultad para saber quien subio que archivo.
- Falta de trazabilidad cuando hay errores.
- Columnas con nombres distintos para el mismo dato.
- Formula errors o valores numericos mal escritos.
- Mucho tiempo buscando MPN, proveedor, cliente o PO.
- Riesgo de que empleados vean informacion que no les corresponde.
- Falta de indicadores ejecutivos confiables.

Quiksol centraliza ese flujo y lo convierte en un sistema auditable.

## 3. Usuarios objetivo

- Administrador: controla usuarios, revisa todas las cargas, descarga Excel originales, audita errores, consulta registros globales y usa herramientas de seguridad.
- Empleado: carga archivos, consulta sus registros y usa la IA con acceso limitado a sus propios datos.
- Manager: rol preparado a nivel de modelo de datos y RLS para acceso por departamento o region.
- Direccion comercial: revisa metricas de margen, clientes, proveedores, MPN y volumen de actividad.
- Equipo de operaciones: revisa errores de importacion, registros incompletos y calidad de datos.

## 4. Funciones principales

### 4.1 Login seguro

- Login con Supabase Auth.
- Sesion protegida por middleware.
- Bloqueo de rutas protegidas si no hay usuario autenticado.
- Roles soportados: `admin`, `manager`, `employee`.
- Validacion de perfil activo.
- Boton de cierre de sesion.
- Endpoint de configuracion publica para validar Supabase en frontend sin exponer secretos.

### 4.2 Interfaz multilenguaje

- Selector de idioma visible en la interfaz.
- Idiomas soportados:
  - Espanol.
  - Ingles.
  - Chino simplificado.
- Traducciones centralizadas en `lib/i18n.ts`.
- Soporte para textos de dashboard, menu, login, upload, admin e IA.

### 4.3 Panel de empleado

El empleado ve una experiencia mas simple que el admin:

- Dashboard de sus datos permitidos.
- Carga de Excel.
- Historial de cargas.
- Registros importados.
- Busqueda y filtros.
- Categorias y analitica general.
- Asistente flotante de IA.
- Acceso limitado segun permisos.

### 4.4 Panel administrador

El area de admin esta diferenciada visualmente con color naranja. Incluye:

- Centro admin con accesos a modulos.
- Gestion de usuarios.
- Vista global de cargas.
- Vista global de registros.
- Busqueda global.
- Analitica admin.
- Errores de importacion.
- Logs del sistema.
- Performance.
- Auditoria.
- Eventos de seguridad.
- Trazas por `trace_id`.
- Descarga o apertura del Excel original enviado por empleados.

### 4.5 Gestion de usuarios

Desde el admin se puede:

- Crear empleados.
- Editar nombre, email, rol, departamento y region.
- Asignar rol `employee`, `manager` o `admin`.
- Crear password temporal.
- Activar o desactivar usuarios.
- Buscar usuarios.
- Ver cargas por usuario.
- Ver registros por usuario.
- Ver analitica por usuario.

Valor comercial: reduce dependencia del desarrollador para administrar accesos.

### 4.6 Carga de Excel y CSV

El sistema acepta archivos de negocio y los procesa en backend:

- `.xlsx`
- `.xls`
- `.csv`
- Validacion de tipo MIME.
- Validacion de tamano.
- Limite configurable de filas.
- Limite configurable de hojas.
- Procesamiento por chunks para Supabase.
- Guardado del archivo original en Supabase Storage privado.
- Registro de batch de carga.
- Estado de carga: `pending`, `uploading`, `processing`, `completed`, `failed`, `archived`.
- Resultado con filas totales, filas validas, filas invalidas, errores y score de calidad.

Variables de control:

- `MAX_UPLOAD_SIZE_MB`
- `MAX_EXCEL_ROWS`
- `MAX_EXCEL_SHEETS`
- `SUPABASE_INSERT_CHUNK_SIZE`

### 4.7 Deteccion automatica de encabezados

El parser busca la fila de encabezados dentro de las primeras filas del Excel. Esto permite cargar archivos donde el header no esta exactamente en la fila 1.

Capacidades:

- Ignora filas vacias.
- Detecta fila de headers.
- Calcula confianza de deteccion.
- Registra advertencias si la confianza es baja.
- Procesa multiples hojas.
- Guarda el nombre de cada hoja.

### 4.8 Normalizacion de datos

El sistema mapea columnas con nombres distintos hacia campos estandar. Ejemplos:

- `MPN`, `Part Number`, `PN`, `P/N`, `Manufacturer Part Number` -> `mpn`.
- `Supplier`, `Vendor`, `Supplier Name` -> proveedor.
- `Customer`, `Cliente`, `Client` -> cliente.
- `Qty`, `Quantity`, `QTTY` -> cantidad.
- `GP`, `Gross Profit` -> ganancia bruta.
- `Commission`, `Comision` -> comision.
- `PO`, `Purchase Order` -> orden de compra.

Campos normalizados principales:

- Cliente.
- Proveedor.
- MPN.
- Fabricante.
- Descripcion.
- PO.
- Cantidad.
- Costo.
- Precio.
- Total price.
- GP rate.
- GP.
- Comision.
- MOQ.
- SPQ.
- Inventario.
- Lead time.
- Transit time.
- Fecha estimada de envio.
- Pais de origen.
- Punto de entrega.
- Comentarios.

### 4.9 Calidad de datos y errores de importacion

El programa detecta y guarda errores por fila y columna:

- Numeros invalidos.
- Fechas invalidas.
- Formula errors de Excel.
- Campos vacios importantes.
- Duplicados.
- Columnas no reconocidas.
- Confianza baja en headers.
- Errores de normalizacion.
- Registros incompletos.
- Registros sin MPN.

Cada error puede incluir:

- Archivo.
- Hoja.
- Fila.
- Columna.
- Valor original.
- Tipo de error.
- Severidad: `low`, `medium`, `high`, `critical`.
- Mensaje.
- Sugerencia de correccion.
- Trace ID.

Valor comercial: permite vender el sistema como herramienta de control de calidad, no solo como uploader.

### 4.10 Categorias de negocio

El sistema soporta categorias como:

- Sales Margin.
- RFQ.
- Customer Demand.
- Supplier Offers.
- Inventory.
- Customers.
- Suppliers.
- Orders.
- Logistics.
- Quality.
- Quality Inspection.
- Market Insights.
- Finance.
- Employees.
- Generic.
- Unknown.

El usuario puede elegir categoria o usar autodeteccion.

### 4.11 Registros y busqueda avanzada

La pantalla de registros permite buscar y filtrar por:

- Texto general.
- Categoria.
- Usuario que subio.
- Cliente.
- Proveedor.
- MPN.
- Fabricante.
- PO.
- Pais.
- Registros con errores.
- Registros sin errores.

Incluye paginacion y tabla de datos.

### 4.12 Dashboard y analitica

Metricas generales disponibles:

- Total de registros.
- Total de cargas.
- Empleados activos.
- Categorias detectadas.
- Ultima carga.
- Cantidad total.
- Potential amount USD.
- Total price.
- GP total.
- Tasa GP promedio.
- Comision total.
- Registros con errores.
- Registros incompletos.
- Registros sin MPN.

Agrupaciones y graficas:

- Registros por categoria.
- Cargas por empleado.
- Top MPN.
- Registros por cliente.
- Registros por proveedor.
- Registros por departamento.
- Empleados por rol.
- Empleados por region.
- Empleados por departamento.
- Cargas o registros en el tiempo.

### 4.13 Analitica por empleado

El modulo de empleados permite:

- Listar empleados.
- Ver conteo de cargas.
- Ver conteo de registros.
- Ver ultima carga.
- Abrir detalle de empleado.
- Ver historial de cargas del empleado.
- Ver registros relacionados.
- Filtrar desde admin hacia cargas o registros del empleado.

### 4.14 Administracion de cargas

El admin puede:

- Ver todas las cargas.
- Filtrar cargas por empleado.
- Ver quien subio cada archivo.
- Ver email del empleado.
- Ver categoria detectada.
- Ver estado.
- Ver filas validas.
- Ver cantidad de errores.
- Ver score de calidad.
- Abrir el Excel original.
- Descargar el Excel original.
- Ver registros importados de esa carga.
- Ver errores de esa carga.
- Abrir traza de errores.

### 4.15 Busqueda global admin

El admin tiene un buscador global para encontrar:

- Registros.
- Cargas.
- Empleados.
- Errores.

Puede buscar por:

- MPN.
- Proveedor.
- Cliente.
- PO.
- Archivo.
- Empleado.
- Categoria.
- Error.
- Comentarios.

### 4.16 Observabilidad y logs

El sistema guarda eventos operativos para diagnostico:

- `system_logs`.
- `client_logs`.
- `performance_logs`.
- `audit_logs`.
- `security_events`.

Los logs incluyen:

- Trace ID.
- Request ID.
- Nivel: debug, info, warn, error, fatal, security, audit.
- Modulo.
- Accion.
- Mensaje.
- Usuario.
- Email.
- Rol.
- Ruta.
- Metodo HTTP.
- Duracion.
- Upload batch.
- Archivo.
- Hoja.
- Fila.
- Columna.
- Categoria.
- Metadata.
- Error serializado.

### 4.17 Trazas por operacion

El admin puede abrir una traza y ver una linea de tiempo de eventos:

- Ultimo paso exitoso.
- Primer paso fallido.
- Eventos relacionados.
- Duracion.
- Metadata.
- Errores.
- Fila y columna asociada cuando aplica.

Valor comercial: acelera soporte y debugging en produccion.

### 4.18 Auditoria

El sistema registra eventos auditables:

- Carga completada.
- Carga fallida.
- Validacion fallida.
- Acciones de admin.
- Eventos de usuario.
- Actor.
- Entidad afectada.
- IP.
- User agent.
- Metadata.

### 4.19 Seguridad

Capas de seguridad implementadas:

- Supabase Auth.
- Row Level Security en tablas principales.
- Politicas por admin, manager y employee.
- Storage privado para Excel originales.
- Politicas de storage por usuario y admin.
- Service role solo en backend.
- Validacion de variables de entorno.
- CSP en `next.config.mjs`.
- Permisos para microfono en navegador.
- Rate limiting en upload y voz.
- Sanitizacion de nombres de archivo.
- Prevencion de formula injection en Excel.
- Logs de seguridad.
- No exponer secretos en frontend.

### 4.20 Asistente de IA por texto

El asistente usa OpenAI y contexto real de Supabase.

Puede ayudar con:

- Buscar MPN.
- Buscar proveedores.
- Buscar clientes.
- Resumir ultimo Excel.
- Mostrar rankings de MPN, suppliers o customers del ultimo upload.
- Explicar metricas del dashboard.
- Explicar errores de importacion.
- Guiar al usuario sobre como usar el programa.
- Responder diferente si el usuario es admin o empleado.

Restricciones importantes:

- El admin puede recibir resumen global.
- El empleado solo debe recibir informacion permitida.
- No debe revelar secretos, keys, tokens ni informacion fuera de contexto.
- Si no hay datos suficientes, debe decirlo claramente.

### 4.21 Asistente de IA por voz

El sistema incluye flujo de voz:

- Grabacion desde navegador con MediaRecorder.
- Envio de audio como FormData.
- Transcripcion con OpenAI.
- Deteccion de idioma.
- Pregunta al asistente con el texto transcrito.
- Respuesta de texto.
- Generacion de voz con ElevenLabs.
- Reproductor interno con play, pausa, progreso y replay.
- Fallback a texto si ElevenLabs falla.
- Error claro si OpenAI no puede transcribir.

Endpoints relacionados:

- `/api/ai/voice/ask`
- `/api/ai/voice/transcribe`
- `/api/ai/voice/speak`

Variables principales:

- `OPEN_IA` o `OPENAI_API_KEY`.
- `OPENAI_MODEL`.
- `OPENAI_TRANSCRIBE_MODEL`.
- `ELEVENLABS_API_KEY`.
- `ELEVENLABS_MODEL_ID`.
- `ELEVENLABS_VOICE_ES`.
- `ELEVENLABS_VOICE_EN`.
- `ELEVENLABS_VOICE_ZH`.
- `ENABLE_VOICE_ASSISTANT`.

### 4.22 Fallback demo local

El proyecto tiene datos JSON locales para modo desarrollo cuando Supabase no esta configurado en produccion.

Archivos:

- `data/database.json`
- `data/uploads.json`
- `lib/platform/demoRepository.ts`

Valor: permite demos locales sin depender siempre de la base real.

### 4.23 Documentacion incluida

El repositorio ya incluye documentos tecnicos:

- `README.md`
- `README_DEPLOYMENT_REPORT.md`
- `README_TECHNICAL_GLOSSARY.md`
- `CHANGELOG_QUIKSOL_CORRECTIONS.md`
- `VOICE_RECORDING_TESTS.md`
- `VOICE_AUDIO_FIX_REPORT.md`
- `docs/DEPLOYMENT.md`
- `docs/SECURITY_CHECKLIST.md`
- `docs/BACKUP_AND_RECOVERY.md`

### 4.24 Testing

El proyecto incluye Vitest y tests en varias areas:

- Parser de Excel.
- Normalizador.
- Detector de headers.
- Detector de categorias.
- Validadores.
- Analitica.
- Variables de entorno.
- CSP.
- Transcripcion de voz.
- ElevenLabs.

Scripts:

```bash
npm run build
npm run test
npm run typecheck
npm run lint
```

## 5. Arquitectura tecnica

### 5.1 Frontend

- Next.js 16 App Router.
- React 18.
- TypeScript.
- Tailwind CSS.
- Lucide React para iconos.
- Recharts para graficas.
- Componentes reutilizables.
- Layout protegido con sidebar y navbar.
- Diferenciacion visual admin/empleado.

### 5.2 Backend

- API routes de Next.js.
- Runtime Node.js para Excel, IA y storage.
- Validacion con Zod.
- Parser `xlsx`.
- Logging estructurado.
- Manejo centralizado de errores.
- Rate limiting en memoria.
- Integracion Supabase SSR.

### 5.3 Base de datos

Supabase PostgreSQL con tablas:

- `profiles`.
- `upload_batches`.
- `upload_sheets`.
- `business_records`.
- `import_errors`.
- `audit_logs`.
- `security_events`.
- `system_logs`.
- `client_logs`.
- `performance_logs`.

### 5.4 Storage

Bucket privado:

- `excel-uploads`.

Uso:

- Guardar Excel original.
- Permitir descarga por admin.
- Permitir acceso del duenio segun politicas.
- Evitar archivos publicos.

### 5.5 Integraciones externas

- Supabase: Auth, Postgres, RLS y Storage.
- OpenAI: asistente y transcripcion.
- ElevenLabs: texto a voz.
- Render: despliegue web.

## 6. Endpoints principales

### Usuario y autenticacion

- `/api/me`
- `/api/auth/public-config`
- `/api/logs/auth`
- `/api/logs/client`

### Datos y Excel

- `/api/upload`
- `/api/records`
- `/api/search`
- `/api/analytics`
- `/api/employees`

### Admin

- `/api/admin/users`
- `/api/admin/uploads`
- `/api/admin/uploads/[uploadId]/download`
- `/api/admin/records`
- `/api/admin/search`
- `/api/admin/errors`
- `/api/admin/logs`
- `/api/admin/performance`
- `/api/admin/security-events`
- `/api/admin/audit-logs`
- `/api/admin/traces/[traceId]`
- `/api/admin/analytics`

### IA

- `/api/assistant`
- `/api/ai/assistant`
- `/api/ai/voice/ask`
- `/api/ai/voice/transcribe`
- `/api/ai/voice/speak`

## 7. Pantallas principales

- `/login`
- `/dashboard`
- `/upload`
- `/records`
- `/categories`
- `/analytics`
- `/employees`
- `/admin`
- `/admin/users`
- `/admin/uploads`
- `/admin/records`
- `/admin/search`
- `/admin/analytics`
- `/admin/import-errors`
- `/admin/logs`
- `/admin/performance`
- `/admin/audit-logs`
- `/admin/security`
- `/admin/traces/[traceId]`

## 8. Valor de negocio

### Ahorro operativo

El sistema puede reducir:

- Tiempo de revision manual de Excel.
- Tiempo buscando datos en archivos sueltos.
- Tiempo corrigiendo columnas inconsistentes.
- Tiempo diagnosticando errores de carga.
- Dependencia de una persona que conoce los archivos.

### Control y trazabilidad

La empresa gana:

- Historial de cargas.
- Responsable de cada archivo.
- Registros por empleado.
- Excel original preservado.
- Errores por fila y columna.
- Logs por trace ID.
- Auditoria de acciones.

### Calidad de datos

El programa ayuda a convertir datos inconsistentes en una estructura analizable:

- Mapeo de columnas.
- Normalizacion numerica.
- Normalizacion de fechas.
- Deteccion de formulas rotas.
- Score de calidad.
- Conteo de registros incompletos.

### Inteligencia operacional

El sistema da respuestas rapidas sobre:

- Mejores clientes.
- Principales proveedores.
- MPN mas frecuentes.
- Margen bruto.
- Comisiones.
- Cargas por empleado.
- Errores recurrentes.
- Calidad de la informacion.

## 9. Costos operativos a considerar

Estos costos cambian segun uso, plan y proveedor. Revisar siempre las paginas oficiales antes de cerrar una cotizacion.

- Render: hosting de la aplicacion Next.js. Referencia: https://render.com/pricing
- Render Free limitaciones: no recomendado para produccion critica. Referencia: https://render.com/docs/free
- Supabase: Auth, base de datos, storage y RLS. Referencia: https://supabase.com/pricing
- OpenAI API: respuestas IA y transcripcion. Referencia: https://developers.openai.com/api/docs/pricing
- ElevenLabs: generacion de voz. Referencia: https://elevenlabs.io/pricing
- ElevenLabs API usage: https://elevenlabs.io/pricing/api

Costos internos adicionales:

- Dominio.
- Backups.
- Soporte mensual.
- Monitoreo.
- Correccion de bugs.
- Mejoras de producto.
- Capacitacion de usuarios.
- Seguridad y revision de permisos.

## 10. Riesgos y puntos a mejorar antes de vender mas caro

Para una venta de mayor valor, conviene reforzar:

- QA visual completo de todas las pantallas.
- Limpieza de algunos textos con mojibake en vistas internas.
- Pruebas end-to-end con Playwright.
- Exportacion de reportes PDF o Excel desde dashboard.
- Backups automatizados verificados.
- Monitoreo externo de uptime.
- Politicas de retencion de logs.
- Panel de configuracion de categorias sin tocar codigo.
- Paginacion y filtros mas avanzados en admin.
- Soporte multiempresa si se vendera como SaaS.
- Roles manager completamente probados con datos reales.
- Historial de versiones de cada upload.
- Eliminacion o archivado controlado de datos desde UI.
- Dashboard ejecutivo con rangos de fecha.
- Contrato de soporte y SLA.

## 11. Como tasarlo

El precio depende de si vendes:

- Solo el codigo fuente.
- La app instalada y configurada.
- La app con soporte.
- Una licencia mensual.
- Una solucion a medida para una empresa.
- Un SaaS multiempresa.

### 11.1 Valor por modulos

Una forma practica de valorar es separar por modulos:

| Modulo | Valor relativo |
| --- | --- |
| Login, roles y permisos | Alto |
| Carga Excel robusta | Muy alto |
| Normalizacion y calidad de datos | Muy alto |
| Supabase con RLS y storage privado | Alto |
| Dashboard y analitica | Alto |
| Panel admin | Muy alto |
| Logs, auditoria y trazas | Muy alto |
| IA por texto con contexto | Alto |
| IA por voz | Alto / premium |
| Multilenguaje ES/EN/ZH | Medio / alto |
| Tests y documentacion | Medio / alto |

### 11.2 Rango orientativo de precio

Esta es una estimacion comercial, no una tasacion legal:

- Prototipo funcional entregado sin soporte fuerte: USD 8,000 a USD 15,000.
- Producto interno instalado, con Supabase, Render, usuarios, Excel, admin e IA: USD 18,000 a USD 35,000.
- Producto empresarial con garantia, soporte, hardening, documentacion y capacitacion: USD 35,000 a USD 70,000.
- Version SaaS multiempresa con billing, tenants, backups, monitoreo y SLA: USD 70,000 a USD 150,000 o mas.

En pesos colombianos, conviene convertir con la TRM del dia de la negociacion.

### 11.3 Modelo mensual recomendado

Si no quieres vender el codigo, puedes cobrar:

- Setup inicial: USD 5,000 a USD 20,000.
- Mensualidad basica: USD 500 a USD 1,500.
- Mensualidad con soporte e IA: USD 1,500 a USD 4,000.
- Enterprise con SLA, backups y mejoras continuas: USD 4,000 a USD 10,000+.

### 11.4 Argumentos para pedir mejor precio

Puedes defender un precio alto porque el sistema incluye:

- Carga masiva de Excel real.
- Normalizacion de datos de negocio.
- Calidad de datos por fila.
- Storage privado del archivo original.
- Seguridad por rol.
- Admin completo.
- Auditoria y trazabilidad.
- IA conectada a datos reales.
- Voz y multilenguaje.
- Arquitectura moderna.
- Base escalable.
- Documentacion y tests.

## 12. Frase comercial sugerida

Quiksol Excel Intelligence System es una plataforma interna de inteligencia operacional que transforma archivos Excel comerciales en una base de datos segura, auditable y consultable con dashboards, control de calidad, trazabilidad, roles, IA por texto y voz, y panel administrativo completo.

## 13. Checklist para presentar a comprador

Antes de mostrarlo:

- Confirmar que Render despliega el ultimo commit.
- Confirmar Supabase configurado.
- Confirmar usuarios admin y employee.
- Subir un Excel limpio de prueba.
- Subir un Excel con errores para demostrar calidad de datos.
- Mostrar dashboard.
- Mostrar registros y filtros.
- Mostrar admin uploads.
- Descargar Excel original desde admin.
- Mostrar errores de importacion.
- Mostrar logs y trazas.
- Hacer una pregunta al asistente IA.
- Probar una nota de voz.
- Mostrar cambio de idioma ES/EN/ZH.
- Explicar que las keys no se entregan publicamente.

## 14. Estado actual del producto

El producto ya tiene una base funcional avanzada para uso interno. Para venderlo al mejor precio, lo ideal es presentarlo como una solucion empresarial en fase beta avanzada o MVP robusto, no como experimento.

Estado recomendado de venta:

- Para cliente pequeno: listo para piloto pago.
- Para empresa mediana: listo con una fase corta de hardening.
- Para enterprise: requiere SLA, backups, monitoreo, pruebas E2E y documentacion contractual.

## 15. Archivos clave del proyecto

- `app/`: pantallas y rutas API.
- `components/`: componentes de UI.
- `lib/excel/`: parser, normalizador, validadores y calidad.
- `lib/ai/`: logica del asistente.
- `lib/voice/`: transcripcion y ElevenLabs.
- `lib/security/`: env, CSP tests y rate limit.
- `lib/logger/`: logs estructurados.
- `lib/auth/`: contexto de autenticacion y auditoria.
- `supabase/migrations/`: schema, RLS, storage y logs.
- `docs/`: guias operativas.

## 16. Conclusion

Quiksol tiene valor porque combina cuatro capas que normalmente se venden por separado:

1. Plataforma web interna.
2. ETL de Excel y calidad de datos.
3. Analitica operacional.
4. IA conversacional y de voz conectada al negocio.

Eso justifica tasarlo por encima de una web comun. El precio debe defenderse como una herramienta de productividad, seguridad y analitica para una operacion comercial real.


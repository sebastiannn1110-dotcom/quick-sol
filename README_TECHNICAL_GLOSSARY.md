# Quiksol - Glosario tecnico del programa

Este documento explica las palabras tecnicas que aparecen en Quiksol Excel Intelligence System.

## Roles y acceso

- Admin: usuario con permiso para ver todos los datos, empleados, uploads, logs y eventos de seguridad.
- Employee: usuario que sube Excel y trabaja principalmente con sus propios datos.
- Role: tipo de permiso asignado a cada usuario. En el sistema puede ser `admin`, `manager` o `employee`.
- Profile: registro interno que guarda nombre, email, rol, departamento, region y estado activo del usuario.
- Active user: usuario habilitado para entrar al sistema.
- Inactive user: usuario bloqueado por administracion.
- Session: sesion de login que mantiene al usuario autenticado.
- Middleware / Proxy: capa que revisa permisos antes de abrir rutas protegidas como `/dashboard` o `/admin`.

## Supabase

- Supabase: plataforma usada como base de datos, autenticacion y almacenamiento de archivos.
- Supabase Auth: sistema de login de Supabase.
- Supabase URL: direccion del proyecto Supabase.
- Publishable key: key publica para usar Supabase desde navegador. En este proyecto se guarda como `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
- Anon key: nombre antiguo o legacy de la key publica.
- Service role key: key secreta del servidor con permisos administrativos. Nunca debe exponerse al navegador ni subirse a GitHub.
- RLS: Row Level Security. Reglas de seguridad que deciden que filas puede ver o modificar cada usuario.
- Storage bucket: espacio de Supabase Storage donde se guardan archivos. El bucket de Excel se llama `excel-uploads`.
- Signed URL: enlace temporal y seguro para abrir o descargar un archivo privado.

## Datos de Excel

- Upload: accion de subir un archivo Excel o CSV.
- Upload batch: registro que representa un archivo subido y su estado de procesamiento.
- Stored file path: ruta privada donde quedo guardado el archivo original en Supabase Storage.
- Original file name: nombre original o sanitizado del archivo subido.
- Sheet: hoja dentro de un archivo Excel.
- Header row: fila detectada como encabezado de columnas.
- Business record: fila normalizada que el sistema guarda como dato de negocio.
- Raw data: datos originales tal como venian en el Excel.
- Normalized data: datos transformados a un formato consistente para buscar y analizar.
- Searchable text: texto compuesto para busquedas rapidas sobre los registros.
- Data quality score: indicador de calidad de datos segun errores o campos incompletos.
- Import error: error detectado al leer una fila o columna del Excel.
- Valid rows: filas aceptadas por el sistema.
- Invalid rows: filas con errores.

## Categorias

- Category: tipo de datos detectado en el Excel.
- Auto Detect: opcion donde el sistema decide la categoria segun las columnas.
- Sales Margin: categoria para margen, precio, costo, GP y comisiones.
- Supplier Offers: categoria para ofertas de proveedores.
- Customer Demand: categoria para demanda de clientes.
- Inventory: categoria para inventario.
- RFQ: Request For Quotation, solicitudes de cotizacion.
- Orders: ordenes o pedidos.
- Logistics: datos de envio, pais, tiempos y entrega.
- Quality Inspection: inspeccion de calidad.
- Market Insights: datos de mercado.
- Finance: datos financieros.

## Paneles

- Dashboard: resumen operativo del usuario.
- Upload: area para subir Excel.
- Records: tabla de registros importados.
- Categories: analisis por categorias.
- Analytics: metricas y graficas del negocio.
- Admin: area administrativa, diferenciada en naranja.
- All Uploads: vista admin para ver archivos subidos por todos los empleados.
- All Records: vista admin para ver registros globales.
- Logs: registros tecnicos de actividad y errores.
- Audit logs: historial de acciones administrativas.
- Security events: eventos de seguridad como intentos no autorizados.
- Performance: mediciones de rendimiento.
- Trace: identificador que conecta logs de una misma solicitud.

## Observabilidad

- Log: registro tecnico de algo que ocurrio en el sistema.
- Trace ID: identificador de una cadena de eventos.
- Request ID: identificador de una solicitud HTTP concreta.
- Client log: log enviado desde el navegador.
- System log: log guardado por el backend.
- Performance log: log de duracion de operaciones.
- Audit event: evento de auditoria para acciones importantes.
- Security event: evento de seguridad.

## IA

- AI Assistant: asistente flotante para ayudar a buscar datos o explicar como usar el sistema.
- OPEN_IA: variable de entorno donde se guarda la API key de OpenAI para el servidor.
- OPENAI_MODEL: variable opcional para elegir el modelo usado por el asistente.
- Prompt: instruccion o pregunta enviada a la IA.
- Context: datos que el servidor entrega a la IA para responder sin inventar.
- Server-side AI call: llamada a OpenAI hecha desde el servidor para proteger la key.
- Responses API: API de OpenAI usada para generar respuestas del asistente.

## Render y despliegue

- Render: plataforma donde esta desplegada la web.
- Build: proceso que compila la app antes de publicarla.
- Runtime: momento en que la app ya esta corriendo.
- Environment variable: variable de configuracion guardada fuera del codigo.
- Clear build cache: opcion de Render para reconstruir desde cero.
- Deploy: publicacion de una version nueva.
- Commit: version guardada en Git.
- Main branch: rama principal del repositorio.

## Seguridad

- Secret: valor sensible que no debe compartirse.
- API key: clave para usar un servicio externo.
- Placeholder: valor falso de ejemplo, como `TU_PUBLISHABLE_KEY`.
- Rate limit: limite de solicitudes para evitar abuso.
- Private bucket: bucket no publico.
- Sanitization: limpieza de valores para evitar datos peligrosos o inconsistentes.
- Formula injection: riesgo de formulas maliciosas en hojas de calculo.

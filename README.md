# AFI Backend

## Planificador financiero por espacios y objetivos

Aplica `supabase/migrations/012_financial_planner.sql` después de las anteriores. Añade presupuestos privados, fecha de inicio de objetivos, autorización explícita y revocable de compartir planes, auditoría y límites de aportes. Los planes anteriores se vuelven privados de forma predeterminada. El nuevo motor y su algoritmo por restricciones de vencimiento se documentan en [PLANNER.md](PLANNER.md), con rutas, fórmulas, supuestos, límites y pruebas. No utiliza IA ni registra movimientos financieros automáticamente.

## Meta mensual de ahorro

En instalaciones existentes, aplica `supabase/migrations/011_savings_target.sql`. Añade `user_preferences.savings_target_percentage` (20% predeterminado, configurable entre 0% y 100%) y actualiza `update_profile` conservando las preferencias anteriores cuando no se envía el nuevo campo. `PUT /api/v1/profile` admite el campo opcional `savings_target_percentage`.

El dashboard devuelve `savingsIndicator`: importe objetivo, reservas netas del mes, porcentaje real, importe faltante, progreso y estado (`no_income`, `behind`, `on_track`). Usa ingresos y movimientos del fondo de la misma moneda, usuario y mes en la zona horaria del perfil; excluye transacciones anuladas. Distribuir el fondo entre objetivos no vuelve a contar como ahorro nuevo. Los porcentajes de participación de personas siguen guardándose por objetivo en `savings_goal_members` mediante `PUT /goals/:id/members`.

## Variables mínimas en Vercel

Conserva únicamente las variables de conexión y claves:

```dotenv
FRONTEND_URL=https://afifront-git-main-eacode.vercel.app
AI_API_KEY=TU_CLAVE_IA
SUPABASE_URL=https://TU-PROYECTO.supabase.co
SUPABASE_ANON_KEY=TU_CLAVE_ANON
SUPABASE_SERVICE_ROLE_KEY=TU_CLAVE_SERVICE_ROLE
DATABASE_URL=TU_CONEXION_OPCIONAL
```

`DATABASE_URL` se puede conservar, pero la API actual consulta a través de Supabase
y no la utiliza. Ninguna clave se incluye en el código.
Los demás valores están en [`src/defaults.ts`](src/defaults.ts): se mantiene el
modelo `gpt-5.4-nano`, el endpoint OpenAI, timeout de 15 segundos, presupuesto
mensual de USD 5 y límite mensual de 100 consultas por usuario, además de los
límites de tokens. Los precios de entrada/salida por millón son USD 0.20/1.25,
verificados en [OpenAI Docs](https://developers.openai.com/api/docs/models/gpt-5.4-nano).

La IA se activa al configurar `AI_API_KEY`. Sin clave queda desactivada.
No necesitas definir `AI_ENABLED`, modelo, precios, presupuesto, `PORT` ni
`NODE_ENV`. Vercel determina el entorno de producción. Después de actualizar,
elimina las variables opcionales antiguas si quieres usar los defaults y haz
Redeploy. Un `AI_ENABLED=false` explícito sigue desactivando la IA.

Se admiten overrides opcionales para instalaciones personalizadas. Los campos
opcionales vacíos usan defaults; los límites numéricos explícitos de cero se
conservan. Si cambias modelo o proveedor, debes indicar sus precios: nunca se
aplican automáticamente los precios de este modelo a otro distinto.

## Rutas y despliegue en Vercel

Compatibilidad de dependencias: `@fastify/static` usa `require()` para cargar
`content-disposition`. Se fija esa dependencia transitiva a `2.0.1` (CommonJS,
con la API `create`), conservando Swagger UI 6.1.2 y Static 10.1.8.
La versión 3 es ESM y puede provocar `ERR_REQUIRE_ESM` en el cargador de Vercel.
No elimines el override sin ejecutar la prueba de compatibilidad del runtime.
El archivo lock debe instalarse con `npm ci` en cada despliegue.

También se fija `cookie` a `1.1.1` dentro de `light-my-request`: conserva la API
`stringifySetCookie` y permite cargarla desde CommonJS. `cookie` 2 es ESM y el
cargador de Vercel puede rechazar su `require()`. La prueba de runtime ejecuta
una petición completa de Fastify con cookies y Swagger sin `require(ESM)`, no
solo la importación de los plugins.

Vercel utiliza la función HTTP `api/index.ts`, que reutiliza la aplicación
Fastify mediante `src/vercel-handler.ts` sin llamar a `listen()` ni abrir un
puerto. Las reescrituras conservan la ruta y los filtros de cada petición.
`src/server.ts` sigue siendo la entrada para desarrollo y servidores Node.js
persistentes. La raíz `/` devuelve información de AFIBACK y `/health` comprueba
el proceso.

En Vercel importa este repositorio como proyecto independiente, con Root Directory
en la raíz y preset Other (la función se declara en `vercel.json`). Instala con
`npm ci` y compila con `npm run build`; el directorio estático es `public`, no
`dist`. Usa Node.js 24.x. No agregues un comando de inicio que abra un puerto
en Vercel: la plataforma llama directamente a la función.
El frontend debe apuntar al dominio **estable de producción** del backend,
seguido de `/api/v1`; no a la URL del panel `vercel.com/...` ni a una URL temporal
de despliegue protegida por Vercel Authentication.

Las peticiones entre proyectos necesitan un dominio accesible al navegador:
Vercel Authentication en el backend puede redirigirlas al login de Vercel antes
de llegar a Fastify. Revisa Deployment Protection del dominio de producción.
Esto es independiente de los JWT de AFI, que siguen siendo obligatorios para
los datos personales y las operaciones financieras.

Después de publicar la rama `main`, comprueba el dominio de producción con:

```powershell
npm.cmd run deployment:check -- https://afiback.vercel.app
```

El comando verifica salud, preflight de los dos orígenes requeridos, métodos,
cabeceras, rechazo de terceros y protección de una ruta financiera. También
envía dos intentos de login con identidades aleatorias inexistentes para comprobar
que Supabase devuelve `invalid_credentials`, no 404, y que ese error conserva
CORS. No imprime contraseñas ni tokens, no cambia cuentas y no registra movimientos.
Los intentos cuentan dentro del rate limit de login; no repitas el comando en bucle.

La recuperación en Vercel/producción usa las tablas privadas de Supabase creadas
por `supabase/migrations/009_private_recovery.sql`. Ejecuta esa migración una vez
en instalaciones existentes. No se abre ningún archivo SQLite en Vercel ni se
utiliza `/tmp` para guardar respuestas o códigos.

CORS: se permiten por defecto `https://afifront-git-main-eacode.vercel.app`
y `http://localhost:5173`, además del dominio principal
`https://afifront.vercel.app` en producción. `FRONTEND_URL` permite añadir
dominios propios adicionales y conserva el origen de desarrollo configurado.
No se permiten automáticamente todos los dominios de Vercel ni todos los puertos
de localhost. Los métodos son GET, HEAD, POST, PUT, PATCH, DELETE y OPTIONS.
Se admiten Content-Type, Authorization e Idempotency-Key en el preflight.
Las sesiones usan tokens Bearer; no se habilitan credenciales de cookies CORS.
Se normalizan dominios sin protocolo y barras finales; varios orígenes se
separan con comas. El preflight `OPTIONS /api/v1/auth/login` debe responder 204
con `Access-Control-Allow-Origin` para ese dominio. No se permite `*` ni se
elimina la verificación de sesión. Si `/health` no responde o Vercel devuelve
un error antes de invocar la función, el navegador también puede mostrarlo como
error de CORS: primero comprueba el arranque del backend.

## Autenticación centralizada

El frontend solo necesita `NEXT_PUBLIC_API_URL` apuntando a `/api/v1` de este servicio.
AFIBACK se conecta a Supabase Auth, PostgreSQL mediante Supabase y el proveedor de IA.
Las claves de Supabase y de IA se configuran exclusivamente como variables del backend.

Rutas de Auth:

| Ruta | Operación |
| --- | --- |
| `POST /api/v1/auth/login` | Usuario/correo y contraseña; devuelve una sesión |
| `POST /api/v1/auth/register` | Registro con nombre, correo y contraseña |
| `POST /api/v1/auth/refresh` | Rotación del refresh token |
| `POST /api/v1/auth/session` | Verificar el token de un enlace de confirmación/recuperación |
| `POST /api/v1/auth/logout` | Cerrar la sesión actual |
| `POST /api/v1/auth/recover` | Enviar enlace de recuperación al correo real |
| `PUT /api/v1/auth/password` | Cambiar contraseña con Bearer válido |
| `POST /api/v1/auth/reauthenticate` | Solicitar verificación adicional cuando Auth la requiere |

El backend normaliza usuarios cortos a `@afi.com`, verifica identidades con Supabase
y devuelve únicamente los tokens y un resumen del usuario. Las respuestas de Auth
usan `Cache-Control: no-store`; las rutas sensibles tienen límites específicos.
Los enlaces solo permiten URLs de retorno cuyos orígenes están en `FRONTEND_URL`.
Las consultas financieras siguen ejecutándose con el JWT del usuario y RLS,
sin sustituirlo por service role. Las rutas de pregunta de seguridad y código
de recuperación se conservan.

En el backend configura `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY` (recuperación administrativa) y
`FRONTEND_URL=https://TU-FRONTEND.vercel.app`. Para varios orígenes, sepáralos
con comas. Las variables de IA se describen en `.env.example`.
`DATABASE_URL` no se usa para operaciones normales: se consulta la base a través
de Supabase. Esta actualización no requiere migraciones SQL adicionales.

El servicio usa Node.js y, en producción, almacenamiento compartido de recuperación
en Supabase. El esquema `afi_private` no es accesible por anon ni authenticated;
las funciones RPC solo se conceden a service role. Los códigos se consumen de
forma atómica, y los bloqueos por intentos se comparten entre instancias.

API independiente en Node.js + TypeScript + Fastify. Requiere Node.js 22 o superior y un proyecto Supabase nuevo. No depende del frontend para compilar o funcionar.

## Configuración y desarrollo

```powershell
Copy-Item .env.example .env
npm.cmd ci
npm.cmd run dev
```

Configura `SUPABASE_URL` y `SUPABASE_ANON_KEY`. Usa una clave pública legacy anon de tu proyecto; no copies secretos al frontend. `FRONTEND_URL` admite una lista de orígenes separados por comas, sin barras finales. `PORT` es 4000 inicialmente.

`SUPABASE_SERVICE_ROLE_KEY` se necesita para la recuperación de contraseñas por código y, opcionalmente, las dos RPC administrativas de consumo de IA. Nunca se usa para operaciones financieras. `DATABASE_URL` se reserva para herramientas de migración PostgreSQL; la API financiera usa el cliente HTTP de Supabase con identidad del usuario.

## Recuperación sin buzón de correo

### Pregunta de seguridad

El login abre **Olvidé mi contraseña → Pregunta de seguridad**. El usuario consulta su pregunta, escribe la respuesta y confirma una nueva clave. Antes debe configurarla desde **Configuración → Pregunta de seguridad**, presentando su JWT y contraseña actual; el backend verifica ambos con Supabase. Si todavía no puede iniciar sesión, el flujo **Configurar por primera vez** acepta un código de recuperación privado, una sola vez, para registrar pregunta y respuesta. No permite registrar una pregunta únicamente conociendo el usuario.

La respuesta se normaliza con NFKC, minúsculas y espacios consecutivos reducidos, sin eliminar acentos. Debe tener al menos ocho caracteres; se recomienda una frase privada. Se almacena con scrypt (N=32768, r=8, p=1), salt aleatoria por configuración y comparación de tiempo constante. La consulta pública devuelve solo la pregunta. Cinco respuestas incorrectas bloquean la cuenta durante treinta minutos, persistido en el almacén privado; también hay límites por IP y exclusión de restablecimientos simultáneos. Una operación de recuperación en curso impide sustituir la pregunta en paralelo.

Rutas: `POST /api/v1/auth/security-question/lookup`, `/setup`, `/reset`. Son rutas públicas con pruebas de identidad propias: `/setup` requiere sesión + clave actual o código; `/reset` requiere respuesta correcta. La clave se actualiza con la API administrativa de Supabase solo después de verificar esa prueba. Las preguntas elegidas no deben revelar la respuesta ni contener datos públicamente conocidos. Referencias: [OWASP Security Questions](https://cheatsheetseries.owasp.org/cheatsheets/Choosing_and_Using_Security_Questions_Cheat_Sheet.html), [Node.js scrypt](https://nodejs.org/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback).

### Código de recuperación alternativo

Los correos `ealva@afi.com` y `mramirez@afi.com` pueden funcionar como identificadores aunque no tengan buzón. El login ofrece **Olvidé mi contraseña → Recuperar con código**: el usuario escribe su nombre, un código privado y la nueva clave con confirmación. El backend verifica el código antes de actualizar la contraseña en Supabase Auth. El endpoint público `POST /api/v1/auth/password-recovery` no requiere JWT; requiere ese código de 256 bits y admite cinco intentos por IP cada quince minutos.

El propietario del servidor emite los códigos desde esta carpeta:

```powershell
npm.cmd run recovery:issue -- --remote ealva mramirez
```

El comando verifica que los usuarios existan en Supabase, emite un código diferente por cuenta y lo muestra una vez en consola con su vencimiento. Entrega cada código a su propietario. No cambia contraseñas. Cada código vence en treinta minutos; emitir otro invalida los anteriores para esa cuenta. Usarlo lo consume atómicamente antes de contactar a Auth: si la operación externa falla o hace timeout, emite uno nuevo en lugar de reutilizarlo. Las pruebas utilizan Auth simulado y no actualizan cuentas reales.

El almacén de producción solo guarda SHA-256 de los códigos y hashes scrypt con
sal para las respuestas; nunca contraseñas, códigos ni respuestas en claro.
`--remote` emite códigos en Supabase para que funcionen en Vercel. Sin ese flag,
el desarrollo local conserva SQLite en `.data/password-recovery.sqlite`, ignorado
por Git y Docker. No se necesita una variable nueva: Vercel/producción selecciona
automáticamente el almacén compartido con las claves existentes del backend.

Para conservar preguntas de una instalación local anterior, el administrador
puede ejecutar `npm.cmd run recovery:migrate`. Solo copia hashes, sales y la
pregunta asociada a su identidad; no sobrescribe preguntas ya existentes en
Supabase ni importa códigos antiguos. La operación requiere autorización para
transferir esos datos locales al proyecto remoto. Si no se importa, cada usuario
puede configurar nuevamente su pregunta con su sesión y contraseña actual o con
un código inicial nuevo emitido con `--remote`.

La service role permanece en el servidor, sin endpoint público de emisión. El usuario elige su contraseña en el navegador y solo se envía al backend para completar esta operación específica de Auth. Las cuentas y movimientos financieros siguen protegidos por sus permisos y RLS originales. Referencia: [Supabase Admin updateUserById](https://supabase.com/docs/reference/javascript/auth-admin-updateuserbyid).

## Supabase

### SQL único con usuarios iniciales

Abre [`supabase/afi_instalacion_completa.sql`](supabase/afi_instalacion_completa.sql) y ejecuta el archivo completo en Supabase SQL Editor con rol `postgres`, sin reemplazar contraseñas. Para cada usuario nuevo genera una contraseña aleatoria de 36 caracteres y la devuelve en la columna `contrasena_inicial` del resultado final. Copia esas contraseñas al terminar: solo se muestran durante la creación. Si prefieres establecer una propia, sustituye su `null` inicial por un literal SQL de al menos 12 caracteres y como máximo 72 bytes.

El archivo incluye las nueve migraciones para una instalación nueva. Si AFI ya está instalado, comprueba las tablas y RLS existentes y aplica también las migraciones 008 y 009, conservando los datos financieros. Una instalación parcial se detiene y señala que hay que aplicar las migraciones pendientes. Todo se ejecuta en una sola transacción.

Se crean estos usuarios nuevos con correo confirmado, hash bcrypt e identidad de proveedor email:

| Usuario de login | Correo de Auth | Nombre |
| --- | --- | --- |
| mramirez | mramirez@afi.com | Marines Ramirez Rodriguez |
| ealva | ealva@afi.com | Eloy Gonzalo Alva Calderon |

Se inicializan perfil PEN/America-Lima, preferencias, notificaciones, cuota de IA, siete categorías y una cuenta Efectivo con saldo cero por persona. Las demás tablas quedan creadas para registrar sus datos financieros reales desde la aplicación. Las finanzas personales permanecen separadas; los espacios compartidos se crean mediante el flujo de invitación.

Repetir el script no duplica usuarios, identidades ni cuentas de configuración inicial. Conserva contraseñas y estado de confirmación de usuarios existentes; esos usuarios deben ingresar con su contraseña actual y reciben `null` en `contrasena_inicial`. Las contraseñas nuevas solo se guardan como hash bcrypt en Auth. El resultado final extrae y elimina los valores en claro de la tabla temporal. Si solo necesitas sembrar usuarios sobre una instalación completa, usa [`supabase/seeds/initial_users.sql`](supabase/seeds/initial_users.sql), con el mismo comportamiento automático.

`npm run sql:bundle` regenera el archivo completo desde las migraciones y el seed. La creación SQL de Auth depende del esquema administrado por Supabase; si cambia su versión, revisa el archivo frente a [su documentación de identidades](https://supabase.com/docs/guides/auth/identities). Este script se ha verificado con PostgreSQL embebido y un esquema Auth representativo; no se ha ejecutado contra tu proyecto remoto ni probado el servicio GoTrue real.

En SQL Editor aplica los archivos de `supabase/migrations/` en orden numérico, una sola vez, a una base nueva. Cada archivo es transaccional. No se eliminan tablas existentes ni se aplican migraciones automáticamente al arrancar. Revisa y adapta las migraciones si ya existe un esquema con esos nombres.

1. `001_schema.sql`: entidades, índices, bootstrap de usuarios, RLS y permisos de lectura.
2. `002_operations.sql`: operaciones financieras, recurrencias, ahorro, invitaciones y recordatorios.
3. `003_ai.sql`: reservas de consumo y borradores con confirmación.
4. `004_editing_and_statements.sql`: edición auditada, estados bancarios y calendario de préstamos.
5. `005_payment_applications.sql`: aplicación de pagos a vencimientos sin duplicar el movimiento.
6. `006_savings_distribution.sql`: distribución y reasignación atómicas.
7. `007_shared_member_names.sql`: nombres visibles de participantes, limitados a sus espacios.

El trigger de usuarios crea perfil, preferencias y categorías al registrarse. Aplica las migraciones **antes** de crear usuarios. Para usuarios anteriores, se necesita un backfill revisado de perfiles y preferencias.

En Supabase Auth:

- Habilita Email/Password y confirmación de correo.
- Site URL: `http://localhost:3000` en desarrollo y el dominio real en producción.
- Añade esos orígenes con sus rutas de callback a Redirect URLs.
- Configura SMTP para correos de registro y recuperación en producción.
- No desactives RLS. Los clientes tienen SELECT autorizado por RLS y ejecutan RPC estrechas para escribir. Las RPC verifican `auth.uid()`, claves compuestas y membresías; no aceptan propietarios arbitrarios.

Los enlaces de invitación se generan para compartirlos manualmente; no se envían correos desde AFI. El token de 256 bits se muestra una vez y solo se almacena su SHA-256. Expira en siete días, puede revocarse y exige el correo del JWT del destinatario.

## API

- Salud: `GET /health` (no consulta secretos ni asegura conectividad de BD).
- Documentación: `/docs`; especificación JSON: `/docs/json`.
- Especificación incluida: `openapi.json`; para regenerarla: `npm run docs:generate`.
- Recursos: `/api/v1/accounts`, `categories`, `transactions`, `cards`, `purchases`, `statements`, `debts`, `obligations`, `occurrences`, `budgets`, `goals`, `spaces`, `members`, `invitations`, `allocations`, `plans`, `payments`, `notifications`, `profile`, `preferences`, `ai-usage`.
- Listas: `page` y `limit` (máximo 100), con filtros de moneda en recursos compatibles. Movimientos: `from`, `to` (fechas UTC), `type`, `search`.
- Dashboard: `GET /api/v1/dashboard?currency=PEN&month=2026-11`, usando la zona horaria del perfil.
- CSV: `GET /api/v1/export/transactions.csv` (historial autorizado completo, con protección frente a fórmulas).
- Movimientos: `POST /transactions`, `PUT /transactions/:id`, `POST /transactions/:id/void`.
- Configuración: `POST /:resource`, `PATCH /:resource/:id` para recursos admitidos. El esquema OpenAPI enumera los campos editables. El saldo inicial, moneda y términos del préstamo son inmutables después de crearlos.
- Generación de vencimientos: `POST /occurrences/generate`, cuerpo `{ "from":"2026-11-01", "to":"2026-11-30" }`.
- Préstamos: `POST /debts/:id/schedule` sincroniza el cronograma sin duplicados. También se ejecuta al crear el préstamo.
- Ahorro: `/savings/distribute` y `/savings/reallocate`, además de `/allocations` y `/plans`.
- Espacios: `/spaces/:id/invitations`, `/spaces/:id/manage`; aceptación/rechazo en `/invitations/respond`; porcentajes en `PUT /goals/:id/members`.
- Alertas: `/notifications/refresh`, `/notifications/:id/read`.
- IA: `/ai/interpret`, `/ai/drafts`, `/ai/drafts/:id/confirm`.
- Recuperación de confirmaciones pendientes: `GET /ai/drafts/:id` devuelve solo el borrador propio y su estado, autorizado por JWT y RLS. El frontend reutiliza la clave de idempotencia al reintentar y no confirma automáticamente un borrador no registrado.

Todas las rutas financieras `/api/v1` requieren `Authorization: Bearer <access_token>`. Las rutas de recuperación `/api/v1/auth/*` utilizan sus pruebas de identidad específicas (código, respuesta o sesión y clave actual al configurar). Las escrituras financieras requieren además `Idempotency-Key: <UUID>`. Conserva la misma clave y cuerpo al reintentar una operación después de un timeout. Si cambia el cuerpo, usa una clave nueva. El mismo cuerpo/clave retorna el resultado anterior; un cuerpo distinto con la misma clave se rechaza.

Errores: `{ "error": { "code":"...", "message":"...", "requestId":"...", "details":[] } }`. CORS está restringido a los orígenes configurados. Límite general: 120 solicitudes/minuto por IP; IA: 10/minuto por IP. Detrás de un proxy configura correctamente la capa de red antes de confiar en cabeceras reenviadas; el servidor no activa `trustProxy` indiscriminadamente. Los límites HTTP son en memoria por instancia; el presupuesto y cuotas de IA son globales en PostgreSQL.

## Reglas financieras

- Dinero en PostgreSQL: `NUMERIC(18,2)`; cálculos de API: Decimal.js. La API admite hasta 999999999999 unidades y dos decimales. UUID y `TIMESTAMPTZ` para identidad/tiempo. Nunca se suman monedas distintas ni se hace conversión implícita.
- Saldos = saldo inicial + entradas de movimientos vigentes. El saldo inicial no es ingreso. Las transferencias tienen dos entradas y efecto neto cero.
- No se permite sobregirar una cuenta ni gastar el fondo reservado. Un ajuste manual de salida es explícito y auditado; para una corrección de entrada usa un ingreso identificado como corrección.
- Compras de tarjeta generan gasto al comprar, incluyendo cuotas, intereses y comisiones. Devoluciones reducen gasto y deuda. Pagar la tarjeta reduce efectivo y deuda; no crea otro gasto. Las cuotas reparten centavos de forma exacta. La deuda inicial no genera gasto nuevo.
- El estado de cuenta bancario se registra manualmente: total facturado, mínimo, cierre y vencimiento. No se inventa un pago mínimo con una fórmula universal. Genera su propio vencimiento. El pago mínimo reduce el pendiente, sin cancelar el resto de la deuda.
- Los préstamos usan **capital constante e interés nominal anual sobre saldo**. El saldo mostrado incluye intereses programados. No es un motor de TCEA, seguro de desgravamen, intereses moratorios o refinanciamiento. Los abonos extraordinarios reducen el saldo y se aplican al calendario; **no recalculan intereses futuros ni simulan el contrato del banco**.
- Los abonos de préstamo cubren primero el interés pendiente de cada cuota y luego su capital. El interés aplicado se registra como gasto del período, el capital no. El desglose usa el cronograma de AFI; compara sus condiciones con el contrato antes de usarlo como reporte contable.
- Pagos sin vencimiento explícito se aplican a vencimientos existentes de la tarjeta/préstamo, en orden de fecha. Los pagos registrados antes de crear esos vencimientos no se reaplican retrospectivamente; registra primero el estado o cronograma para conservar su conciliación.
- Cada recurrencia conserva su ancla original (31 → 28/29 → 31), tiene un período único y abonos propios. Cambiar una obligación afecta generaciones futuras; edita el vencimiento para modificar un período existente.
- Reservar ahorro no vuelve a gastar el dinero ni cambia saldos bancarios. Una asignación cambia su destino, no lo duplica. Solo aportes confirmados incrementan metas. Los planes admiten cero y nunca crean deuda. Libera asignaciones antes de retirar la reserva. La distribución trunca centavos por meta y conserva el remanente sin asignar.
- Las alertas se generan por reglas 7/3/1/0 días antes y diariamente para vencidos, en la zona del usuario. La interfaz genera el período seleccionado y refresca las alertas al cargar. No se requiere IA. Para alertas mientras nadie abre la aplicación hace falta un job programado; no hay envío externo implementado.

## IA opcional

Prueba operativa para el administrador: `npm run ai:check -- ealva`. Verifica una interpretación sintética, reserva presupuesto y contabiliza una interacción en ese usuario. No inicia sesión como él, no consulta sus cuentas ni crea movimientos financieros. Requiere IA habilitada, configuración completa y acceso a Supabase/OpenAI. El resultado muestra modelo, tokens y costo estimado sin exponer claves.

Con `AI_ENABLED=false` no hay llamadas a proveedores. En la configuración mínima basta `AI_API_KEY`: modelo, URL, timeout y precios verificados se leen de `src/defaults.ts`. Solo al cambiar modelo o endpoint debes configurar sus **precios reales** (`AI_INPUT_USD_PER_MILLION`, `AI_OUTPUT_USD_PER_MILLION`). Falta de configuración o de cuota mantiene disponible el registro manual.

El proveedor inicial utiliza Chat Completions con salida textual JSON validada por Zod. No exige tools ni `response_format` al proveedor. `AI_TOKEN_PARAMETER` selecciona `max_completion_tokens` (predeterminado) o `max_tokens` para proveedores con el contrato anterior. La interfaz `AIProvider` permite adaptar otro protocolo. Un modelo que no admita Chat Completions requiere un adaptador; no se declara compatibilidad universal. Contrato revisado con [OpenAI Docs](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create).

El mensaje se interpreta en un esquema cerrado de ingreso/gasto, usando únicamente categorías y cuentas existentes. Campos ambiguos o faltantes se completan en el formulario. Se guarda un borrador revisado y se confirma en un endpoint separado con `confirmed:true`; el modelo nunca recibe herramientas de escritura ni SQL.

El consumo UTC mensual se reserva bajo un bloqueo global **antes** de llamar al proveedor. El límite de entrada usa bytes UTF-8 como cota conservadora de tokens, incluyendo contexto; el límite de salida es configurable. El presupuesto retiene la cota máxima reservada incluso en fallos/timeouts para no liberar gasto potencialmente facturado. Por eso la estimación puede superar el costo real. Registra tokens devueltos por el proveedor. No es un sistema de facturación al cliente. La disponibilidad efectiva de IA depende también del proveedor y del número/tamaño de cuentas y categorías en contexto.

## Pruebas y producción

```powershell
npm.cmd test
npm.cmd run test:db
npm.cmd run build
npm.cmd start
```

Las pruebas de base usan PGlite con pgcrypto, migraciones íntegras y roles anon/authenticated/service_role. Prueban RLS, propiedad de claves foráneas, idempotencia, reversión atómica, pagos parciales, recurrencias bisiestas, cuotas exactas, fondo, distribución, reasignaciones, invitaciones, roles, confirmación y cuotas de IA. Auth se simula con claims; aún se debe validar JWT/correos contra Supabase real. PGlite usa una sola conexión; se necesita una prueba multi-conexión en staging para medir contención y carreras reales.

Vercel utiliza la función `api/index.ts` y la configuración incluida en `vercel.json`. También puedes desplegar en un servicio Node.js: `npm ci`, `npm run build`, `npm start`, salud `/health`, puerto `$PORT`. La recuperación en producción se guarda en Supabase mediante la migración 009. Configura las variables como secretos en el proveedor y `FRONTEND_URL` con el dominio del frontend. Usa HTTPS, backups Supabase y conserva los logs estructurados. No publiques `.env`.

Incluye Dockerfile opcional. La imagen requiere que la plataforma inyecte variables al arrancar; no incorpora secretos.

Referencias de implementación: [RLS de Supabase](https://supabase.com/docs/guides/database/postgres/row-level-security), [Next.js](https://nextjs.org/docs/app/getting-started/installation).

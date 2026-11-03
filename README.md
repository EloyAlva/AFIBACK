# AFI Backend

## Rutas y despliegue en Vercel

Compatibilidad de dependencias: `@fastify/static` usa `require()` para cargar
`content-disposition`. Se fija esa dependencia transitiva a `2.0.1` (CommonJS,
con la API `create`), conservando Swagger UI 6.1.2 y Static 10.1.8.
La versión 3 es ESM y puede provocar `ERR_REQUIRE_ESM` en el cargador de Vercel.
No elimines el override sin ejecutar la prueba de compatibilidad del runtime.
El archivo lock debe instalarse con `npm ci` en cada despliegue.

El preset se declara como `fastify` en `vercel.json`. El único punto de entrada
es `src/server.ts`, que construye y arranca el servidor. `src/application.ts`
contiene la fábrica utilizada por las pruebas y no es un punto de entrada.
La raíz `/` devuelve información de AFIBACK; `/health` comprueba el proceso.

En Vercel importa este repositorio como proyecto independiente, con Root Directory
en la raíz, preset Fastify y sin un Output Directory estático personalizado como
`dist`. Instala con `npm ci` y compila con `npm run build`. Usa Node.js 24.x.
El frontend debe apuntar al dominio **estable de producción** del backend,
seguido de `/api/v1`; no a la URL del panel `vercel.com/...` ni a una URL temporal
de despliegue protegida por Vercel Authentication.

Las peticiones entre proyectos necesitan un dominio accesible al navegador:
Vercel Authentication en el backend puede redirigirlas al login de Vercel antes
de llegar a Fastify. Revisa Deployment Protection del dominio de producción.
Esto es independiente de los JWT de AFI, que siguen siendo obligatorios para
los datos personales y las operaciones financieras.

El preset permite servir la API y Auth en Vercel Functions. La recuperación con
preguntas/códigos todavía requiere almacenamiento persistente; el archivo SQLite
local no se conserva entre instancias o despliegues de Vercel. No configures una
ruta temporal `/tmp` como sustituto de almacenamiento persistente de recuperación.

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

El servicio sigue requiriendo Node.js y almacenamiento persistente para los códigos
y preguntas de recuperación; centralizar Auth no convierte SQLite en almacenamiento
persistente de Vercel Functions. El frontend sí se puede alojar en Vercel.

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
npm.cmd run recovery:issue -- ealva mramirez
```

El comando verifica que los usuarios existan en Supabase, emite un código diferente por cuenta y lo muestra una vez en consola con su vencimiento. Entrega cada código a su propietario. No cambia contraseñas. Cada código vence en treinta minutos; emitir otro invalida los anteriores para esa cuenta. Usarlo lo consume atómicamente antes de contactar a Auth: si la operación externa falla o hace timeout, emite uno nuevo en lugar de reutilizarlo. Las pruebas utilizan Auth simulado y no actualizan cuentas reales.

El almacén privado local solo guarda SHA-256, usuario, vencimiento y consumo en SQLite; no guarda contraseñas ni códigos en claro. Ubicación: `.data/password-recovery.sqlite`, ignorada por Git y Docker. Requiere Node.js >=22.13. Conserva ese directorio en un volumen persistente y ejecuta la CLI con el mismo `RECOVERY_DATABASE_PATH` que la API. Esta implementación está orientada a una única instancia Node.js: para réplicas en hosts distintos, sustituye este almacén por una base compartida con consumo atómico antes de habilitar esta recuperación. En Docker monta un volumen escribible para el usuario `node`; el archivo no se incorpora a la imagen.

La service role permanece en el servidor, sin endpoint público de emisión. El usuario elige su contraseña en el navegador y solo se envía al backend para completar esta operación específica de Auth. Las cuentas y movimientos financieros siguen protegidos por sus permisos y RLS originales. Referencia: [Supabase Admin updateUserById](https://supabase.com/docs/reference/javascript/auth-admin-updateuserbyid).

## Supabase

### SQL único con usuarios iniciales

Abre [`supabase/afi_instalacion_completa.sql`](supabase/afi_instalacion_completa.sql) y ejecuta el archivo completo en Supabase SQL Editor con rol `postgres`, sin reemplazar contraseñas. Para cada usuario nuevo genera una contraseña aleatoria de 36 caracteres y la devuelve en la columna `contrasena_inicial` del resultado final. Copia esas contraseñas al terminar: solo se muestran durante la creación. Si prefieres establecer una propia, sustituye su `null` inicial por un literal SQL de al menos 12 caracteres y como máximo 72 bytes.

El archivo incluye las siete migraciones para una instalación nueva. Si AFI ya está instalado, comprueba que estén las tablas y RLS y conserva el esquema y los datos existentes. Una instalación parcial se detiene y señala que hay que aplicar las migraciones pendientes. Todo se ejecuta en una sola transacción.

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

Con `AI_ENABLED=false` no hay llamadas a proveedores. Para habilitarla completa key, modelo, URL, timeout y los **precios reales** del modelo (`AI_INPUT_USD_PER_MILLION`, `AI_OUTPUT_USD_PER_MILLION`). No se codifican precios supuestos. Falta de configuración o de cuota mantiene disponible el registro manual.

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

Despliega este repositorio por separado en un servicio Node.js persistente: `npm ci`, `npm run build`, `npm start`, salud `/health`, puerto `$PORT`. Configura las variables como secretos en el proveedor y `FRONTEND_URL` con el dominio Vercel. Usa HTTPS, backups Supabase y conserva los logs estructurados. No publiques `.env`.

Incluye Dockerfile opcional. La imagen requiere que la plataforma inyecte variables al arrancar; no incorpora secretos.

Referencias de implementación: [RLS de Supabase](https://supabase.com/docs/guides/database/postgres/row-level-security), [Next.js](https://nextjs.org/docs/app/getting-started/installation).

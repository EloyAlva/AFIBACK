# Planificador de ahorro

Implementación: `src/planning.ts`, rutas `src/planner-routes.ts` y migración `012_financial_planner.sql`. No usa modelos de IA ni ejecuta transferencias.

## Datos y privacidad

La jerarquía es espacio → objetivos → responsabilidades → planes mensuales → aportes confirmados. Los objetivos personales tienen responsabilidad del 100%. En un objetivo compartido, la responsabilidad debe configurarse explícitamente y sumar 100%; si falta, el motor no inventa un reparto. El importe pertenece al objetivo. El espacio solo consolida objetivos de la misma moneda, sin sumar sus planes al dinero confirmado.

`savings_planner_budgets` contiene ingreso previsto, porcentaje deseado, máximo mensual y gastos esenciales previstos, por usuario, moneda y mes. RLS solo permite leerlos a su propietario; las escrituras derivan la identidad del JWT. Una configuración se mantiene para meses posteriores hasta el próximo cambio. Sin configuración manual se usan los ingresos registrados de cada mes; no se inventan salarios futuros.

Los planes tienen `share_authorized=false` de forma predeterminada. La migración vuelve privados los planes existentes. El propietario debe autorizar compartir cada plan mensual; puede revocar esa autorización. Las consultas de espacios nunca incluyen ingresos, cuentas, gastos, capacidad privada ni planes compartidos sin autorización, incluso para administradores. El presupuesto, los planes, los aportes y los cambios de objetivo tienen auditoría. Los importes de ingresos no se copian al registro de auditoría del presupuesto.

## Presupuestos mensuales

Todos los cálculos de asignación usan centavos enteros; los límites de entrada son los mismos de la API financiera. Para cada período:

1. Ahorro deseado = ingreso previsto × porcentaje elegido. El porcentaje es configurable entre 0 y 100; el valor inicial no es una recomendación universal.
2. Capacidad por ingresos = ingreso − máximo(gastos esenciales previstos, gastos registrados del mes actual) − obligaciones pendientes.
3. En el mes actual también se limita por liquidez real: saldo disponible más fondo sin asignar, menos obligaciones y gastos esenciales aún no cubiertos. El dinero ya asignado a objetivos no vuelve a estar disponible.
4. El presupuesto recomendado es el menor del ahorro deseado, máximo personal y capacidad financiera; se descuentan los aportes ya confirmados del mes.

Las obligaciones recurrentes se proyectan sin crear movimientos ni vencimientos en la base de datos. Los vencimientos ya generados no se vuelven a sumar. Se consideran cuotas de tarjetas cuando no existe un estado de cuenta que ya las represente. Los gastos esenciales deben ingresarse sin incluir obligaciones configuradas por separado. Las cuentas, los fondos y las obligaciones se separan por moneda.

La planificación es mensual: supone disponibilidad del presupuesto antes de los vencimientos de cada mes. No conoce fechas futuras de cobro ni garantiza ingresos. El horizonte máximo es de 600 meses; una respuesta `horizonLimited=true` hace explícito que los objetivos posteriores requieren revisión.

## Responsabilidad pendiente

Para cada participante y objetivo:

`pendiente = mínimo(saldo global del objetivo, máximo(0, meta × responsabilidad − aportes propios confirmados))`.

El déficit acumulado compara planes propios de meses anteriores con los aportes propios realizados hasta la fecha, incluidos los aportes del mes actual que recuperan retrasos. Ya forma parte del saldo que sigue pendiente; no se suma dos veces a la meta. Los aportes por encima del plan reducen el saldo y los importes futuros. Los importes de responsabilidad se redondean mediante mayores restos, con desempate por ID, para que las cuotas sumen exactamente la meta incluso al dividir un centavo. Los objetivos completos reciben cero. Los vencidos conservan su déficit, pero no reciben asignaciones automáticas a fechas pasadas. Los objetivos con inicio futuro no reciben aportes antes de ese mes.

## Asignación por restricciones y vencimientos

Se simulan todos los períodos hasta las fechas límite. En cada mes:

1. Se aplican primero los planes manuales guardados de ese usuario. Son restricciones, incluido un importe cero. Si exceden el presupuesto o el saldo pendiente, se limita la proyección y se devuelve un conflicto explícito; nunca se proyecta dinero inexistente. El total mensual guardado se reduce por los aportes ya confirmados del mismo mes para evitar duplicación.
2. Para cada prefijo de vencimientos se calcula `necesidad actual obligatoria = máximo(0, demanda pendiente de ese prefijo − presupuestos disponibles de los meses posteriores hasta ese vencimiento)`. Se incluyen las necesidades de objetivos con inicio futuro para reservarles capacidad; los compromisos manuales futuros de otros objetivos reducen la capacidad que puede utilizar el prefijo. Los adelantos automáticos tampoco consumen importes ya comprometidos en planes manuales futuros.
3. Esa necesidad se cubre en orden de vencimiento, con prioridad manual e ID como desempates. Si no alcanza, se genera un resultado de mejor esfuerzo y se conserva el déficit visible por objetivo.
4. Si queda presupuesto se cubre la necesidad mensual regular de los objetivos posteriores (`saldo / períodos restantes`, redondeada hacia arriba a centavos). Así reciben aportes cuando las restricciones cercanas dejan margen.
5. El excedente se adelanta por vencimiento, sin superar responsabilidades ni saldos. El resto queda sin asignar.

Para objetivos disponibles desde el primer período y sin restricciones manuales, la factibilidad se comprueba por la demanda acumulada de cada prefijo de vencimientos frente a su presupuesto acumulado. Las pruebas contrastan esta condición en 120 combinaciones, además de casos individuales. Para los planes manuales y fechas de inicio futuras, la viabilidad se informa según el calendario completo efectivamente simulado, nunca solo con una ponderación de urgencia.

La salida conserva exactamente `presupuesto = asignado + sin asignar` en centavos. No hay porcentajes fijos de producción. Los porcentajes que muestra el formulario de reparto se derivan de los importes calculados por el backend; cualquier centavo que no pueda representarse con dos decimales de porcentaje permanece sin asignar en el fondo.

Cambiar ingresos, límites, fechas, metas, prioridades, responsabilidades, planes o aportes vuelve a construir el calendario en la siguiente consulta. La redistribución es una recomendación hasta que el usuario la guarda o confirma un aporte real.

## Indicadores

Cada objetivo distingue progreso financiero de tiempo transcurrido. Incluye saldo, meses/días restantes, necesidad mensual, ahorro esperado a la fecha desde `start_date`, diferencia, estado y proyección con planes visibles. Las metas anteriores a esta migración reciben como inicio la primera fecha conocida de aporte o la fecha de migración, sin superar su vencimiento; ese inicio se puede corregir editando el objetivo.

La viabilidad personal del planificador solo evalúa la responsabilidad del usuario. No afirma que otros participantes tendrán capacidad para aportar. La proyección global utiliza exclusivamente planes autorizados y declara `unknown` si no hay información suficiente, `shortfall` si el plan no cubre la meta, `planned` si los planes la cubren, `overdue` si venció o `completed` si existen aportes suficientes. Un plan cubierto no es dinero confirmado ni una garantía.

El espacio suma las metas y aportes una sola vez, sin mezclar monedas. Su avance global es confirmado / suma de metas. Muestra cantidad, completados, objetivos en riesgo o sin plan suficiente, requerido mensual, plan autorizado mensual y aportes confirmados del mes. Las asignaciones del fondo se cuentan como aportes al objetivo, sin volver a registrarlas como ingreso o reserva nueva.

Las fechas de aportes y los límites mensuales se interpretan en la zona horaria del perfil. Las consultas de recomendaciones comienzan en el mes actual si se selecciona un mes pasado; el resumen compartido permite consultar los planes y aportes de otros meses.

## API

- `GET /api/v1/savings/planner?currency=PEN&month=2027-01`: calendario privado, presupuestos, responsabilidades, déficit, proyecciones y conflictos. `fund_amount` opcional solicita una sugerencia para asignar un importe del fondo existente, respetando su saldo y los compromisos esenciales.
- `PUT /api/v1/savings/planner/budget`: `{currency,month:"2027-01-01",monthly_income,savings_percentage,maximum_savings,essential_expenses}`. Solo configuración privada.
- `PUT /api/v1/savings/planner/plans`: `{entries:[{goal_id,month:"2027-01-01",amount,share_authorized}]}`. Guarda únicamente planes propios de forma atómica. No acepta identidad de otro usuario.
- `GET /api/v1/savings/overview?currency=PEN&month=2027-01`: resumen compartido sin datos financieros privados.

Los aportes reales siguen utilizando las rutas existentes y claves de idempotencia. La migración impide aportar por encima del saldo global, serializa las asignaciones por objetivo y conserva el orden de bloqueo en repartos y reasignaciones. La confirmación se realiza desde el formulario de aporte, nunca al guardar un presupuesto o una planificación.

## Verificación

`test/planning.test.ts` cubre restricciones, presupuestos, prioridades, fechas, responsabilidades, aportes, redistribución, redondeo y proyecciones compartidas. `test/database.test.ts` verifica migraciones PostgreSQL, RLS, autorización de planes revocable, auditoría, aportes propios, idempotencia y límites. Las pruebas de Playwright del frontend verifican consulta al motor, edición de planes, autorización de compartir y ausencia de movimientos al guardar una planificación. Los escenarios de navegador usan datos simulados; no sustituyen una validación contra el Supabase desplegado.

import test from "node:test";
import assert from "node:assert/strict";
import {
  allocateTimeline,
  buildPlanner,
  cents,
  consolidateSpaces,
  goalMetrics,
  type PlanningGoal,
} from "../src/planning.js";
import { sharedOverview } from "../src/planner-routes.js";
import type { Row } from "../src/finance.js";
import { responsibilityTargets } from "../src/goal-shares.js";

test("Las responsabilidades conservan el importe exacto incluso al dividir un centavo", () => {
  const result = responsibilityTargets(0.01, [
    { user_id: "a", percentage: 50 },
    { user_id: "b", percentage: 50 },
  ]);
  assert.deepEqual(
    result.map((m) => m.target_amount),
    [0.01, 0],
  );
  assert.equal(
    result.reduce((s, m) => s + cents(m.target_amount), 0),
    1,
  );
  assert.deepEqual(
    responsibilityTargets(100, [{ user_id: "a", percentage: 60 }]),
    [],
  );
});

const budget = (amount: number, count = 3) =>
  Array.from({ length: count }, (_, i) => ({
    month: `2027-${String(i + 1).padStart(2, "0")}`,
    amount,
  }));
const goal = (
  id: string,
  remaining: number,
  deadline = "2027-03-31",
  priority = 2,
): PlanningGoal => ({ id, remaining, deadline, priority });
function invariant(
  result: ReturnType<typeof allocateTimeline>,
  goals: PlanningGoal[],
) {
  const assigned: Record<string, number> = {};
  for (const m of result.schedule) {
    const sum = m.allocations.reduce((s, a) => s + cents(a.amount), 0);
    assert.equal(sum + cents(m.unassigned), cents(m.budget));
    for (const a of m.allocations) {
      assert.ok(a.amount > 0);
      assert.ok(
        goals.find((g) => g.id === a.goal_id)!.deadline.slice(0, 7) >= m.month,
      );
      assigned[a.goal_id] = (assigned[a.goal_id] ?? 0) + cents(a.amount);
    }
  }
  for (const g of goals) {
    assert.ok((assigned[g.id] ?? 0) <= cents(g.remaining));
    assert.equal(
      (assigned[g.id] ?? 0) +
        cents(result.goals.find((r) => r.id === g.id)!.deficit),
      cents(g.remaining),
    );
  }
}

test("Un objetivo, presupuesto suficiente, cero, insuficiente y saldo completado", () => {
  for (const amount of [0, 20, 100, 1000]) {
    const goals = [goal("a", 100), goal("completed", 0)];
    const result = allocateTimeline(goals, budget(amount));
    invariant(result, goals);
    assert.equal(
      result.goals.find((g) => g.id === "a")!.deficit,
      Math.max(0, 100 - amount * 3),
    );
    assert.equal(
      result.schedule
        .flatMap((m) => m.allocations)
        .some((a) => a.goal_id === "completed"),
      false,
    );
  }
});

test("Las restricciones de vencimiento protegen lo urgente y permiten aportar a lo futuro con margen", () => {
  const goals = [goal("viaje", 100, "2027-01-31"), goal("boda", 200)];
  const result = allocateTimeline(goals, budget(100));
  invariant(result, goals);
  assert.deepEqual(result.schedule[0].allocations, [
    { goal_id: "viaje", amount: 100 },
  ]);
  assert.ok(result.goals.every((g) => g.feasible));
  const roomy = allocateTimeline(
    [goal("viaje", 50, "2027-01-31"), goal("boda", 200)],
    budget(100),
  );
  assert.ok(
    roomy.schedule[0].allocations.some(
      (a) => a.goal_id === "boda" && a.amount > 0,
    ),
  );
});

test("Fechas iguales usan prioridad manual y luego ID; resultado independiente del orden de entrada", () => {
  const goals = [
    goal("b", 100, "2027-01-31", 3),
    goal("a", 100, "2027-01-31", 1),
  ];
  const result = allocateTimeline(goals, budget(100, 1));
  assert.deepEqual(
    result,
    allocateTimeline([...goals].reverse(), budget(100, 1)),
  );
  assert.equal(result.goals.find((g) => g.id === "a")!.deficit, 0);
  assert.equal(result.goals.find((g) => g.id === "b")!.deficit, 100);
});

test("Vencidos y objetivos futuros no reciben aportes fuera de su período", () => {
  const result = allocateTimeline(
    [
      goal("old", 100, "2026-12-31"),
      { ...goal("future", 100), start_date: "2027-03-01" },
    ],
    budget(100),
  );
  assert.equal(result.goals.find((g) => g.id === "old")!.deficit, 100);
  assert.equal(result.schedule[0].assigned, 0);
  assert.equal(result.schedule[2].assigned, 100);
});

test("Las restricciones reservan espacio para objetivos que comienzan después", () => {
  const goals = [
    goal("a", 100, "2027-02-28"),
    { ...goal("b", 100, "2027-02-28"), start_date: "2027-02-01" },
    goal("c", 100),
  ];
  const result = allocateTimeline(goals, budget(100));
  invariant(result, goals);
  assert.ok(result.goals.every((g) => g.feasible));
  assert.deepEqual(result.schedule[0].allocations, [
    { goal_id: "a", amount: 100 },
  ]);
});

test("Los adelantos automáticos no consumen cuotas ya comprometidas en un plan futuro", () => {
  const goals = [goal("a", 100, "2027-02-28"), goal("b", 100)];
  const result = allocateTimeline(goals, budget(100), [
    { goal_id: "b", month: "2027-02", amount: 100 },
  ]);
  invariant(result, goals);
  assert.ok(result.goals.every((g) => g.feasible));
  assert.equal(result.conflicts.length, 0);
  assert.deepEqual(result.schedule[1].allocations, [
    { goal_id: "b", amount: 100 },
  ]);
});

test("Redondeos conservan centavos y el sobrante se redistribuye sin superar metas", () => {
  const goals = [goal("a", 0.03), goal("b", 0.02), goal("c", 1)];
  const result = allocateTimeline(goals, budget(0.07));
  invariant(result, goals);
  assert.ok(result.schedule[1].allocations.every((a) => a.goal_id === "c"));
});

test("Planes manuales, incluso cero, se respetan y los conflictos se hacen explícitos", () => {
  const goals = [goal("a", 100), goal("b", 100)];
  const result = allocateTimeline(goals, budget(100), [
    { goal_id: "a", month: "2027-01", amount: 0 },
    { goal_id: "b", month: "2027-02", amount: 500 },
  ]);
  invariant(result, goals);
  assert.equal(
    result.schedule[0].allocations.some((a) => a.goal_id === "a"),
    false,
  );
  assert.ok(result.conflicts.length > 0);
});

test("Las combinaciones de objetivos conservan dinero y cumplen los casos factibles por prefijos", () => {
  for (let seed = 1; seed <= 120; seed++) {
    const goals = Array.from({ length: 1 + (seed % 7) }, (_, i) =>
      goal(
        String(i),
        ((seed * 17 + i * 23) % 19000) / 100,
        `2027-0${1 + ((seed + i) % 3)}-28`,
        1 + (i % 3),
      ),
    );
    const budgets = budget(((seed * 31) % 18000) / 100);
    const result = allocateTimeline(goals, budgets);
    invariant(result, goals);
    const possible = ["2027-01", "2027-02", "2027-03"].every(
      (m) =>
        goals
          .filter((g) => g.deadline.slice(0, 7) <= m)
          .reduce((s, g) => s + cents(g.remaining), 0) <=
        budgets
          .filter((b) => b.month <= m)
          .reduce((s, b) => s + cents(b.amount), 0),
    );
    if (possible)
      assert.ok(
        result.goals.every((g) => g.feasible),
        `semilla ${seed}`,
      );
  }
});

const fixture = (): Record<string, Row[]> => ({
  accounts: [{ id: "account", opening_balance: 3000, currency: "PEN" }],
  "planner-budgets": [
    {
      month: "2027-01-01",
      currency: "PEN",
      monthly_income: 3000,
      savings_percentage: 20,
      maximum_savings: 600,
      essential_expenses: 1000,
    },
  ],
  goals: [
    {
      id: "a",
      space_id: "space",
      name: "Viaje",
      ideal_amount: 1200,
      start_date: "2027-01-01",
      target_date: "2027-03-31",
      priority: 2,
      currency: "PEN",
    },
  ],
  "goal-members": [
    { goal_id: "a", user_id: "u", percentage: 50 },
    { goal_id: "a", user_id: "v", percentage: 50 },
  ],
});
test("Responsabilidades, aportes inferiores/superiores al plan y cambios de meta o fecha recalculan la necesidad", () => {
  const data = fixture();
  data.plans = [
    { user_id: "u", goal_id: "a", month: "2026-12-01", amount: 200 },
  ];
  data.allocations = [
    {
      user_id: "u",
      goal_id: "a",
      amount: 100,
      created_at: "2026-12-20T12:00:00Z",
    },
    {
      user_id: "v",
      goal_id: "a",
      amount: 200,
      created_at: "2026-12-20T12:00:00Z",
    },
  ];
  let plan = buildPlanner(
    data,
    "PEN",
    "2027-01",
    "u",
    "America/Lima",
    "2027-01-05",
  );
  assert.equal(plan.goals[0].target, 600);
  assert.equal(plan.goals[0].remaining, 500);
  assert.equal(plan.goals[0].accumulatedDeficit, 100);
  assert.equal(plan.goals[0].monthlyRequired, 166.67);
  data.allocations[0].amount = 300;
  plan = buildPlanner(
    data,
    "PEN",
    "2027-01",
    "u",
    "America/Lima",
    "2027-01-05",
  );
  assert.equal(plan.goals[0].monthlyRequired, 100);
  assert.equal(plan.goals[0].accumulatedDeficit, 0);
  data.goals[0].ideal_amount = 1800;
  data.goals[0].target_date = "2027-02-28";
  plan = buildPlanner(
    data,
    "PEN",
    "2027-01",
    "u",
    "America/Lima",
    "2027-01-05",
  );
  assert.equal(plan.goals[0].monthlyRequired, 300);
});

test("Gastos esenciales, obligaciones recurrentes no generadas y cambios mensuales limitan el presupuesto", () => {
  const data = fixture();
  data.obligations = [
    {
      id: "rent",
      active: true,
      currency: "PEN",
      frequency: "monthly",
      start_date: "2026-12-31",
      amount: 1800,
    },
  ];
  let plan = buildPlanner(
    data,
    "PEN",
    "2027-01",
    "u",
    "America/Lima",
    "2027-01-05",
  );
  assert.equal(plan.budgets[0].amount, 200);
  assert.equal(plan.budgets[1].amount, 200);
  data["planner-budgets"].push({
    ...data["planner-budgets"][0],
    month: "2027-02-01",
    monthly_income: 2000,
  });
  plan = buildPlanner(
    data,
    "PEN",
    "2027-01",
    "u",
    "America/Lima",
    "2027-01-05",
  );
  assert.equal(plan.budgets[1].amount, 0);
  data.accounts[0].opening_balance = 500;
  plan = buildPlanner(
    data,
    "PEN",
    "2027-01",
    "u",
    "America/Lima",
    "2027-01-05",
  );
  assert.equal(plan.budgets[0].amount, 0);
  assert.equal(plan.goals[0].feasible, false);
});

test("Aportes del mes reducen el plan pendiente y no se cuentan dos veces al asignar reservas", () => {
  const data = fixture();
  data.allocations = [
    {
      goal_id: "a",
      user_id: "u",
      amount: 100,
      created_at: "2027-01-03T12:00:00Z",
    },
  ];
  data.plans = [
    { goal_id: "a", user_id: "u", month: "2027-01-01", amount: 200 },
  ];
  data["fund-movements"] = [
    { amount: 300, currency: "PEN", user_id: "u", transaction_id: "t" },
  ];
  const plan = buildPlanner(
    data,
    "PEN",
    "2027-01",
    "u",
    "America/Lima",
    "2027-01-05",
  );
  assert.equal(plan.schedule[0].allocations[0].amount, 100);
  assert.equal(plan.metrics[0].confirmed, 100);
  assert.equal(plan.metrics[0].monthlyConfirmed, 100);
});

test("Avance financiero, tiempo, vencimiento y consolidación se calculan sin duplicaciones ni mezclar monedas", () => {
  const data = fixture();
  const m = goalMetrics(
    data.goals[0],
    [{ goal_id: "a", amount: 300, created_at: "2027-01-02" }],
    [],
    "2027-02-15",
    "2027-02",
  );
  assert.equal(m.progress, 25);
  assert.notEqual(m.progress, m.elapsedPercentage);
  assert.equal(m.viability, "unknown");
  assert.equal(
    goalMetrics(data.goals[0], [], [], "2027-04-01", "2027-04").status,
    "overdue",
  );
  assert.equal(
    goalMetrics(
      data.goals[0],
      [{ goal_id: "a", amount: 1200, created_at: "2027-01-01" }],
      [],
      "2027-04-01",
      "2027-04",
    ).status,
    "completed",
  );
  const spaces = consolidateSpaces([{ id: "space" }], [m], "PEN");
  assert.equal(spaces[0].confirmed, 300);
  assert.equal(spaces[0].target, 1200);
  assert.equal(spaces[0].progress, 25);
});

test("La proyección compartida omite presupuestos, ingresos, cuentas y planes no autorizados", () => {
  const data = fixture();
  data.spaces = [{ id: "space", name: "Familia" }];
  data.goals.push({ ...data.goals[0], id: "usd", currency: "USD" });
  data.plans = [
    {
      id: "private",
      goal_id: "a",
      month: "2027-01-01",
      amount: 444.44,
      share_authorized: false,
    },
    {
      id: "public",
      goal_id: "a",
      month: "2027-02-01",
      amount: 50,
      share_authorized: true,
    },
  ];
  data.plans.push({
    id: "other_currency_private",
    goal_id: "usd",
    month: "2027-01-01",
    amount: 987.65,
    share_authorized: false,
  });
  const overview = sharedOverview(data, "PEN", "2027-01", "2027-01-05");
  assert.equal(overview.plans.length, 1);
  assert.equal(overview.goals[0].monthlyPlanned, 0);
  const serialized = JSON.stringify(overview);
  assert.ok(!serialized.includes("monthly_income"));
  assert.ok(!serialized.includes("444.44"));
  assert.ok(!serialized.includes("account"));
  assert.ok(!serialized.includes("987.65"));
});

test("Los límites del mes respetan la zona horaria y los vencidos del mes actual no reciben sugerencias", () => {
  const data = fixture();
  data.allocations = [
    {
      goal_id: "a",
      user_id: "u",
      amount: 100,
      created_at: "2027-02-01T02:00:00Z",
    },
  ];
  const plan = buildPlanner(
    data,
    "PEN",
    "2027-01",
    "u",
    "America/Lima",
    "2027-01-31",
  );
  assert.equal(plan.budgets[0].confirmed, 100);
  data.goals[0].target_date = "2027-01-15";
  const expired = buildPlanner(
    data,
    "PEN",
    "2027-01",
    "u",
    "America/Lima",
    "2027-01-31",
  );
  assert.equal(expired.schedule[0].assigned, 0);
  assert.equal(expired.goals[0].feasible, false);
});

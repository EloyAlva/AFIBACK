import { Decimal } from "decimal.js";
import { DateTime } from "luxon";
import { summarize, type Row } from "./finance.js";
import { responsibilityTargets } from "./goal-shares.js";

export const cents = (n: unknown) =>
  new Decimal(String(n ?? 0))
    .times(100)
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
    .toNumber();
const cash = (n: number) => n / 100;
const total = (rows: Row[], key = "amount") =>
  rows.reduce((s, r) => s + cents(r[key]), 0);
export const localContributions = (rows: Row[], timezone: string): Row[] =>
  rows.map((a) => ({
    ...a,
    created_at: a.created_at
      ? (DateTime.fromISO(a.created_at).setZone(timezone).toISO() ??
        a.created_at)
      : a.created_at,
  }));
const nextMonth = (m: string, n = 1) =>
  DateTime.fromISO(m + "-01")
    .plus({ months: n })
    .toFormat("yyyy-MM");
const monthCount = (from: string, to: string) =>
  Math.max(
    0,
    Math.round(
      DateTime.fromISO(to.slice(0, 7) + "-01").diff(
        DateTime.fromISO(from + "-01"),
        "months",
      ).months,
    ) + 1,
  );

function commitments(
  data: Record<string, Row[]>,
  summary: Row,
  month: string,
  currency: string,
  currentMonth: string,
) {
  let pending = (summary.occurrences ?? [])
    .filter(
      (o: Row) =>
        o.due_date.startsWith(month) ||
        (month === currentMonth && o.due_date.slice(0, 7) < month),
    )
    .reduce((s: number, o: Row) => s + cents(o.pending), 0);
  for (const o of (data.obligations ?? []).filter(
    (o) =>
      o.active &&
      o.currency === currency &&
      !["debt_schedule", "card_statement"].includes(o.type),
  )) {
    const start = DateTime.fromISO(o.start_date);
    const base = DateTime.fromISO(month + "-01");
    if (
      base.endOf("month").toISODate()! < o.start_date ||
      (o.end_date && month > o.end_date.slice(0, 7))
    )
      continue;
    if (o.frequency === "once" && !o.start_date.startsWith(month)) continue;
    if (o.frequency === "yearly" && base.month !== start.month) continue;
    const due = base
      .set({ day: Math.min(start.day, base.daysInMonth!) })
      .toISODate()!;
    if (o.end_date && due > o.end_date) continue;
    if (
      !(data.occurrences ?? []).some(
        (e) => e.obligation_id === o.id && e.period.startsWith(month),
      )
    )
      pending += cents(o.amount);
  }
  // Do not count statement payments and their underlying instalments twice.
  for (const card of (data.cards ?? []).filter(
    (c) => c.currency === currency,
  )) {
    const hasStatement = (data.occurrences ?? []).some(
      (e) =>
        e.due_date.startsWith(month) &&
        (data.obligations ?? []).some(
          (o) => o.id === e.obligation_id && o.card_id === card.id,
        ),
    );
    if (!hasStatement)
      pending += total(
        (data["card-installments"] ?? []).filter(
          (i) =>
            i.due_date.startsWith(month) &&
            (data.purchases ?? []).some(
              (p) =>
                p.id === i.purchase_id &&
                p.card_id === card.id &&
                p.kind !== "refund",
            ),
        ),
      );
  }
  return pending;
}

export type PlanningGoal = {
  id: string;
  deadline: string;
  remaining: number;
  priority: number;
  start_date?: string;
};
export type PlanningBudget = { month: string; amount: number };

/** Integer-cent deadline constraints, then level monthly needs, then early funding.
 * A deadline prefix must receive now what cannot fit in its remaining future budgets.
 * Explicit manual plans are constraints applied first; conflicts are returned, never hidden.
 */
export function allocateTimeline(
  goals: PlanningGoal[],
  budgets: PlanningBudget[],
  manual: { goal_id: string; month: string; amount: number }[] = [],
) {
  const ordered = [...goals].sort(
    (a, b) =>
      a.deadline.localeCompare(b.deadline) ||
      a.priority - b.priority ||
      a.id.localeCompare(b.id),
  );
  const remaining = new Map(
    ordered.map((g) => [g.id, Math.max(0, cents(g.remaining))]),
  );
  const completion = new Map<string, string>();
  const conflicts: string[] = [];
  const months = [...budgets].sort((a, b) => a.month.localeCompare(b.month));
  const schedule = months.map((budget, index) => {
    let available = Math.max(0, cents(budget.amount));
    const amounts = new Map<string, number>();
    const put = (g: PlanningGoal, requested: number, automatic = true) => {
      const reservedForFuturePlans = automatic
        ? manual
            .filter(
              (p) =>
                p.goal_id === g.id &&
                p.month.slice(0, 7) > budget.month &&
                p.month.slice(0, 7) <= g.deadline.slice(0, 7),
            )
            .reduce((s, p) => s + cents(p.amount), 0)
        : 0;
      const amount = Math.min(
        Math.max(0, requested),
        available,
        Math.max(0, remaining.get(g.id)! - reservedForFuturePlans),
      );
      remaining.set(g.id, remaining.get(g.id)! - amount);
      available -= amount;
      amounts.set(g.id, (amounts.get(g.id) ?? 0) + amount);
      if (amount > 0 && remaining.get(g.id) === 0)
        completion.set(g.id, budget.month);
      return amount;
    };
    const pending = ordered.filter(
      (g) => g.deadline.slice(0, 7) >= budget.month && remaining.get(g.id)! > 0,
    );
    const active = pending.filter(
      (g) => !g.start_date || g.start_date.slice(0, 7) <= budget.month,
    );
    const locks = manual.filter((p) => p.month.slice(0, 7) === budget.month);
    const locked = new Set(locks.map((p) => p.goal_id));
    for (const p of locks.sort(
      (a, b) =>
        ordered.findIndex((g) => g.id === a.goal_id) -
        ordered.findIndex((g) => g.id === b.goal_id),
    )) {
      const g = active.find((g) => g.id === p.goal_id);
      if (!g) {
        if (p.amount > 0)
          conflicts.push(
            `${budget.month}: objetivo ${p.goal_id} completado, vencido o sin responsabilidad pendiente`,
          );
        continue;
      }
      const assigned = put(g, cents(p.amount), false);
      if (assigned < cents(p.amount))
        conflicts.push(
          `${budget.month}: el plan manual de ${p.goal_id} excede presupuesto o saldo pendiente`,
        );
    }
    for (const deadline of [
      ...new Set(pending.map((g) => g.deadline.slice(0, 7))),
    ]) {
      const prefix = pending.filter((g) => g.deadline.slice(0, 7) <= deadline);
      const demand = prefix.reduce((s, g) => s + remaining.get(g.id)!, 0);
      const future = months
        .slice(index + 1)
        .filter((b) => b.month <= deadline)
        .reduce(
          (s, b) =>
            s +
            Math.max(
              0,
              cents(b.amount) -
                manual
                  .filter(
                    (p) =>
                      p.month.slice(0, 7) === b.month &&
                      !prefix.some((g) => g.id === p.goal_id),
                  )
                  .reduce((n, p) => n + cents(p.amount), 0),
            ),
          0,
        );
      let mandatory = Math.max(0, demand - future);
      for (const g of prefix.filter(
        (g) => !locked.has(g.id) && active.some((a) => a.id === g.id),
      ))
        mandatory -= put(g, mandatory);
    }
    // Maintain steady contributions to later goals whenever deadline constraints leave room.
    for (const g of active.filter((g) => !locked.has(g.id)))
      put(
        g,
        Math.ceil(remaining.get(g.id)! / monthCount(budget.month, g.deadline)),
      );
    for (const g of active.filter((g) => !locked.has(g.id)))
      put(g, remaining.get(g.id)!);
    return {
      month: budget.month,
      budget: budget.amount,
      assigned: cash(Math.max(0, cents(budget.amount)) - available),
      unassigned: cash(available),
      allocations: [...amounts]
        .filter(([, n]) => n > 0)
        .map(([goal_id, n]) => ({ goal_id, amount: cash(n) })),
    };
  });
  return {
    schedule,
    conflicts,
    goals: ordered.map((g) => ({
      id: g.id,
      deficit: cash(remaining.get(g.id)!),
      estimatedCompletion: completion.get(g.id) ?? null,
      feasible: remaining.get(g.id) === 0,
    })),
  };
}

export function goalMetrics(
  goal: Row,
  allocations: Row[],
  plans: Row[],
  today: string,
  month: string,
): Row {
  const entries = allocations.filter(
    (a) =>
      a.goal_id === goal.id &&
      String(a.created_at ?? today).slice(0, 10) <= today,
  );
  const confirmed = total(entries);
  const target = cents(goal.ideal_amount);
  const remaining = Math.max(0, target - confirmed);
  const start =
    goal.start_date ??
    entries.map((a) => String(a.created_at).slice(0, 10)).sort()[0] ??
    today;
  const end = DateTime.fromISO(goal.target_date);
  const duration = Math.max(1, end.diff(DateTime.fromISO(start), "days").days);
  const elapsed = Math.min(
    1,
    Math.max(
      0,
      DateTime.fromISO(today).diff(DateTime.fromISO(start), "days").days /
        duration,
    ),
  );
  const months = monthCount(month, goal.target_date);
  const expected = Math.round(target * elapsed);
  const sharedPlans = plans.filter((p) => p.goal_id === goal.id);
  const futurePlans = sharedPlans.filter(
    (p) =>
      p.month.slice(0, 7) >= month &&
      p.month.slice(0, 7) <= goal.target_date.slice(0, 7),
  );
  const current = sharedPlans.filter((p) => p.month.startsWith(month));
  const monthlyConfirmed = total(
    entries.filter((a) => String(a.created_at).startsWith(month)),
  );
  const future = Math.max(0, total(futurePlans) - monthlyConfirmed);
  let estimatedCompletion: string | null = null;
  let projected = confirmed;
  for (const m of [
    ...new Set(futurePlans.map((p) => p.month.slice(0, 7))),
  ].sort()) {
    projected += Math.max(
      0,
      total(futurePlans.filter((p) => p.month.startsWith(m))) -
        (m === month ? monthlyConfirmed : 0),
    );
    if (projected >= target) {
      estimatedCompletion = m;
      break;
    }
  }
  const status =
    remaining === 0
      ? "completed"
      : goal.target_date < today
        ? "overdue"
        : confirmed < expected
          ? "behind"
          : "on_track";
  return {
    ...goal,
    confirmed: cash(confirmed),
    remaining: cash(remaining),
    progress: target ? (confirmed / target) * 100 : 0,
    start_date: start,
    elapsedPercentage: elapsed * 100,
    daysRemaining: Math.max(
      0,
      Math.ceil(end.diff(DateTime.fromISO(today), "days").days),
    ),
    monthsRemaining: months,
    monthlyRequired: months
      ? cash(Math.ceil(remaining / months))
      : cash(remaining),
    expectedSaved: cash(expected),
    shortfallToDate: cash(Math.max(0, expected - confirmed)),
    monthlyPlanned: cash(total(current)),
    monthlyConfirmed: cash(monthlyConfirmed),
    projectedDeficit: cash(Math.max(0, remaining - future)),
    viability:
      remaining === 0
        ? "completed"
        : status === "overdue"
          ? "overdue"
          : future >= remaining
            ? "planned"
            : futurePlans.length
              ? "shortfall"
              : "unknown",
    status,
    estimatedCompletion,
    history: entries
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .map((a) => ({
        id: a.id,
        user_id: a.user_id,
        amount: a.amount,
        currency: a.currency,
        created_at: a.created_at,
      })),
  };
}

export function buildPlanner(
  data: Record<string, Row[]>,
  currency: string,
  requestedMonth: string,
  userId: string,
  timezone: string,
  todayOverride?: string,
  fundAmount?: number,
) {
  const today = todayOverride ?? DateTime.now().setZone(timezone).toISODate()!;
  const month =
    requestedMonth < today.slice(0, 7) ? today.slice(0, 7) : requestedMonth;
  const goals = (data.goals ?? []).filter((g) => g.currency === currency);
  const allocations = localContributions(data.allocations ?? [], timezone);
  const own = allocations.filter(
    (a) =>
      a.user_id === userId &&
      String(a.created_at ?? today).slice(0, 10) <= today,
  );
  const metrics = goals.map(
    (g) =>
      ({
        ...goalMetrics(g, allocations, data.plans ?? [], today, month),
        participants: responsibilityTargets(
          g.ideal_amount,
          (data["goal-members"] ?? []).filter((m) => m.goal_id === g.id),
        ),
      }) as Row,
  );
  const responsibilities = metrics.map((g) => {
    const member = g.participants.find((m: Row) => m.user_id === userId);
    const percentage = g.space_id
      ? member
        ? Number(member.percentage)
        : null
      : 100;
    const target =
      percentage === null
        ? 0
        : g.space_id
          ? cents(member.target_amount)
          : cents(g.ideal_amount);
    const confirmed = total(own.filter((a) => a.goal_id === g.id));
    const remaining = Math.min(
      cents(g.remaining),
      Math.max(0, target - confirmed),
    );
    const pastPlanned = total(
      (data.plans ?? []).filter(
        (p) =>
          p.user_id === userId &&
          p.goal_id === g.id &&
          p.month.slice(0, 7) < month,
      ),
    );
    return {
      id: g.id,
      name: g.name,
      space_id: g.space_id,
      start_date: g.start_date,
      deadline: g.target_date,
      priority: g.priority,
      percentage,
      target: cash(target),
      confirmed: cash(confirmed),
      remaining: cash(remaining),
      accumulatedDeficit: cash(Math.max(0, pastPlanned - confirmed)),
      monthlyRequired: cash(
        Math.ceil(remaining / Math.max(1, monthCount(month, g.target_date))),
      ),
      status: g.status,
    };
  });
  const lastDeadline =
    goals
      .map((g) => g.target_date.slice(0, 7))
      .sort()
      .at(-1) ?? month;
  const horizonMonths = Math.min(
    600,
    Math.max(1, monthCount(month, lastDeadline + "-01")),
  );
  const budgets = Array.from({ length: horizonMonths }, (_, i) => {
    const m = nextMonth(month, i);
    const settings = (data["planner-budgets"] ?? [])
      .filter((b) => b.currency === currency && b.month.slice(0, 7) <= m)
      .sort((a, b) => b.month.localeCompare(a.month))[0];
    const summary = summarize(data, currency, m, timezone, userId);
    const income = cents(settings?.monthly_income ?? summary.income);
    const percentage = Number(
      settings?.savings_percentage ??
        data.preferences?.[0]?.savings_target_percentage ??
        20,
    );
    const desired = Math.round((income * percentage) / 100);
    const max =
      settings?.maximum_savings == null
        ? desired
        : cents(settings.maximum_savings);
    const essential = cents(settings?.essential_expenses ?? 0);
    const pending = commitments(data, summary, m, currency, today.slice(0, 7));
    const actualExpenses = m === today.slice(0, 7) ? cents(summary.expense) : 0;
    const cashAvailable = Math.max(
      0,
      income - Math.max(essential, actualExpenses) - pending,
    );
    const confirmed = total(
      own.filter(
        (a) =>
          String(a.created_at).startsWith(m) &&
          goals.some((g) => g.id === a.goal_id),
      ),
    );
    const current = m === today.slice(0, 7);
    const liquid = current
      ? Math.max(
          0,
          cents(summary.liquidity) +
            Math.max(0, cents(summary.unallocated)) -
            pending -
            Math.max(0, essential - actualExpenses),
        )
      : cashAvailable;
    const available = Math.max(
      0,
      Math.min(max, cashAvailable, liquid + confirmed),
    );
    let recommended = Math.max(0, Math.min(desired, available) - confirmed);
    if (i === 0 && fundAmount != null)
      recommended = Math.min(
        cents(fundAmount),
        Math.max(0, cents(summary.unallocated)),
        liquid,
      );
    return {
      month: m,
      monthlyIncome: cash(income),
      savingsPercentage: percentage,
      desired: cash(desired),
      financiallyAvailable: cash(available),
      maximumSavings: cash(max),
      essentialExpenses: cash(essential),
      pendingObligations: cash(pending),
      confirmed: cash(confirmed),
      amount: cash(recommended),
      source: settings ? "manual" : "recorded_income",
    };
  });
  // Saved plans are per-month totals. Already confirmed contributions reduce only the current month's remaining plan.
  const manual = (data.plans ?? [])
    .filter(
      (p) =>
        p.user_id === userId &&
        goals.some((g) => g.id === p.goal_id) &&
        p.month.slice(0, 7) >= month,
    )
    .map((p) => ({
      goal_id: p.goal_id,
      month: p.month.slice(0, 7),
      amount: cash(
        Math.max(
          0,
          cents(p.amount) -
            total(
              own.filter(
                (a) =>
                  a.goal_id === p.goal_id &&
                  String(a.created_at).startsWith(p.month.slice(0, 7)),
              ),
            ),
        ),
      ),
    }));
  const result = allocateTimeline(
    responsibilities
      .filter((g) => g.percentage !== null)
      .map((g) => ({
        ...g,
        deadline:
          g.status === "overdue" ? nextMonth(month, -1) + "-01" : g.deadline,
      })),
    budgets,
    fundAmount == null ? manual : [],
  );
  return {
    currency,
    requestedMonth,
    startMonth: month,
    today,
    horizonLimited: lastDeadline > nextMonth(month, 599),
    assumption:
      "Los ingresos y límites manuales se mantienen en meses futuros hasta el próximo cambio. Las obligaciones futuras se descuentan de cada mes. El presupuesto mensual supone disponibilidad antes de los vencimientos de ese mes; las previsiones no garantizan ingresos ni aportes de otras personas.",
    budgets,
    ...result,
    confirmedContributions: own
      .filter((a) => goals.some((g) => g.id === a.goal_id))
      .map((a) => ({
        goal_id: a.goal_id,
        amount: a.amount,
        month: String(a.created_at).slice(0, 7),
      })),
    goals: responsibilities.map((g) => ({
      ...g,
      ...result.goals.find((r) => r.id === g.id),
      participationMissing: g.percentage === null,
    })),
    metrics,
  };
}

export function consolidateSpaces(
  spaces: Row[],
  metrics: Row[],
  currency: string,
) {
  return spaces.map((s) => {
    const goals = metrics.filter((g) => g.space_id === s.id);
    const target = total(goals, "ideal_amount");
    const confirmed = total(goals, "confirmed");
    return {
      ...s,
      currency,
      goalCount: goals.length,
      completed: goals.filter((g) => g.status === "completed").length,
      atRisk: goals.filter(
        (g) =>
          g.status !== "completed" &&
          (g.status === "overdue" ||
            g.status === "behind" ||
            g.viability !== "planned"),
      ).length,
      target: cash(target),
      confirmed: cash(confirmed),
      remaining: cash(total(goals, "remaining")),
      progress: target ? (confirmed / target) * 100 : 0,
      monthlyRequired: cash(total(goals, "monthlyRequired")),
      monthlyPlanned: cash(total(goals, "monthlyPlanned")),
      monthlyConfirmed: cash(total(goals, "monthlyConfirmed")),
      goals,
    };
  });
}

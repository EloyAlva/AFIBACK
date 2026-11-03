import { Decimal } from "decimal.js";
import { DateTime } from "luxon";
export type Row = Record<string, any>;
export const sum = (rows: Row[], field = "amount"): Decimal =>
  rows.reduce<Decimal>((a, r) => a.plus(r[field] ?? 0), new Decimal(0));
export function occurrenceStatus(
  amount: number | string,
  paid: number | string,
  due: string,
  today: string,
) {
  const remaining = Decimal.max(0, new Decimal(amount).minus(paid));
  return {
    paid: new Decimal(paid).toNumber(),
    pending: remaining.toNumber(),
    status: remaining.isZero()
      ? "paid"
      : due < today
        ? "overdue"
        : new Decimal(paid).gt(0)
          ? "partial"
          : "pending",
  };
}
export function summarize(
  data: Record<string, Row[]>,
  currency: string,
  month: string,
  timezone: string,
  userId: string,
) {
  const now = DateTime.now().setZone(timezone);
  const today = now.toISODate()!;
  const tx = (data.transactions ?? []).filter(
    (t) => !t.voided_at && t.currency === currency,
  );
  const inMonth = (t: Row) =>
    DateTime.fromISO(t.occurred_at).setZone(timezone).toFormat("yyyy-MM") ===
    month;
  const inDay = (t: Row) =>
    DateTime.fromISO(t.occurred_at).setZone(timezone).toISODate() === today;
  const period = tx.filter(inMonth);
  const purchases = (data.purchases ?? []).filter((p) =>
    (data.cards ?? []).some(
      (c) => c.id === p.card_id && c.currency === currency,
    ),
  );
  const periodPurchases = purchases.filter((p) =>
    p.purchased_at.startsWith(month),
  );
  const purchaseTotal = (rows: Row[]): Decimal =>
    rows.reduce<Decimal>(
      (a, p) =>
        a.plus(new Decimal(p.amount).times(p.kind === "refund" ? -1 : 1)),
      new Decimal(0),
    );
  const expense = period.filter((t) =>
    ["expense", "obligation_payment"].includes(t.type),
  );
  const income = sum(period.filter((t) => t.type === "income"));
  const interestPaid = (movements: Row[]) =>
    sum(
      (data.payments ?? []).filter((p) =>
        movements.some(
          (t) => t.id === p.transaction_id && t.type === "loan_payment",
        ),
      ),
      "interest_amount",
    );
  const monthlyInterest = interestPaid(period);
  const spent = sum(expense)
    .plus(purchaseTotal(periodPurchases))
    .plus(monthlyInterest);
  const accounts = (data.accounts ?? [])
    .filter((a) => a.currency === currency)
    .map((a) => ({
      ...a,
      balance: new Decimal(a.opening_balance)
        .plus(
          sum(
            (data.entries ?? []).filter(
              (e) =>
                e.account_id === a.id &&
                tx.some((t) => t.id === e.transaction_id),
            ),
          ),
        )
        .toNumber(),
    }));
  const reserved = sum(
    (data["fund-movements"] ?? []).filter(
      (f) =>
        f.currency === currency && tx.some((t) => t.id === f.transaction_id),
    ),
  );
  const allocated = sum(
    (data.allocations ?? []).filter(
      (a) => a.user_id === userId && a.currency === currency,
    ),
  );
  const monthlySaved = sum(
    (data["fund-movements"] ?? []).filter((f) =>
      f.user_id === userId && f.currency === currency && period.some((t) => t.id === f.transaction_id)),
  );
  const savingsTargetPercentage = Number(data.preferences?.[0]?.savings_target_percentage ?? 20);
  const savingsTarget = income.times(savingsTargetPercentage).div(100);
  const savingsShortfall = Decimal.max(0, savingsTarget.minus(monthlySaved));
  const occurrences = (data.occurrences ?? [])
    .filter((o) => o.currency === currency)
    .map((o) => ({
      ...o,
      ...occurrenceStatus(
        o.amount,
        sum(
          (data.payments ?? []).filter(
            (p) =>
              p.occurrence_id === o.id &&
              tx.some((t) => t.id === p.transaction_id),
          ),
        ).toString(),
        o.due_date,
        today,
      ),
      name:
        (data.obligations ?? []).find((b) => b.id === o.obligation_id)?.name ??
        "Pago",
    }));
  const monthlyOccurrences = occurrences.filter((o: Row) =>
    o.due_date.startsWith(month),
  );
  const cards = (data.cards ?? [])
    .filter((c) => c.currency === currency)
    .map((c) => {
      const used = new Decimal(c.initial_debt)
        .plus(purchaseTotal(purchases.filter((p) => p.card_id === c.id)))
        .minus(
          sum(
            tx.filter((t) => t.card_id === c.id && t.type === "card_payment"),
          ),
        );
      return {
        ...c,
        used: used.toNumber(),
        available: new Decimal(c.credit_limit).minus(used).toNumber(),
        utilization: used.div(c.credit_limit).times(100).toNumber(),
      };
    });
  const debts = (data.debts ?? [])
    .filter((d) => d.currency === currency)
    .map((d) => ({
      ...d,
      pending: Decimal.max(
        0,
        new Decimal(d.principal)
          .plus(
            sum(
              (data["debt-installments"] ?? []).filter(
                (i) => i.debt_id === d.id,
              ),
              "interest",
            ),
          )
          .minus(
            sum(
              tx.filter((t) => t.debt_id === d.id && t.type === "loan_payment"),
            ),
          ),
      ).toNumber(),
    }));
  const categoryTotals = (data.categories ?? [])
    .filter((c) => c.type === "expense")
    .map((c) => ({
      name: c.name,
      id: c.id,
      amount: sum(expense.filter((t) => t.category_id === c.id))
        .plus(
          purchaseTotal(periodPurchases.filter((p) => p.category_id === c.id)),
        )
        .toNumber(),
    }));
  const uncategorized = sum(expense.filter((t) => !t.category_id)).plus(
    purchaseTotal(periodPurchases.filter((p) => !p.category_id)),
  );
  if (!monthlyInterest.isZero())
    categoryTotals.push({
      name: "Intereses de préstamos",
      id: "loan-interest",
      amount: monthlyInterest.toNumber(),
    });
  if (!uncategorized.isZero())
    categoryTotals.push({
      name: "Sin categoría",
      id: "uncategorized",
      amount: uncategorized.toNumber(),
    });
  const budgets = (data.budgets ?? [])
    .filter((b) => b.currency === currency && b.month.startsWith(month))
    .map((b) => {
      const spentAmount = b.category_id
        ? (categoryTotals.find((c) => c.id === b.category_id)?.amount ?? 0)
        : spent.toNumber();
      return {
        ...b,
        alerts: (
          data.preferences?.[0]?.budget_thresholds ?? [80, 90, 100]
        ).filter((threshold: number) =>
          new Decimal(spentAmount).div(b.amount).times(100).gte(threshold),
        ),
        spent: spentAmount,
        remaining: new Decimal(b.amount).minus(spentAmount).toNumber(),
        percentage: new Decimal(spentAmount)
          .div(b.amount)
          .times(100)
          .toNumber(),
      };
    });
  const goals = (data.goals ?? [])
    .filter((g) => g.currency === currency)
    .map((g) => {
      const confirmed = sum(
        (data.allocations ?? []).filter((a) => a.goal_id === g.id),
      );
      return {
        ...g,
        confirmed: confirmed.toNumber(),
        planned: sum(
          (data.plans ?? []).filter(
            (p) => p.goal_id === g.id && p.month.startsWith(month),
          ),
        ).toNumber(),
        remaining: Decimal.max(
          0,
          new Decimal(g.ideal_amount).minus(confirmed),
        ).toNumber(),
        progress: confirmed.div(g.ideal_amount).times(100).toNumber(),
      };
    });
  const evolution = Array.from({ length: 6 }, (_, i) => {
    const m = DateTime.fromISO(month + "-01")
      .minus({ months: 5 - i })
      .toFormat("yyyy-MM");
    const mt = tx.filter(
      (t) =>
        DateTime.fromISO(t.occurred_at)
          .setZone(timezone)
          .toFormat("yyyy-MM") === m,
    );
    return {
      month: m,
      income: sum(mt.filter((t) => t.type === "income")).toNumber(),
      expense: sum(
        mt.filter((t) => ["expense", "obligation_payment"].includes(t.type)),
      )
        .plus(
          purchaseTotal(purchases.filter((p) => p.purchased_at.startsWith(m))),
        )
        .plus(interestPaid(mt))
        .toNumber(),
    };
  });
  const totalPending = sum(monthlyOccurrences, "pending");
  const liquidity = sum(accounts, "balance").minus(reserved);
  return {
    currency,
    month,
    today,
    timezone,
    creditUtilization: sum(cards, "credit_limit").isZero()
      ? 0
      : sum(cards, "used")
          .div(sum(cards, "credit_limit"))
          .times(100)
          .toNumber(),
    monthlyCommitment: income.isZero()
      ? null
      : sum(monthlyOccurrences).div(income).times(100).toNumber(),
    paymentAssistant: {
      today: occurrences.filter(
        (o: Row) => o.pending > 0 && o.due_date === today,
      ).length,
      tomorrow: occurrences.filter(
        (o: Row) =>
          o.pending > 0 && o.due_date === now.plus({ days: 1 }).toISODate(),
      ).length,
      next7Days: occurrences.filter(
        (o: Row) =>
          o.pending > 0 &&
          o.due_date >= today &&
          o.due_date <= now.plus({ days: 7 }).toISODate()!,
      ).length,
      neededNext7Days: sum(
        occurrences.filter(
          (o: Row) =>
            o.pending > 0 && o.due_date <= now.plus({ days: 7 }).toISODate()!,
        ),
        "pending",
      ).toNumber(),
    },
    income: income.toNumber(),
    savingsIndicator: {
      targetPercentage: savingsTargetPercentage,
      target: savingsTarget.toNumber(),
      saved: monthlySaved.toNumber(),
      actualPercentage: income.gt(0) ? monthlySaved.div(income).times(100).toNumber() : null,
      shortfall: savingsShortfall.toNumber(),
      progress: savingsTarget.gt(0) ? Decimal.max(0, monthlySaved.div(savingsTarget).times(100)).toNumber() : null,
      status: income.isZero() ? "no_income" : savingsShortfall.gt(0) ? "behind" : "on_track",
    },
    expense: spent.toNumber(),
    balance: income.minus(spent).toNumber(),
    dayIncome: sum(
      tx.filter((t) => t.type === "income" && inDay(t)),
    ).toNumber(),
    dayExpense: sum(
      tx.filter(
        (t) => ["expense", "obligation_payment"].includes(t.type) && inDay(t),
      ),
    )
      .plus(purchaseTotal(purchases.filter((p) => p.purchased_at === today)))
      .plus(interestPaid(tx.filter(inDay)))
      .toNumber(),
    antExpenses: sum(
      expense.filter((t) =>
        new Decimal(t.amount).lte(
          data.preferences?.[0]?.ant_expense_threshold ?? 20,
        ),
      ),
    ).toNumber(),
    accounts,
    cards,
    debts,
    occurrences,
    budgets,
    goals,
    categoryTotals,
    evolution,
    reserved: reserved.toNumber(),
    allocated: allocated.toNumber(),
    unallocated: reserved.minus(allocated).toNumber(),
    liquidity: liquidity.toNumber(),
    debtTotal: sum(cards, "used").plus(sum(debts, "pending")).toNumber(),
    creditLimit: sum(cards, "credit_limit").toNumber(),
    creditUsed: sum(cards, "used").toNumber(),
    creditAvailable: sum(cards, "available").toNumber(),
    payments: {
      due: sum(monthlyOccurrences).toNumber(),
      paid: sum(monthlyOccurrences, "paid").toNumber(),
      pending: totalPending.toNumber(),
      overdue: sum(
        monthlyOccurrences.filter((o) => o.status === "overdue"),
        "pending",
      ).toNumber(),
      covered: sum(monthlyOccurrences).isZero()
        ? 100
        : sum(monthlyOccurrences, "paid")
            .div(sum(monthlyOccurrences))
            .times(100)
            .toNumber(),
    },
    estimatedSavingCapacity: Decimal.max(
      0,
      Decimal.min(
        income.minus(spent).minus(totalPending),
        liquidity.minus(totalPending),
      ),
    ).toNumber(),
  };
}
export function csv(rows: Row[]) {
  const columns = [
    "id",
    "type",
    "amount",
    "currency",
    "occurred_at",
    "description",
    "voided_at",
  ];
  const escape = (v: unknown) =>
    '"' +
    String(v ?? "")
      .replace(/^[=+\-@\t\r]/, "'$&")
      .replaceAll('"', '""') +
    '"';
  return (
    "\ufeff" +
    [
      columns.join(","),
      ...rows.map((r) => columns.map((k) => escape(r[k])).join(",")),
    ].join("\r\n")
  );
}

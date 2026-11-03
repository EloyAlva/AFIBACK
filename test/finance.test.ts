import test from "node:test";
import assert from "node:assert/strict";
import { occurrenceStatus, summarize, csv } from "../src/finance.js";
import { transaction, resources } from "../src/schemas.js";

test("Meta mensual usa ingresos y reservas netas del mismo mes, usuario y moneda", () => {
  const data = {
    preferences: [{ savings_target_percentage: 20 }],
    transactions: [
      { id: "income", type: "income", amount: 1000, currency: "PEN", occurred_at: "2026-11-01T12:00:00Z" },
      { id: "save", type: "savings_reserve", amount: 150, currency: "PEN", occurred_at: "2026-11-02T12:00:00Z" },
      { id: "withdraw", type: "savings_withdrawal", amount: 50, currency: "PEN", occurred_at: "2026-11-03T12:00:00Z" },
      { id: "old", type: "savings_reserve", amount: 900, currency: "PEN", occurred_at: "2026-10-03T12:00:00Z" },
      { id: "void", type: "savings_reserve", amount: 900, currency: "PEN", occurred_at: "2026-11-03T12:00:00Z", voided_at: "2026-11-03" },
    ],
    "fund-movements": [
      { transaction_id: "save", user_id: "u", currency: "PEN", amount: 150 },
      { transaction_id: "withdraw", user_id: "u", currency: "PEN", amount: -50 },
      { transaction_id: "old", user_id: "u", currency: "PEN", amount: 900 },
      { transaction_id: "void", user_id: "u", currency: "PEN", amount: 900 },
      { transaction_id: "save", user_id: "other", currency: "PEN", amount: 900 },
    ],
  };
  const indicator = summarize(data, "PEN", "2026-11", "America/Lima", "u").savingsIndicator;
  assert.equal(indicator.target, 200);
  assert.equal(indicator.saved, 100);
  assert.equal(indicator.actualPercentage, 10);
  assert.equal(indicator.shortfall, 100);
  assert.equal(indicator.status, "behind");
  const empty = summarize({}, "PEN", "2026-11", "America/Lima", "u").savingsIndicator;
  assert.equal(empty.actualPercentage, null);
  assert.equal(empty.status, "no_income");
});
test("Pagos parciales, totales y vencidos se distinguen", () => {
  assert.deepEqual(occurrenceStatus(800, 300, "2026-11-10", "2026-11-02"), {
    paid: 300,
    pending: 500,
    status: "partial",
  });
  assert.equal(
    occurrenceStatus(800, 800, "2026-10-01", "2026-11-02").status,
    "paid",
  );
  assert.equal(
    occurrenceStatus(800, 300, "2026-10-01", "2026-11-02").status,
    "overdue",
  );
});
test("Saldos iniciales, transferencias y pagos de tarjeta no duplican ingresos ni gastos", () => {
  const s = summarize(
    {
      accounts: [{ id: "a", currency: "PEN", opening_balance: 100 }],
      transactions: [
        {
          id: "t",
          type: "income",
          amount: 200,
          currency: "PEN",
          occurred_at: "2026-11-02T15:00:00Z",
        },
        {
          id: "p",
          type: "card_payment",
          amount: 50,
          currency: "PEN",
          occurred_at: "2026-11-02T16:00:00Z",
        },
      ],
      entries: [
        { account_id: "a", transaction_id: "t", amount: 200 },
        { account_id: "a", transaction_id: "p", amount: -50 },
      ],
      goals: [{ id: "g", currency: "PEN", ideal_amount: 1000 }],
      plans: [{ goal_id: "g", month: "2026-11-01", amount: 300 }],
      allocations: [],
    },
    "PEN",
    "2026-11",
    "America/Lima",
    "u",
  );
  assert.equal(s.income, 200);
  assert.equal(s.expense, 0);
  assert.equal(s.accounts[0].balance, 250);
  assert.equal(s.goals[0].confirmed, 0);
  assert.equal(s.goals[0].planned, 300);
});
test("Fecha local y moneda se respetan; compras y devoluciones usan una sola fuente", () => {
  const s = summarize(
    {
      transactions: [
        {
          type: "income",
          amount: 20,
          currency: "PEN",
          occurred_at: "2026-11-01T02:00:00Z",
        },
        {
          type: "income",
          amount: 999,
          currency: "USD",
          occurred_at: "2026-11-02T15:00:00Z",
        },
      ],
      cards: [
        { id: "c", currency: "PEN", credit_limit: 1000, initial_debt: 0 },
      ],
      purchases: [
        {
          card_id: "c",
          amount: 50,
          kind: "purchase",
          purchased_at: "2026-11-01",
        },
        {
          card_id: "c",
          amount: 10,
          kind: "refund",
          purchased_at: "2026-11-02",
        },
      ],
    },
    "PEN",
    "2026-11",
    "America/Lima",
    "u",
  );
  assert.equal(s.income, 0);
  assert.equal(s.expense, 40);
  assert.equal(s.cards[0].used, 40);
});
test("Validación de importes, propiedades y CSV con protección de fórmulas", () => {
  assert.equal(
    resources.accounts.safeParse({
      name: "Yape",
      type: "wallet",
      opening_balance: 1.001,
    }).success,
    false,
  );
  assert.equal(
    transaction.safeParse({ type: "expense", amount: -1 }).success,
    false,
  );
  assert.match(csv([{ description: '=HYPERLINK("evil")' }]), /\'=HYPERLINK/);
});

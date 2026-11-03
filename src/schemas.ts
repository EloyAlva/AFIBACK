import { z } from "zod";
export const uuid = z.uuid();
export const money = z.coerce
  .number()
  .positive()
  .max(999999999999)
  .refine(
    (v) => Math.abs(v * 100 - Math.round(v * 100)) < 0.001,
    "Máximo dos decimales",
  );
const nonnegative = money.or(z.literal(0));
export const currency = z.string().regex(/^[A-Z]{3}$/);
export const date = z.iso.date();
const name = z.string().trim().min(1).max(120);
const optionalId = uuid.nullish();
export const transaction = z
  .object({
    type: z.enum([
      "income",
      "expense",
      "transfer",
      "card_payment",
      "loan_payment",
      "obligation_payment",
      "savings_reserve",
      "savings_withdrawal",
      "adjustment",
    ]),
    amount: money,
    currency,
    occurred_at: z.iso.datetime({ offset: true }),
    category_id: optionalId,
    source_account_id: optionalId,
    destination_account_id: optionalId,
    card_id: optionalId,
    debt_id: optionalId,
    occurrence_id: optionalId,
    description: z.string().trim().min(1).max(500),
    notes: z.string().max(2000).default(""),
    payment_method: z.string().max(80).default(""),
  })
  .strict();
export const resources = {
  accounts: z
    .object({
      name,
      type: z.enum(["cash", "bank", "wallet", "savings", "other"]),
      currency: currency.default("PEN"),
      opening_balance: nonnegative.default(0),
    })
    .strict(),
  categories: z.object({ name, type: z.enum(["income", "expense"]) }).strict(),
  cards: z
    .object({
      bank: name,
      name,
      currency: currency.default("PEN"),
      credit_limit: money,
      initial_debt: nonnegative.default(0),
      closing_day: z.coerce.number().int().min(1).max(31),
      due_day: z.coerce.number().int().min(1).max(31),
      utilization_limit: z.coerce.number().min(0).max(100).default(50),
    })
    .strict(),
  debts: z
    .object({
      creditor: name,
      name,
      currency: currency.default("PEN"),
      principal: money,
      annual_interest: z.coerce.number().min(0).max(1000).default(0),
      installments: z.coerce.number().int().min(1).max(600),
      first_due_date: date,
    })
    .strict(),
  obligations: z
    .object({
      name,
      type: z
        .enum(["rent", "service", "subscription", "card", "loan", "other"])
        .default("service"),
      entity: z.string().max(120).default(""),
      amount: money,
      currency: currency.default("PEN"),
      frequency: z.enum(["once", "monthly", "yearly"]),
      start_date: date,
      end_date: date.nullish(),
      account_id: optionalId,
      card_id: optionalId,
      debt_id: optionalId,
      notes: z.string().max(2000).default(""),
    })
    .strict(),
  budgets: z
    .object({
      category_id: optionalId,
      month: date.refine((v) => v.endsWith("-01"), "Usa el primer día del mes"),
      amount: money,
      currency: currency.default("PEN"),
    })
    .strict(),
  spaces: z.object({ name }).strict(),
  goals: z
    .object({
      space_id: optionalId,
      name,
      description: z.string().max(2000).default(""),
      minimum_amount: nonnegative.default(0),
      ideal_amount: money,
      currency: currency.default("PEN"),
      target_date: date,
      priority: z.coerce.number().int().min(1).max(3).default(2),
    })
    .strict()
    .refine((v) => v.ideal_amount >= v.minimum_amount),
};
export type Resource = keyof typeof resources;
export const tables: Record<string, string> = {
  accounts: "financial_accounts",
  categories: "categories",
  transactions: "financial_transactions",
  entries: "transaction_entries",
  payments: "obligation_payments",
  cards: "credit_cards",
  purchases: "credit_card_purchases",
  "card-installments": "credit_card_installments",
  statements: "credit_card_statements",
  debts: "debts",
  "debt-installments": "debt_installments",
  obligations: "payment_obligations",
  occurrences: "payment_occurrences",
  budgets: "budgets",
  spaces: "shared_spaces",
  members: "shared_space_members",
  invitations: "shared_space_invitations",
  goals: "savings_goals",
  "goal-members": "savings_goal_members",
  plans: "savings_plans",
  allocations: "savings_allocations",
  "fund-movements": "savings_fund_movements",
  notifications: "notifications",
  profile: "profiles",
  preferences: "user_preferences",
  "ai-usage": "ai_usage_logs",
};
export const purchase = z
  .object({
    card_id: uuid,
    category_id: optionalId,
    amount: money,
    description: name,
    purchased_at: date,
    installments: z.coerce.number().int().min(1).max(120).default(1),
    kind: z.enum(["purchase", "interest", "fee", "refund"]).default("purchase"),
  })
  .strict();
export const statement = z
  .object({
    card_id: uuid,
    period: date.refine((v) => v.endsWith("-01")),
    closing_date: date,
    due_date: date,
    amount: money.or(z.literal(0)),
    minimum_payment: money.or(z.literal(0)),
  })
  .strict()
  .refine(
    (v) => v.minimum_payment <= v.amount && v.due_date > v.closing_date,
    "Revisa importes y fechas",
  );
export const updates: Record<string, z.ZodType> = {
  accounts: z
    .object({ name: name.optional(), active: z.boolean().optional() })
    .strict(),
  categories: z.object({ name }).strict(),
  cards: z
    .object({
      name: name.optional(),
      bank: name.optional(),
      closing_day: z.number().int().min(1).max(31).optional(),
      due_day: z.number().int().min(1).max(31).optional(),
      utilization_limit: z.number().min(0).max(100).optional(),
      active: z.boolean().optional(),
    })
    .strict(),
  debts: z
    .object({
      name: name.optional(),
      creditor: name.optional(),
      active: z.boolean().optional(),
    })
    .strict(),
  obligations: z
    .object({
      name: name.optional(),
      entity: z.string().max(120).optional(),
      amount: money.optional(),
      frequency: z.enum(["once", "monthly", "yearly"]).optional(),
      end_date: date.nullish(),
      active: z.boolean().optional(),
      notes: z.string().max(2000).optional(),
    })
    .strict(),
  occurrences: z
    .object({ amount: money.optional(), due_date: date.optional() })
    .strict(),
  budgets: z.object({ amount: money }).strict(),
  goals: z
    .object({
      name: name.optional(),
      description: z.string().max(2000).optional(),
      minimum_amount: money.or(z.literal(0)).optional(),
      ideal_amount: money.optional(),
      target_date: date.optional(),
      priority: z.number().int().min(1).max(3).optional(),
    })
    .strict(),
};

import type { FastifyInstance, FastifyRequest } from "fastify";
import { DateTime } from "luxon";
import { z } from "zod";
import { currency, date, money, uuid, tables } from "./schemas.js";
import {
  buildPlanner,
  consolidateSpaces,
  goalMetrics,
  localContributions,
} from "./planning.js";
import type { Row } from "./finance.js";
import { responsibilityTargets } from "./goal-shares.js";

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const firstDay = date.refine((d) => d.endsWith("-01"));
const amount = money.or(z.literal(0));
async function rows(req: FastifyRequest, table: string) {
  const result: Row[] = [];
  for (let start = 0; ; start += 1000) {
    let query = req.db.from(table).select("*");
    const keys =
      table === "savings_goal_members"
        ? ["goal_id", "user_id"]
        : table === "savings_planner_budgets"
          ? ["user_id", "currency", "month"]
          : table === "user_preferences"
            ? ["user_id"]
            : ["id"];
    for (const key of keys) query = query.order(key);
    const r = await query.range(start, start + 999);
    if (r.error)
      throw Object.assign(new Error(r.error.message), { statusCode: 422 });
    result.push(...r.data);
    if (r.data.length < 1000) return result;
  }
}
async function dataFor(req: FastifyRequest, names: string[]) {
  return Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [
        name,
        await rows(
          req,
          name === "planner-budgets" ? "savings_planner_budgets" : tables[name],
        ),
      ]),
    ),
  );
}
async function rpc(req: FastifyRequest, name: string, args: Row) {
  const r = await req.db.rpc(name, args);
  if (r.error)
    throw Object.assign(new Error(r.error.message), { statusCode: 422 });
  return r.data;
}

export function sharedOverview(
  data: Record<string, Row[]>,
  cur: string,
  m: string,
  today: string,
  timezone = "America/Lima",
) {
  // This projection intentionally has no private budgets, financial accounts or income.
  const goals = (data.goals ?? []).filter((g) => g.currency === cur);
  const plans = (data.plans ?? []).filter((p) => {
    const goal = goals.find((g) => g.id === p.goal_id);
    return goal && (p.share_authorized || !goal.space_id);
  });
  const metrics = goals.map((g) => ({
    ...goalMetrics(
      g,
      localContributions(data.allocations ?? [], timezone),
      plans,
      today,
      m,
    ),
    participants: responsibilityTargets(
      g.ideal_amount,
      (data["goal-members"] ?? []).filter((m) => m.goal_id === g.id),
    ),
  }));
  return {
    currency: cur,
    month: m,
    today,
    spaces: consolidateSpaces(data.spaces ?? [], metrics, cur),
    goals: metrics,
    plans,
    participants: (data["goal-members"] ?? []).filter((m) =>
      goals.some((g) => g.id === m.goal_id),
    ),
  };
}

export function registerPlanner(api: FastifyInstance) {
  api.get(
    "/savings/planner",
    {
      schema: {
        summary: "Planificador privado por restricciones y vencimientos",
      },
    },
    async (req) => {
      const q = z
        .object({ currency, month, fund_amount: amount.optional() })
        .parse(req.query);
      const data = await dataFor(req, [
        "profile",
        "preferences",
        "accounts",
        "entries",
        "transactions",
        "payments",
        "obligations",
        "occurrences",
        "cards",
        "purchases",
        "card-installments",
        "debts",
        "debt-installments",
        "categories",
        "budgets",
        "goals",
        "goal-members",
        "plans",
        "allocations",
        "fund-movements",
        "planner-budgets",
      ]);
      return buildPlanner(
        data,
        q.currency,
        q.month,
        req.userId,
        data.profile[0]?.timezone ?? "America/Lima",
        undefined,
        q.fund_amount,
      );
    },
  );
  api.put(
    "/savings/planner/budget",
    {
      schema: { summary: "Guardar configuración privada de capacidad mensual" },
    },
    async (req) => {
      const p = z
        .object({
          currency,
          month: firstDay,
          monthly_income: amount,
          savings_percentage: z.number().min(0).max(100),
          maximum_savings: amount,
          essential_expenses: amount,
        })
        .strict()
        .parse(req.body);
      await rpc(req, "save_planner_budget", { p });
      return { ok: true };
    },
  );
  api.put(
    "/savings/planner/plans",
    {
      schema: {
        summary:
          "Guardar planes propios y su autorización de visibilidad; no mueve dinero",
      },
    },
    async (req) => {
      const p = z
        .object({
          entries: z
            .array(
              z
                .object({
                  goal_id: uuid,
                  month: firstDay,
                  amount,
                  share_authorized: z.boolean(),
                })
                .strict(),
            )
            .min(1)
            .max(5000),
        })
        .strict()
        .parse(req.body);
      await rpc(req, "save_savings_plans", p);
      return { ok: true };
    },
  );
  api.get(
    "/savings/overview",
    {
      schema: {
        summary:
          "Indicadores de espacios y objetivos sin información financiera privada",
      },
    },
    async (req) => {
      const q = z.object({ currency, month }).parse(req.query);
      const data = await dataFor(req, [
        "profile",
        "spaces",
        "goals",
        "plans",
        "allocations",
        "goal-members",
      ]);
      const today = DateTime.now()
        .setZone(data.profile[0]?.timezone ?? "America/Lima")
        .toISODate()!;
      return sharedOverview(
        data,
        q.currency,
        q.month,
        today,
        data.profile[0]?.timezone ?? "America/Lima",
      );
    },
  );
}

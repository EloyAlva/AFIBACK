import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUI from "@fastify/swagger-ui";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { config } from "./config.js";
import {
  currency,
  date,
  money,
  purchase,
  resources,
  tables,
  transaction,
  uuid,
  statement,
  updates,
  type Resource,
} from "./schemas.js";
import { csv, summarize, type Row } from "./finance.js";
import { draftSchema, interpret } from "./ai.js";
import { registerPasswordRecovery } from "./password-recovery.js";
import { registerSecurityQuestions } from "./security-question.js";
import { registerAuth } from "./auth.js";
declare module "fastify" {
  interface FastifyRequest {
    db: SupabaseClient;
    userId: string;
  }
}
async function rpc(
  db: SupabaseClient,
  name: string,
  args: Record<string, unknown>,
) {
  const r = await db.rpc(name, args);
  if (r.error)
    throw Object.assign(new Error(r.error.message), { statusCode: 422 });
  return r.data;
}
async function all(db: SupabaseClient, table: string) {
  const rows: Row[] = [];
  for (let offset = 0; ; offset += 1000) {
    const r = await db
      .from(table)
      .select("*")
      .range(offset, offset + 999);
    if (r.error) throw r.error;
    rows.push(...r.data);
    if (r.data.length < 1000) break;
    if (offset >= 100000)
      throw Object.assign(new Error("Demasiados datos para este resumen"), {
        statusCode: 413,
      });
  }
  return rows;
}
export const serverOptions = {
  logger: config.NODE_ENV !== "test",
  bodyLimit: 32768,
  requestTimeout: 30000,
};

export async function buildApp(app = Fastify(serverOptions)) {
  await app.register(cors, {
    origin: config.FRONTEND_URL.split(",").map((s) => s.trim()),
    credentials: false,
  });
  await app.register(helmet);
  await app.register(rateLimit, {
    // Las cargas del panel consultan varios recursos; no consumen el cupo de escrituras.
    max: (request) => (request.method === "GET" ? 600 : 120),
    keyGenerator: (request) =>
      `${request.ip}:${request.method === "GET" ? "read" : "write"}`,
    timeWindow: "1 minute",
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      error: "Too Many Requests",
      message: `Demasiadas solicitudes. Vuelve a intentar en ${Math.max(1, Math.ceil(context.ttl / 1000))} segundos.`,
    }),
  });
  await app.register(swagger, {
    openapi: {
      info: {
        title: "AFI API",
        version: "1.0.0",
        description:
          "Finanzas privadas. JWT Supabase e Idempotency-Key UUID para operaciones financieras.",
      },
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        },
      },
      security: [{ bearerAuth: [] }],
    },
  });
  await app.register(swaggerUI, { routePrefix: "/docs" });
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Revisa los campos del formulario",
          details: error.issues,
          requestId: req.id,
        },
      });
    const e = error as Error & { statusCode?: number; code?: string };
    const status = e.statusCode ?? 500;
    if (status >= 500) req.log.error({ err: e }, "request failed");
    reply.code(status).send({
      error: {
        code:
          e.code ??
          (status === 401
            ? "UNAUTHORIZED"
            : status === 422
              ? "BUSINESS_RULE"
              : status === 429
                ? "RATE_LIMIT"
                : "REQUEST_ERROR"),
        message: status === 500 ? "Error interno del servidor" : e.message,
        requestId: req.id,
      },
    });
  });
  app.get(
    "/",
    { schema: { security: [], summary: "Información de AFIBACK" } },
    async () => ({
      service: "AFIBACK",
      status: "ok",
      health: "/health",
      api: "/api/v1",
      docs: "/docs",
    }),
  );
  app.get(
    "/health",
    {
      schema: { security: [], description: "Salud del proceso, sin secretos" },
    },
    async () => ({
      status: "ok",
      databaseConfigured: !!config.SUPABASE_URL,
      aiEnabled: config.AI_ENABLED,
    }),
  );
  await registerPasswordRecovery(app);
  await registerAuth(app);
  await registerSecurityQuestions(app);
  await app.register(
    async (api) => {
      api.addHook("preHandler", async (req) => {
        if (!config.SUPABASE_URL || !config.SUPABASE_ANON_KEY)
          throw Object.assign(new Error("Configura Supabase en el backend"), {
            statusCode: 503,
          });
        const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
        if (!token)
          throw Object.assign(new Error("Inicia sesión"), { statusCode: 401 });
        req.db = createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, {
          global: { headers: { Authorization: `Bearer ${token}` } },
          auth: { persistSession: false, autoRefreshToken: false },
        });
        const { data, error } = await req.db.auth.getUser(token);
        if (error || !data.user)
          throw Object.assign(new Error("Sesión inválida o vencida"), {
            statusCode: 401,
          });
        req.userId = data.user.id;
      });
      const key = (headers: Record<string, unknown>) =>
        uuid.parse(headers["idempotency-key"]);
      const bodyDoc = { type: "object", additionalProperties: true } as const;
      const financialHeaders = {
        type: "object",
        required: ["idempotency-key"],
        properties: { "idempotency-key": { type: "string", format: "uuid" } },
      } as const;
      for (const [resource, table] of Object.entries(tables)) {
        api.get(
          "/" + resource,
          {
            schema: {
              summary: `Listar ${resource}`,
              querystring: {
                type: "object",
                properties: {
                  page: { type: "integer", minimum: 1, default: 1 },
                  limit: {
                    type: "integer",
                    minimum: 1,
                    maximum: 100,
                    default: 30,
                  },
                  currency: { type: "string" },
                  from: { type: "string" },
                  to: { type: "string" },
                  type: { type: "string" },
                  search: { type: "string" },
                },
              },
            },
          },
          async (req) => {
            const q = z
              .object({
                page: z.coerce.number().int().positive().default(1),
                limit: z.coerce.number().int().positive().max(100).default(30),
                currency: currency.optional(),
                from: date.optional(),
                to: date.optional(),
                type: z.string().max(40).optional(),
                search: z.string().max(120).optional(),
              })
              .parse(req.query);
            if (resource === "members") {
              const r = await rpc(req.db, "list_shared_members", {});
              return {
                data: r.slice((q.page - 1) * q.limit, q.page * q.limit),
                page: q.page,
                limit: q.limit,
                total: r.length,
              };
            }
            let query = req.db
              .from(table)
              .select(
                resource === "invitations"
                  ? "id,space_id,email,status,expires_at,created_at"
                  : "*",
                { count: "exact" },
              );
            if (
              q.currency &&
              [
                "accounts",
                "cards",
                "debts",
                "transactions",
                "obligations",
                "occurrences",
                "budgets",
                "goals",
                "allocations",
              ].includes(resource)
            )
              query = query.eq("currency", q.currency);
            if (resource === "transactions") {
              query = query
                .order("occurred_at", { ascending: false })
                .order("id");
              if (q.from)
                query = query.gte("occurred_at", q.from + "T00:00:00Z");
              if (q.to)
                query = query.lt(
                  "occurred_at",
                  new Date(new Date(q.to).valueOf() + 86400000).toISOString(),
                );
              if (q.type) query = query.eq("type", q.type);
              if (q.search)
                query = query.ilike(
                  "description",
                  "%" + q.search.replace(/[%_]/g, "") + "%",
                );
            } else if (
              [
                "occurrences",
                "card-installments",
                "debt-installments",
              ].includes(resource)
            )
              query = query.order("due_date").order("id");
            else if (
              !["members", "goal-members", "profile", "preferences"].includes(
                resource,
              )
            )
              query = query.order("id");
            const r = await query.range(
              (q.page - 1) * q.limit,
              q.page * q.limit - 1,
            );
            if (r.error) throw r.error;
            return {
              data: r.data,
              page: q.page,
              limit: q.limit,
              total: r.count,
            };
          },
        );
      }
      for (const resource of Object.keys(resources) as Resource[])
        api.post(
          "/" + resource,
          {
            schema: {
              summary: `Crear ${resource}`,
              body: z.toJSONSchema(resources[resource], {
                target: "draft-7",
                unrepresentable: "any",
              }),
            },
          },
          async (req, reply) => {
            const p = resources[resource].parse(req.body);
            return reply.code(201).send({
              id: await rpc(req.db, "create_resource", { resource, p }),
            });
          },
        );
      for (const [resource, schema] of Object.entries(updates))
        api.patch(
          "/" + resource + "/:id",
          {
            schema: {
              summary: `Actualizar ${resource}`,
              body: z.toJSONSchema(schema, {
                target: "draft-7",
                unrepresentable: "any",
              }),
            },
          },
          async (req) => {
            const p = schema.parse(req.body);
            await rpc(req.db, "update_resource", {
              resource,
              rid: uuid.parse((req.params as any).id),
              p,
            });
            return { ok: true };
          },
        );
      api.post(
        "/transactions",
        {
          schema: {
            summary: "Registrar movimiento atómico",
            body: bodyDoc,
            headers: financialHeaders,
          },
        },
        async (req, reply) =>
          reply.code(201).send({
            id: await rpc(req.db, "record_transaction", {
              p: transaction.parse(req.body),
              k: key(req.headers),
            }),
          }),
      );
      api.post(
        "/transactions/:id/void",
        { schema: { summary: "Anular sin borrar el historial" } },
        async (req) => {
          await rpc(req.db, "void_transaction", {
            tid: uuid.parse((req.params as any).id),
          });
          return { ok: true };
        },
      );
      api.put(
        "/transactions/:id",
        {
          schema: {
            summary: "Editar mediante reversión y reemplazo atómicos",
            body: bodyDoc,
            headers: financialHeaders,
          },
        },
        async (req) => ({
          id: await rpc(req.db, "replace_transaction", {
            tid: uuid.parse((req.params as any).id),
            p: transaction.parse(req.body),
            k: key(req.headers),
          }),
        }),
      );
      api.get(
        "/export/transactions.csv",
        { schema: { summary: "Exportar movimientos (RLS)" } },
        async (req, reply) =>
          reply
            .type("text/csv; charset=utf-8")
            .header(
              "Content-Disposition",
              'attachment; filename="afi-movimientos.csv"',
            )
            .send(csv(await all(req.db, "financial_transactions"))),
      );
      api.post(
        "/purchases",
        {
          schema: {
            summary: "Compra, interés, comisión o devolución de tarjeta",
            body: bodyDoc,
            headers: financialHeaders,
          },
        },
        async (req) => ({
          id: await rpc(req.db, "record_purchase", {
            p: purchase.parse(req.body),
            k: key(req.headers),
          }),
        }),
      );
      api.post(
        "/statements",
        {
          schema: {
            summary: "Estado bancario: facturado, pago mínimo y exigible",
            body: bodyDoc,
          },
        },
        async (req) => ({
          id: await rpc(req.db, "record_statement", {
            p: statement.parse(req.body),
          }),
        }),
      );
      api.post(
        "/debts/:id/schedule",
        { schema: { summary: "Integrar cuotas del préstamo al calendario" } },
        async (req) => {
          await rpc(req.db, "sync_debt_schedule", {
            d: uuid.parse((req.params as any).id),
          });
          return { ok: true };
        },
      );
      api.post(
        "/occurrences/generate",
        {
          schema: {
            summary: "Generación recurrente sin duplicados",
            body: bodyDoc,
          },
        },
        async (req) => {
          const p = z.object({ from: date, to: date }).parse(req.body);
          return {
            created: await rpc(req.db, "generate_occurrences", {
              from_date: p.from,
              to_date: p.to,
            }),
          };
        },
      );
      api.get(
        "/dashboard",
        { schema: { summary: "Indicadores calculados sin mezclar monedas" } },
        async (req) => {
          const q = z
            .object({
              currency: currency.default("PEN"),
              month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
            })
            .parse(req.query);
          const profile = await req.db
            .from("profiles")
            .select("timezone")
            .single();
          if (profile.error) throw profile.error;
          const names = [
            "accounts",
            "transactions",
            "entries",
            "payments",
            "cards",
            "purchases",
            "debts",
            "debt-installments",
            "obligations",
            "occurrences",
            "budgets",
            "goals",
            "allocations",
            "plans",
            "fund-movements",
            "categories",
            "preferences",
          ];
          const entries = await Promise.all(
            names.map(async (n) => [n, await all(req.db, tables[n])] as const),
          );
          return summarize(
            Object.fromEntries(entries),
            q.currency,
            q.month,
            profile.data.timezone,
            req.userId,
          );
        },
      );
      api.post(
        "/allocations",
        {
          schema: {
            summary: "Asignar o retirar ahorro confirmado",
            body: bodyDoc,
            headers: financialHeaders,
          },
        },
        async (req) => {
          const p = z
            .object({
              goal_id: uuid,
              amount: z.coerce
                .number()
                .refine(
                  (v) =>
                    v !== 0 &&
                    Math.abs(v) <= 999999999999 &&
                    Math.abs(v * 100 - Math.round(v * 100)) < 0.001,
                ),
            })
            .parse(req.body);
          return {
            id: await rpc(req.db, "allocate_savings", {
              g: p.goal_id,
              amt: p.amount,
              k: key(req.headers),
            }),
          };
        },
      );
      api.post(
        "/plans",
        {
          schema: { summary: "Planificar ahorro; admite cero", body: bodyDoc },
        },
        async (req) => {
          const p = z
            .object({
              goal_id: uuid,
              month: date,
              amount: money.or(z.literal(0)),
            })
            .parse(req.body);
          return {
            id: await rpc(req.db, "plan_savings", {
              g: p.goal_id,
              m: p.month,
              amt: p.amount,
            }),
          };
        },
      );
      api.post(
        "/savings/distribute",
        {
          schema: {
            summary: "Distribuir fondo por porcentajes con confirmación",
            body: bodyDoc,
            headers: financialHeaders,
          },
        },
        async (req) => {
          const p = z
            .object({
              amount: money,
              currency,
              distribution: z
                .array(
                  z.object({
                    goal_id: uuid.nullable(),
                    percentage: z.number().min(0).max(100),
                  }),
                )
                .min(1)
                .max(100),
            })
            .refine(
              (p) =>
                Math.abs(
                  p.distribution.reduce((a, r) => a + r.percentage, 0) - 100,
                ) < 0.00001,
            )
            .parse(req.body);
          return {
            id: await rpc(req.db, "distribute_savings", {
              p,
              k: key(req.headers),
            }),
          };
        },
      );
      api.post(
        "/savings/reallocate",
        {
          schema: {
            summary: "Reasignar ahorro atómicamente entre objetivos",
            body: bodyDoc,
            headers: financialHeaders,
          },
        },
        async (req) => {
          const p = z
            .object({ from_goal: uuid, to_goal: uuid, amount: money })
            .parse(req.body);
          return {
            id: await rpc(req.db, "reallocate_savings", {
              from_goal: p.from_goal,
              to_goal: p.to_goal,
              amt: p.amount,
              k: key(req.headers),
            }),
          };
        },
      );
      api.get("/users/search", async (req) => {
        const p = z
          .object({ space_id: uuid, q: z.string().max(80).default("") })
          .parse(req.query);
        return {
          data: await rpc(req.db, "search_registered_users", {
            s: p.space_id,
            q: p.q,
          }),
        };
      });
      api.get("/invitations/incoming", async (req) => ({
        data: await rpc(req.db, "incoming_invitations", {}),
      }));
      api.post(
        "/spaces/:id/invite-user",
        { schema: { body: bodyDoc } },
        async (req) => {
          const p = z
            .object({ user_id: uuid, goal_id: uuid.nullable().optional() })
            .parse(req.body);
          return {
            id: await rpc(req.db, "invite_registered_user", {
              s: uuid.parse((req.params as any).id),
              target: p.user_id,
              g: p.goal_id ?? null,
            }),
          };
        },
      );
      api.post(
        "/invitations/:id/respond",
        { schema: { body: bodyDoc } },
        async (req) => {
          const p = z.object({ accept: z.boolean() }).parse(req.body);
          return {
            space_id: await rpc(req.db, "respond_registered_invitation", {
              invitation_id: uuid.parse((req.params as any).id),
              accept: p.accept,
            }),
          };
        },
      );
      api.post(
        "/spaces/:id/invitations",
        {
          schema: {
            summary: "Crear enlace seguro; no envía correo",
            body: bodyDoc,
          },
        },
        async (req) => {
          const p = z.object({ email: z.email() }).parse(req.body);
          return rpc(req.db, "invite_member", {
            s: uuid.parse((req.params as any).id),
            email_address: p.email,
          });
        },
      );
      api.post(
        "/invitations/respond",
        {
          schema: {
            summary: "Aceptar o rechazar con correo del JWT",
            body: bodyDoc,
          },
        },
        async (req) => {
          const p = z
            .object({
              token: z.string().regex(/^[a-f0-9]{64}$/),
              accept: z.boolean(),
            })
            .parse(req.body);
          return { space_id: await rpc(req.db, "respond_invitation", p) };
        },
      );
      api.post(
        "/spaces/:id/manage",
        {
          schema: {
            summary: "Administrar miembros e invitaciones",
            body: bodyDoc,
          },
        },
        async (req) => {
          const p = z
            .object({
              operation: z.enum(["revoke", "remove", "allow_goals"]),
              target: uuid,
              flag: z.boolean().default(false),
            })
            .parse(req.body);
          await rpc(req.db, "manage_space", {
            s: uuid.parse((req.params as any).id),
            ...p,
          });
          return { ok: true };
        },
      );
      api.put(
        "/goals/:id/members",
        {
          schema: {
            summary: "Porcentajes de participación (100%)",
            body: bodyDoc,
          },
        },
        async (req) => {
          const p = z
            .object({
              members: z
                .array(
                  z.object({
                    user_id: uuid,
                    percentage: z.number().min(0).max(100),
                  }),
                )
                .min(1),
            })
            .parse(req.body);
          await rpc(req.db, "set_goal_members", {
            g: uuid.parse((req.params as any).id),
            members: p.members,
          });
          return { ok: true };
        },
      );
      api.put(
        "/profile",
        {
          schema: {
            summary: "Actualizar perfil y preferencias",
            body: bodyDoc,
          },
        },
        async (req) => {
          const p = z
            .object({
              display_name: z.string().max(120),
              currency,
              timezone: z.string().max(80),
              ant_expense_threshold: z.coerce
                .number()
                .nonnegative()
                .max(100000),
              budget_thresholds: z
                .array(z.number().int().min(1).max(100))
                .min(1)
                .max(10)
                .default([80, 90, 100]),
            })
            .parse(req.body);
          await rpc(req.db, "update_profile", { p });
          return { ok: true };
        },
      );
      api.post(
        "/notifications/refresh",
        { schema: { summary: "Generar alertas por reglas" } },
        async (req) => {
          await rpc(req.db, "refresh_notifications", {});
          return { ok: true };
        },
      );
      api.post(
        "/notifications/:id/read",
        { schema: { summary: "Marcar leída; no registra pago" } },
        async (req) => {
          await rpc(req.db, "read_notification", {
            n: uuid.parse((req.params as any).id),
          });
          return { ok: true };
        },
      );
      api.post(
        "/ai/interpret",
        {
          config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
          schema: {
            summary: "Interpretación sin escritura financiera",
            body: bodyDoc,
            headers: financialHeaders,
          },
        },
        async (req) => {
          const p = z
            .object({ message: z.string().min(1).max(3000) })
            .parse(req.body);
          return interpret(req.db, req.userId, key(req.headers), p.message);
        },
      );
      api.post(
        "/ai/drafts",
        {
          schema: {
            summary: "Preparar resumen editable; no registra movimiento",
            body: bodyDoc,
          },
        },
        async (req) => ({
          id: await rpc(req.db, "save_ai_draft", {
            p: draftSchema.parse(req.body),
          }),
        }),
      );
      api.get(
        "/ai/drafts/:id",
        {
          schema: {
            summary:
              "Recuperar el borrador propio y comprobar si ya fue registrado",
          },
        },
        async (req) => {
          const id = uuid.parse((req.params as { id: string }).id);
          const result = await req.db
            .from("ai_drafts")
            .select("id,payload,transaction_id,expires_at")
            .eq("id", id)
            .single();
          if (result.error || !result.data)
            throw Object.assign(new Error("Borrador no disponible."), {
              statusCode: 404,
            });
          return result.data;
        },
      );
      api.post(
        "/ai/drafts/:id/confirm",
        {
          schema: {
            summary: "Confirmar explícitamente el movimiento",
            body: bodyDoc,
            headers: financialHeaders,
          },
        },
        async (req) => {
          const p = z.object({ confirmed: z.literal(true) }).parse(req.body);
          return {
            id: await rpc(req.db, "confirm_ai_draft", {
              d: uuid.parse((req.params as any).id),
              k: key(req.headers),
              confirmed: p.confirmed,
            }),
          };
        },
      );
    },
    { prefix: "/api/v1" },
  );
  return app;
}

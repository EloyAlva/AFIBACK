import { randomBytes, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { FastifyInstance } from "fastify";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { config } from "./config.js";
import { answerHash, codeHash } from "./recovery-crypto.js";
import { SupabaseRecoveryStore } from "./supabase-recovery.js";
export { normalizeAnswer } from "./recovery-crypto.js";

type Awaitable<T> = T | Promise<T>;
export interface RecoveryVault {
  issue(
    userId: string,
    email: string,
    now?: number,
  ): Awaitable<{ code: string; expiresAt: string }>;
  consume(email: string, code: string, now?: number): Awaitable<string | null>;
  question(email: string): Awaitable<string | null>;
  setQuestion(
    userId: string,
    email: string,
    question: string,
    answer: string,
  ): Promise<void>;
  verifyAnswer(
    email: string,
    answer: string,
    now?: number,
  ): Promise<{ userId: string; claim: string } | null>;
  finishAnswer(
    email: string,
    claim: string,
    success: boolean,
    now?: number,
  ): Awaitable<void>;
  close(): Awaitable<void>;
}
export function createRecoveryStore(
  remote = process.env.VERCEL === "1" || config.NODE_ENV === "production",
): RecoveryVault {
  return remote ? new SupabaseRecoveryStore() : new RecoveryStore();
}

export function recoveryEmail(username: string) {
  const value = username.trim().toLowerCase();
  return z.email().parse(value.includes("@") ? value : value + "@afi.com");
}
export const passwordRecoverySchema = z
  .object({
    username: z.string().min(1).max(254).transform(recoveryEmail),
    code: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{43}$/),
    password: z
      .string()
      .min(12)
      .refine((p) => Buffer.byteLength(p, "utf8") <= 72),
    confirmation: z.string(),
  })
  .strict()
  .refine(
    (p) => p.password === p.confirmation,
    "Las contraseñas no coinciden.",
  );

export class RecoveryStore {
  private db: DatabaseSync;
  constructor(
    path = process.env.RECOVERY_DATABASE_PATH ??
      ".data/password-recovery.sqlite",
  ) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`pragma busy_timeout=5000;
   create table if not exists recovery_codes(token_hash text primary key,user_id text not null,email text not null,expires_at integer not null,used_at integer);
   create index if not exists recovery_codes_email on recovery_codes(email);
   create table if not exists security_questions(email text primary key,user_id text not null,question text not null,answer_salt text not null,answer_hash text not null,failures integer not null default 0,locked_until integer not null default 0,busy_until integer not null default 0,claim text not null default '');
  `);
  }
  issue(userId: string, email: string, now = Date.now()) {
    const code = randomBytes(32).toString("base64url");
    const expiresAt = now + 30 * 60 * 1000;
    this.db.exec("begin immediate");
    try {
      this.db
        .prepare(
          "update recovery_codes set used_at=? where email=? and used_at is null",
        )
        .run(now, email);
      this.db
        .prepare(
          "insert into recovery_codes(token_hash,user_id,email,expires_at) values(?,?,?,?)",
        )
        .run(this.hash(code), userId, email, expiresAt);
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }
  consume(email: string, code: string, now = Date.now()): string | null {
    const row = this.db
      .prepare(
        "update recovery_codes set used_at=? where token_hash=? and email=? and used_at is null and expires_at>? returning user_id",
      )
      .get(now, this.hash(code), email, now);
    return (row?.user_id as string) ?? null;
  }
  close() {
    this.db.close();
  }
  question(email: string) {
    return (
      (this.db
        .prepare("select question from security_questions where email=?")
        .get(email)?.question as string) ?? null
    );
  }
  async setQuestion(
    userId: string,
    email: string,
    question: string,
    answer: string,
  ) {
    const salt = randomBytes(16).toString("hex");
    const hash = await answerHash(answer, salt);
    const saved = this.db
      .prepare(
        `insert into security_questions(email,user_id,question,answer_salt,answer_hash) values(?,?,?,?,?)
      on conflict(email) do update set user_id=excluded.user_id,question=excluded.question,answer_salt=excluded.answer_salt,answer_hash=excluded.answer_hash,failures=0,locked_until=0,busy_until=0,claim='' where security_questions.busy_until<=?`,
      )
      .run(email, userId, question, salt, hash.toString("hex"), Date.now());
    if (Number(saved.changes) !== 1)
      throw Object.assign(
        new Error(
          "Hay una recuperación en curso. Inténtalo de nuevo en un minuto.",
        ),
        { statusCode: 409 },
      );
  }
  async verifyAnswer(
    email: string,
    answer: string,
    now = Date.now(),
  ): Promise<{ userId: string; claim: string } | null> {
    const claim = randomBytes(16).toString("hex");
    const row = this.db
      .prepare(
        `update security_questions set failures=case when locked_until>0 then 1 else failures+1 end,locked_until=case when locked_until>0 then 0 else locked_until end,busy_until=?,claim=?
      where email=? and locked_until<=? and busy_until<=? returning user_id,answer_salt,answer_hash,failures`,
      )
      .get(now + 60000, claim, email, now, now);
    if (!row) return null;
    try {
      const hash = await answerHash(answer, row.answer_salt as string);
      const stored = Buffer.from(row.answer_hash as string, "hex");
      if (hash.length === stored.length && timingSafeEqual(hash, stored))
        return { userId: row.user_id as string, claim };
      this.finishAnswer(email, claim, false, now);
      return null;
    } catch (error) {
      this.finishAnswer(email, claim, false, now);
      throw error;
    }
  }
  finishAnswer(
    email: string,
    claim: string,
    success: boolean,
    now = Date.now(),
  ) {
    this.db
      .prepare(
        `update security_questions set failures=case when ? then 0 else failures end,
      locked_until=case when ? then 0 when failures>=5 then ? else 0 end,busy_until=0,claim='' where email=? and claim=?`,
      )
      .run(
        success ? 1 : 0,
        success ? 1 : 0,
        now + 30 * 60 * 1000,
        email,
        claim,
      );
  }
  private hash(code: string) {
    return codeHash(code);
  }
}

export type RecoveryAdmin = {
  getUser(id: string): Promise<{ id: string; email?: string } | null>;
  setPassword(id: string, password: string): Promise<boolean>;
};
export function recoveryAdmin(): RecoveryAdmin {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key || !config.SUPABASE_URL)
    throw Object.assign(
      new Error("La recuperación requiere configuración del administrador."),
      { statusCode: 503 },
    );
  const admin = createClient(config.SUPABASE_URL, key, {
    global: {
      fetch: (input, init) =>
        fetch(input, { ...init, signal: AbortSignal.timeout(15000) }),
    },
    auth: { persistSession: false, autoRefreshToken: false },
  }).auth.admin;
  return {
    async getUser(id) {
      const { data, error } = await admin.getUserById(id);
      if (error) return null;
      return data.user;
    },
    async setPassword(id, password) {
      const { error } = await admin.updateUserById(id, { password });
      return !error;
    },
  };
}

export async function registerPasswordRecovery(
  app: FastifyInstance,
  options: { store?: RecoveryVault; admin?: () => RecoveryAdmin } = {},
) {
  let store = options.store;
  app.addHook("onClose", async () => {
    if (!options.store) await store?.close();
  });
  app.post(
    "/api/v1/auth/password-recovery",
    {
      config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
      schema: {
        security: [],
        summary:
          "Cambiar contraseña con código privado de un solo uso; no requiere correo",
        body: {
          type: "object",
          required: ["username", "code", "password", "confirmation"],
          additionalProperties: false,
          properties: {
            username: { type: "string" },
            code: { type: "string" },
            password: { type: "string" },
            confirmation: { type: "string" },
          },
        },
      },
    },
    async (req) => {
      const p = passwordRecoverySchema.parse(req.body);
      const admin = (options.admin ?? recoveryAdmin)();
      store ??= createRecoveryStore();
      const userId = await store.consume(p.username, p.code);
      const invalid = () =>
        Object.assign(
          new Error(
            "Usuario o código de recuperación inválido, vencido o ya utilizado.",
          ),
          { statusCode: 400 },
        );
      if (!userId) throw invalid();
      const user = await admin.getUser(userId);
      if (!user || user.email?.toLowerCase() !== p.username) throw invalid();
      // Consume before the external write: concurrent requests cannot reuse a code.
      // Timeouts never reopen it; the administrator issues a fresh code if necessary.
      const changed = await admin.setPassword(user.id, p.password);
      if (!changed)
        throw Object.assign(
          new Error(
            "No se pudo actualizar la contraseña. Solicita un nuevo código al administrador.",
          ),
          { statusCode: 503 },
        );
      return {
        ok: true,
        message:
          "Contraseña actualizada. Ya puedes iniciar sesión con tu nueva clave.",
      };
    },
  );
}

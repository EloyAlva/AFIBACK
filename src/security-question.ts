import type { FastifyInstance } from "fastify";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { config } from "./config.js";
import {
  RecoveryStore,
  recoveryAdmin,
  recoveryEmail,
  normalizeAnswer,
  type RecoveryAdmin,
} from "./password-recovery.js";

const username = z.string().min(1).max(254).transform(recoveryEmail);
const answer = z
  .string()
  .max(200)
  .refine(
    (a) => normalizeAnswer(a).length >= 8,
    "Usa una respuesta privada de al menos ocho caracteres.",
  );
const question = z.string().trim().min(10).max(180);
const password = z
  .string()
  .min(12)
  .refine((p) => Buffer.byteLength(p, "utf8") <= 72);
const setup = z
  .object({
    username,
    question,
    answer,
    answerConfirmation: z.string(),
    currentPassword: z.string().max(256).optional(),
    code: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .optional(),
  })
  .strict()
  .refine(
    (p) => normalizeAnswer(p.answer) === normalizeAnswer(p.answerConfirmation),
    "Las respuestas no coinciden.",
  )
  .refine(
    (p) => normalizeAnswer(p.question) !== normalizeAnswer(p.answer),
    "La respuesta debe ser diferente a la pregunta.",
  );
const reset = z
  .object({ username, answer, password, confirmation: z.string() })
  .strict()
  .refine(
    (p) => p.password === p.confirmation,
    "Las contraseñas no coinciden.",
  );
type Identity = { id: string; email: string };
type Options = {
  store?: RecoveryStore;
  admin?: () => RecoveryAdmin;
  authorize?: (token: string, password: string) => Promise<Identity | null>;
};

async function authorize(
  token: string,
  currentPassword: string,
): Promise<Identity | null> {
  if (!config.SUPABASE_URL || !config.SUPABASE_ANON_KEY) return null;
  const verifier = createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init) =>
        fetch(input, { ...init, signal: AbortSignal.timeout(15000) }),
    },
  });
  const { data, error } = await verifier.auth.getUser(token);
  if (error || !data.user?.email) return null;
  const login = await verifier.auth.signInWithPassword({
    email: data.user.email,
    password: currentPassword,
  });
  if (login.error || login.data.user?.id !== data.user.id) return null;
  await verifier.auth.signOut({ scope: "local" });
  return { id: data.user.id, email: data.user.email.toLowerCase() };
}

export async function registerSecurityQuestions(
  app: FastifyInstance,
  options: Options = {},
) {
  let store = options.store;
  const vault = () => (store ??= new RecoveryStore());
  app.addHook("onClose", async () => {
    if (!options.store) store?.close();
  });
  const rate = { rateLimit: { max: 5, timeWindow: "15 minutes" } };
  app.post(
    "/api/v1/auth/security-question/lookup",
    {
      config: { rateLimit: { max: 15, timeWindow: "15 minutes" } },
      schema: {
        security: [],
        summary:
          "Consultar pregunta de recuperación; nunca devuelve la respuesta",
      },
    },
    async (req) => {
      const p = z.object({ username }).strict().parse(req.body);
      return { question: vault().question(p.username) };
    },
  );
  app.post(
    "/api/v1/auth/security-question/setup",
    {
      config: rate,
      schema: {
        security: [],
        summary:
          "Configurar pregunta con sesión y clave actual o con código privado",
      },
    },
    async (req) => {
      const p = setup.parse(req.body);
      let identity: Identity | null = null;
      const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
      if (token && p.currentPassword)
        identity = await (options.authorize ?? authorize)(
          token,
          p.currentPassword,
        );
      else if (p.code) {
        const uid = vault().consume(p.username, p.code);
        if (uid) {
          const user = await (options.admin ?? recoveryAdmin)().getUser(uid);
          if (user?.email)
            identity = { id: user.id, email: user.email.toLowerCase() };
        }
      }
      if (!identity || identity.email !== p.username)
        throw Object.assign(
          new Error(
            "Confirma tu identidad con tu sesión y clave actual, o con un código de recuperación válido.",
          ),
          { statusCode: 401 },
        );
      await vault().setQuestion(
        identity.id,
        identity.email,
        p.question,
        p.answer,
      );
      return { ok: true };
    },
  );
  app.post(
    "/api/v1/auth/security-question/reset",
    {
      config: rate,
      schema: {
        security: [],
        summary:
          "Restablecer clave verificando la respuesta; bloqueo tras cinco fallos",
      },
    },
    async (req) => {
      const p = reset.parse(req.body);
      const admin = (options.admin ?? recoveryAdmin)();
      const verified = await vault().verifyAnswer(p.username, p.answer);
      if (!verified)
        throw Object.assign(
          new Error(
            "Respuesta incorrecta o recuperación no disponible. Después de cinco fallos debes esperar 30 minutos.",
          ),
          { statusCode: 400 },
        );
      let success = false;
      try {
        const user = await admin.getUser(verified.userId);
        if (!user || user.email?.toLowerCase() !== p.username)
          throw new Error("User mismatch");
        success = await admin.setPassword(user.id, p.password);
        if (!success) throw new Error("Auth rejected update");
        return { ok: true };
      } catch {
        throw Object.assign(
          new Error(
            "No se pudo actualizar la contraseña. Inténtalo de nuevo más tarde.",
          ),
          { statusCode: 503 },
        );
      } finally {
        vault().finishAnswer(p.username, verified.claim, success);
      }
    },
  );
}

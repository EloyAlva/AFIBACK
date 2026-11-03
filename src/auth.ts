import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "./config.js";
import { recoveryEmail } from "./password-recovery.js";

const identity = z.string().trim().min(1).max(254).transform(recoveryEmail);
const password = z
  .string()
  .min(12)
  .refine((p) => Buffer.byteLength(p, "utf8") <= 72);
const credentials = z
  .object({ email: identity, password: z.string().min(1).max(256) })
  .strict();
const tokenPair = z
  .object({
    access_token: z.string().min(1).max(16384),
    refresh_token: z.string().min(1).max(4096),
  })
  .strict();
const messages: Record<string, string> = {
  invalid_credentials: "Usuario o contraseña incorrectos.",
  invalid_password: "La contraseña actual no es correcta.",
  same_password: "Elige una contraseña diferente a la actual.",
  weak_password: "La nueva contraseña no cumple los requisitos de seguridad.",
  email_not_confirmed: "Debes confirmar tu cuenta antes de iniciar sesión.",
};
function failure(message: string, statusCode: number, code = "AUTH_ERROR") {
  return Object.assign(new Error(message), { statusCode, code });
}
function bearer(req: FastifyRequest) {
  const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!token) throw failure("Inicia sesión para continuar", 401);
  return token;
}
function userSummary(u: any) {
  return {
    id: u.id,
    email: u.email ?? "",
    user_metadata: { display_name: u.user_metadata?.display_name ?? "" },
  };
}
function sessionSummary(value: any) {
  if (!value?.access_token || !value?.refresh_token || !value.user?.id)
    throw failure("No se pudo validar la sesión", 502);
  return {
    access_token: value.access_token,
    refresh_token: value.refresh_token,
    expires_at:
      value.expires_at ??
      Math.floor(Date.now() / 1000) + (value.expires_in ?? 3600),
    user: userSummary(value.user),
  };
}

/** Only these operations can reach Supabase Auth; provider credentials stay on the server. */
export async function registerAuth(
  app: FastifyInstance,
  options: {
    fetch?: typeof fetch;
    supabaseUrl?: string;
    anonKey?: string;
  } = {},
) {
  const supabaseUrl = options.supabaseUrl ?? config.SUPABASE_URL;
  const anonKey = options.anonKey ?? config.SUPABASE_ANON_KEY;
  const request = async (
    path: string,
    method: string,
    body?: unknown,
    token?: string,
  ) => {
    if (!supabaseUrl || !anonKey)
      throw failure("Configura Supabase en el backend", 503);
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(
        supabaseUrl + "/auth/v1" + path,
        {
          method,
          headers: {
            apikey: anonKey,
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(15000),
        },
      );
    } catch {
      throw failure(
        "El servicio de acceso no responde. Inténtalo nuevamente.",
        503,
      );
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const code = data.error_code ?? data.code ?? "AUTH_ERROR";
      throw failure(
        messages[code] ??
          data.msg ??
          data.message ??
          data.error_description ??
          "No se pudo completar la autenticación",
        response.status >= 500 ? 503 : response.status,
        code,
      );
    }
    return data;
  };
  const redirect = (value: unknown) => {
    const allowed = config.FRONTEND_URL.split(",").map((s) => s.trim());
    const target = typeof value === "string" ? value : allowed[0];
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      throw failure("URL de retorno inválida", 400);
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      !allowed.some((origin) => new URL(origin).origin === url.origin)
    )
      throw failure("URL de retorno no permitida", 400);
    return url.href;
  };
  await app.register(
    async (routes) => {
      routes.addHook("onRequest", async (_req, reply) => {
        reply.header("Cache-Control", "no-store");
      });
      routes.post(
        "/login",
        { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
        async (req) => {
          const p = credentials.parse(req.body);
          return {
            session: sessionSummary(
              await request("/token?grant_type=password", "POST", p),
            ),
          };
        },
      );
      routes.post(
        "/register",
        { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
        async (req) => {
          const p = credentials
            .extend({
              password,
              display_name: z.string().trim().min(1).max(120),
              redirect_to: z.string().max(2048).optional(),
            })
            .parse(req.body);
          const data = await request(
            "/signup?redirect_to=" +
              encodeURIComponent(redirect(p.redirect_to)),
            "POST",
            {
              email: p.email,
              password: p.password,
              data: { display_name: p.display_name },
            },
          );
          return { session: data.access_token ? sessionSummary(data) : null };
        },
      );
      routes.post(
        "/refresh",
        { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
        async (req) => {
          const p = z
            .object({ refresh_token: tokenPair.shape.refresh_token })
            .strict()
            .parse(req.body);
          return {
            session: sessionSummary(
              await request("/token?grant_type=refresh_token", "POST", p),
            ),
          };
        },
      );
      routes.post("/session", async (req) => {
        const p = tokenPair.parse(req.body);
        const user = await request("/user", "GET", undefined, p.access_token);
        let expiry: number;
        try {
          expiry = JSON.parse(
            Buffer.from(p.access_token.split(".")[1], "base64url").toString(),
          ).exp;
        } catch {
          throw failure("Enlace de acceso inválido", 401);
        }
        if (!Number.isFinite(expiry) || expiry <= Date.now() / 1000)
          throw failure("El enlace de acceso venció", 401);
        return { session: sessionSummary({ ...p, user, expires_at: expiry }) };
      });
      routes.post("/logout", async (req) => {
        const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
        if (!token) return { ok: true };
        try {
          await request("/logout?scope=local", "POST", undefined, token);
        } catch (error) {
          // Match Supabase signOut: expired/missing sessions are already signed out.
          if (
            ![401, 403, 404].includes(
              (error as { statusCode?: number }).statusCode ?? 0,
            )
          )
            throw error;
        }
        return { ok: true };
      });
      routes.post(
        "/recover",
        { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
        async (req) => {
          const p = z
            .object({
              email: identity,
              redirect_to: z.string().max(2048).optional(),
            })
            .strict()
            .parse(req.body);
          await request(
            "/recover?redirect_to=" +
              encodeURIComponent(redirect(p.redirect_to)),
            "POST",
            { email: p.email },
          );
          return { ok: true };
        },
      );
      routes.put(
        "/password",
        { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
        async (req) => {
          const p = z
            .object({
              password,
              current_password: z.string().min(1).max(256).optional(),
              nonce: z.string().max(256).optional(),
            })
            .strict()
            .parse(req.body);
          const token = bearer(req);
          // Verify the token with Auth. Never trust a user ID or email from the browser.
          const user = await request("/user", "GET", undefined, token);
          if (p.current_password) {
            const verified = await request(
              "/token?grant_type=password",
              "POST",
              { email: user.email, password: p.current_password },
            );
            if (verified.user?.id !== user.id)
              throw failure(
                "La contraseña actual no es correcta.",
                400,
                "invalid_password",
              );
            // Close the short-lived verification session, preserving the user's original session.
            await request(
              "/logout?scope=local",
              "POST",
              undefined,
              verified.access_token,
            );
          }
          const updated = await request("/user", "PUT", p, token);
          return { user: userSummary(updated) };
        },
      );
      routes.post(
        "/reauthenticate",
        { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
        async (req) => {
          const token = bearer(req);
          await request("/user", "GET", undefined, token);
          await request("/reauthenticate", "GET", undefined, token);
          return { ok: true };
        },
      );
    },
    { prefix: "/api/v1/auth" },
  );
}

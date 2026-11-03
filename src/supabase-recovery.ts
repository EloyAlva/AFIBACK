import { randomBytes, timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { config } from "./config.js";
import { answerHash, codeHash } from "./recovery-crypto.js";
import type { RecoveryVault } from "./password-recovery.js";

type Rpc = (name: string, args: Record<string, unknown>) => Promise<any>;
export class SupabaseRecoveryStore implements RecoveryVault {
  private invoke: Rpc;
  constructor(rpc?: Rpc) {
    if (rpc) {
      this.invoke = rpc;
      return;
    }
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!key || !config.SUPABASE_URL)
      throw Object.assign(
        Error("Configura Supabase en el backend para la recuperación."),
        { statusCode: 503, code: "RECOVERY_UNAVAILABLE" },
      );
    const db = createClient(config.SUPABASE_URL, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: (input, init) =>
          fetch(input, { ...init, signal: AbortSignal.timeout(15000) }),
      },
    });
    this.invoke = async (name, args) => {
      const { data, error } = await db.rpc(name, args);
      if (error)
        throw Object.assign(
          Error(
            ["PGRST202", "42P01", "42883"].includes(error.code)
              ? "Falta aplicar la migración 009 de recuperación privada en Supabase."
              : "La recuperación no está disponible temporalmente. Inténtalo nuevamente.",
          ),
          { statusCode: 503, code: "RECOVERY_UNAVAILABLE" },
        );
      return data;
    };
  }
  async issue(userId: string, email: string, now = Date.now()) {
    const code = randomBytes(32).toString("base64url"),
      expiresAt = new Date(now + 30 * 60 * 1000).toISOString();
    await this.invoke("afi_recovery_issue", {
      p_user: userId,
      p_email: email,
      p_hash: codeHash(code),
      p_expires: expiresAt,
    });
    return { code, expiresAt };
  }
  async consume(email: string, code: string) {
    return this.invoke("afi_recovery_consume", {
      p_email: email,
      p_hash: codeHash(code),
    }) as Promise<string | null>;
  }
  async question(email: string) {
    return this.invoke("afi_recovery_question", { p_email: email }) as Promise<
      string | null
    >;
  }
  async setQuestion(
    userId: string,
    email: string,
    question: string,
    answer: string,
  ) {
    const salt = randomBytes(16).toString("hex"),
      hash = (await answerHash(answer, salt)).toString("hex");
    await this.saveHash(userId, email, question, salt, hash, false);
  }
  async saveHash(
    userId: string,
    email: string,
    question: string,
    salt: string,
    hash: string,
    importOnly = true,
  ) {
    await this.invoke("afi_recovery_save_question", {
      p_user: userId,
      p_email: email,
      p_question: question,
      p_salt: salt,
      p_hash: hash,
      p_import: importOnly,
    });
  }
  async verifyAnswer(email: string, answer: string) {
    const claim = randomBytes(16).toString("hex");
    const row = await this.invoke("afi_recovery_claim", {
      p_email: email,
      p_claim: claim,
    });
    if (!row) return null;
    try {
      const hash = await answerHash(answer, row.salt),
        stored = Buffer.from(row.hash, "hex");
      if (hash.length === stored.length && timingSafeEqual(hash, stored))
        return { userId: row.userId as string, claim };
      await this.finishAnswer(email, claim, false);
      return null;
    } catch (error) {
      await this.finishAnswer(email, claim, false);
      throw error;
    }
  }
  async finishAnswer(email: string, claim: string, success: boolean) {
    await this.invoke("afi_recovery_finish", {
      p_email: email,
      p_claim: claim,
      p_success: success,
    });
  }
  close() {}
}

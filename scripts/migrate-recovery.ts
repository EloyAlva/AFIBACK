import "dotenv/config";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SupabaseRecoveryStore } from "../src/supabase-recovery.js";

const source = resolve(
  process.env.RECOVERY_DATABASE_PATH ?? ".data/password-recovery.sqlite",
);
if (!existsSync(source)) {
  console.log("No hay un almacén local de recuperación para importar.");
  process.exit(0);
}
const db = new DatabaseSync(source, { readOnly: true });
try {
  const hasQuestions = db
    .prepare(
      "select 1 from sqlite_master where type='table' and name='security_questions'",
    )
    .get();
  if (!hasQuestions) {
    console.log("El almacén local no contiene preguntas de seguridad.");
    process.exitCode = 0;
  } else {
    const store = new SupabaseRecoveryStore();
    const rows = db
      .prepare(
        "select user_id,email,question,answer_salt,answer_hash from security_questions",
      )
      .all();
    for (const row of rows)
      await store.saveHash(
        String(row.user_id),
        String(row.email),
        String(row.question),
        String(row.answer_salt),
        String(row.answer_hash),
        true,
      );
    console.log(
      `Preguntas locales procesadas: ${rows.length}. Las existentes en Supabase se conservaron.`,
    );
  }
} finally {
  db.close();
}

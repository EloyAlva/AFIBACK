import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import {
  createRecoveryStore,
  recoveryEmail,
} from "../src/password-recovery.js";
import { config } from "../src/config.js";

const remote = process.argv.includes("--remote");
const usernames = process.argv.slice(2).filter((value) => value !== "--remote");
if (!usernames.length)
  throw Error("Uso: npm run recovery:issue -- ealva mramirez");
if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !config.SUPABASE_URL)
  throw Error("Configura Supabase en el archivo .env privado del backend.");
const emails = usernames.map(recoveryEmail);
const admin = createClient(
  config.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
).auth.admin;
const found = new Map<string, string>();
for (let page = 1; page <= 100; page++) {
  const { data, error } = await admin.listUsers({ page, perPage: 100 });
  if (error) throw Error("No se pudo verificar los usuarios en Supabase.");
  for (const user of data.users)
    if (user.email && emails.includes(user.email.toLowerCase()))
      found.set(user.email.toLowerCase(), user.id);
  if (found.size === emails.length || data.users.length < 100) break;
}
if (emails.some((email) => !found.has(email)))
  throw Error(
    "Algún usuario solicitado no existe en Supabase. No se emitieron códigos.",
  );
const store = createRecoveryStore(remote || undefined);
try {
  for (const email of emails) {
    const result = await store.issue(found.get(email)!, email);
    process.stdout.write(
      JSON.stringify({ username: email.split("@")[0], ...result }) + "\n",
    );
  }
} finally {
  await store.close();
}

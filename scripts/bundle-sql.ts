import { readFile, readdir, writeFile } from "node:fs/promises";

const directory = new URL("../supabase/migrations/", import.meta.url);
const files = (await readdir(directory))
  .filter((f) => f.endsWith(".sql"))
  .sort();
const migrations = await Promise.all(
  files.map(async (file) => ({
    file,
    sql: (await readFile(new URL(file, directory), "utf8"))
      .replace(/^\s*begin;\s*/i, "")
      .replace(/\s*commit;\s*$/i, ""),
  })),
);
const tables = migrations.flatMap(({ sql }) =>
  [...sql.matchAll(/create table public\.(\w+)/gi)].map((m) => m[1]),
);
const install = `-- Instalación inicial: conserva una instalación AFI existente.
do $afi_install$
declare required_table text;
begin
 if to_regclass('auth.users') is null or to_regclass('auth.identities') is null then
  raise exception 'Ejecuta este archivo en Supabase SQL Editor, como postgres.';
 end if;
 if to_regclass('public.profiles') is null then
${migrations.map(({ file, sql }, i) => `  -- ${file}\n  execute $afi_migration_${i}$\n${sql}\n$afi_migration_${i}$;`).join("\n")}
 else
  foreach required_table in array array[${tables.map((t) => `'${t}'`).join(",")}] loop
   if to_regclass('public.'||required_table) is null then
    raise exception 'La instalación AFI está incompleta: falta public.%. Aplica las migraciones pendientes antes de repetir.',required_table;
   end if;
   if not (select relrowsecurity from pg_class where oid=to_regclass('public.'||required_table)) then
    raise exception 'RLS está desactivado en public.%. Revisa su configuración antes de continuar.',required_table;
   end if;
  end loop;
  -- Actualizacion repetible de invitaciones para instalaciones existentes.
  execute $afi_upgrade_invitations$
${migrations.find(m => m.file === "008_registered_invitations.sql")!.sql}
$afi_upgrade_invitations$;
 end if;
end $afi_install$;`;
const seed = await readFile(
  new URL("../supabase/seeds/initial_users.sql", import.meta.url),
  "utf8",
);
const result = `-- AFI: INSTALACIÓN COMPLETA Y DOS USUARIOS INICIALES
-- Generado desde las migraciones y seeds/initial_users.sql. No editar la estructura generada.
-- 1. Ejecuta TODO en Supabase SQL Editor como postgres, sin reemplazar contraseñas.
-- 2. Copia contrasena_inicial del resultado: solo se muestra al crear cada usuario.
-- 3. Usuarios nuevos quedan confirmados para login con contraseña.
-- 4. Usuarios existentes conservan sus contraseñas y estado de confirmación.
-- Las tablas de Auth las administra Supabase. Este archivo presupone su esquema actual.
-- Referencia: https://supabase.com/docs/guides/auth/identities
${seed.replace("-- Ejecutar como postgres en Supabase SQL Editor después de las migraciones.\n", "").replace("do $afi_users$", () => install + "\n\ndo $afi_users$")}`;
await writeFile(
  new URL("../supabase/afi_instalacion_completa.sql", import.meta.url),
  result,
);

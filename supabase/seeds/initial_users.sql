-- Ejecutar como postgres en Supabase SQL Editor después de las migraciones.
-- Ejecutable sin editar: NULL genera una contraseña aleatoria para cada usuario nuevo.
-- Copia las contraseñas de la columna contrasena_inicial del resultado final.
-- No se cambian contraseñas de usuarios que ya existan.
begin;
create temporary table if not exists afi_initial_users (
 email text primary key,
 username text not null,
 display_name text not null,
 initial_password text,
 created_now boolean not null default false
) on commit preserve rows;
truncate table pg_temp.afi_initial_users;
insert into afi_initial_users(email,username,display_name,initial_password) values
 ('mramirez@afi.com','mramirez','Marines Ramirez Rodriguez',null),
 ('ealva@afi.com','ealva','Eloy Gonzalo Alva Calderon',null);

do $afi_users$
declare
 person record;
 uid uuid;
 matches integer;
begin
 perform pg_advisory_xact_lock(hashtextextended('afi_initial_users',0));
 if to_regclass('auth.identities') is null then
  raise exception 'Se requiere un proyecto Supabase con Auth habilitado.';
 end if;
 if to_regclass('public.savings_operations') is null or to_regprocedure('public.list_shared_members()') is null then
  raise exception 'Aplica primero todas las migraciones de AFI (001 a 007).';
 end if;

 for person in select * from pg_temp.afi_initial_users order by email loop
  select count(*),min(id::text)::uuid into matches,uid from auth.users where lower(email)=person.email;
  if matches>1 then raise exception 'Hay varios usuarios Auth con el correo %. Resuelve el duplicado antes de continuar.',person.email; end if;

  if uid is null then
   if nullif(btrim(person.initial_password),'') is null or person.initial_password like 'REEMPLAZAR_PASSWORD_%' then
    person.initial_password:=encode(extensions.gen_random_bytes(18),'hex');
   end if;
   if length(person.initial_password)<12 or octet_length(person.initial_password)>72 then
    raise exception 'La contraseña personalizada de % debe tener al menos 12 caracteres y como máximo 72 bytes. Usa NULL para generarla automáticamente.',person.email;
   end if;
   update pg_temp.afi_initial_users set initial_password=person.initial_password,created_now=true where email=person.email;
   uid:=gen_random_uuid();
   insert into auth.users(
    instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,
    confirmation_token,recovery_token,email_change_token_new,email_change,
    email_change_token_current,email_change_confirm_status,reauthentication_token,
    raw_app_meta_data,raw_user_meta_data,is_super_admin,is_sso_user,is_anonymous,created_at,updated_at
   ) values(
    '00000000-0000-0000-0000-000000000000',uid,'authenticated','authenticated',person.email,
    extensions.crypt(person.initial_password,extensions.gen_salt('bf',10)),now(),
    '','','','','',0,'',
    jsonb_build_object('provider','email','providers',jsonb_build_array('email')),
    jsonb_build_object('display_name',person.display_name,'full_name',person.display_name,'username',person.username,'email_verified',true),
    false,false,false,now(),now()
   );
  else
   -- Preserva contraseña, sesiones, proveedores, moneda y zona horaria existentes.
   update auth.users set
    raw_user_meta_data=coalesce(raw_user_meta_data,'{}'::jsonb)||jsonb_build_object('display_name',person.display_name,'full_name',person.display_name,'username',person.username),
    updated_at=now()
   where id=uid;
  end if;

  -- Supabase necesita una identidad email además de la fila auth.users.
  if exists(select 1 from auth.identities where provider='email' and provider_id=uid::text and user_id<>uid) then
   raise exception 'La identidad email de % pertenece a otro usuario.',person.email;
  end if;
  if not exists(select 1 from auth.identities where user_id=uid and provider='email') then
   insert into auth.identities(id,provider_id,user_id,identity_data,provider,created_at,updated_at)
   values(gen_random_uuid(),uid::text,uid,jsonb_build_object('sub',uid::text,'email',person.email,'email_verified',true), 'email',now(),now());
  end if;

  -- El trigger bootstrap_user ya crea estas filas para usuarios nuevos.
  -- Los upserts también completan usuarios anteriores sin duplicar configuración.
  insert into public.profiles(id,display_name,currency,timezone)
   values(uid,person.display_name,'PEN','America/Lima')
   on conflict(id) do update set display_name=excluded.display_name;
  insert into public.user_preferences(user_id) values(uid) on conflict(user_id) do nothing;
  insert into public.notification_preferences(user_id) values(uid) on conflict(user_id) do nothing;
  insert into public.ai_usage_limits(user_id,monthly_limit) values(uid,100) on conflict(user_id) do nothing;
  insert into public.categories(user_id,name,type) values
   (uid,'Alimentación','expense'),(uid,'Transporte','expense'),(uid,'Servicios','expense'),
   (uid,'Salud','expense'),(uid,'Otros gastos','expense'),(uid,'Sueldo','income'),(uid,'Otros ingresos','income')
   on conflict(user_id,name,type) do nothing;
  insert into public.financial_accounts(user_id,name,type,currency,opening_balance)
   select uid,'Efectivo','cash','PEN',0
   where not exists(select 1 from public.financial_accounts where user_id=uid and name='Efectivo' and type='cash' and currency='PEN');
  insert into public.audit_logs(id,user_id,entity,entity_id,action,details)
   values(md5('afi.initial-user.'||uid::text)::uuid,uid,'profile',uid,'initial_setup',jsonb_build_object('source','initial_users.sql'))
   on conflict(id) do nothing;
 end loop;
end $afi_users$;

commit;

-- Última sentencia: devuelve credenciales nuevas y vacía la tabla temporal.
-- En auth.users solo queda el hash; repetir el archivo no recupera ni cambia contraseñas.
with credentials as (
 delete from pg_temp.afi_initial_users returning *
)
select split_part(u.email,'@',1) as usuario_login,u.email,p.display_name as nombre,
 case when credentials.created_now then credentials.initial_password else null end as contrasena_inicial,
 case when credentials.created_now then 'creado' else 'existente: conserva su contraseña actual' end as estado,
 u.email_confirmed_at is not null as correo_confirmado,
 exists(select 1 from auth.identities i where i.user_id=u.id and i.provider='email') as identidad_email,
 (select count(*) from public.financial_accounts a where a.user_id=u.id) as cuentas,
 (select count(*) from public.categories c where c.user_id=u.id) as categorias
from auth.users u join public.profiles p on p.id=u.id join credentials on credentials.email=u.email
where u.email in ('mramirez@afi.com','ealva@afi.com') order by u.email;

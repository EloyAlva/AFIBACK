begin;
create schema if not exists afi_private;
revoke all on schema afi_private from public,anon,authenticated;

create table if not exists afi_private.recovery_codes (
 token_hash text primary key check(token_hash ~ '^[a-f0-9]{64}$'),
 user_id uuid not null references auth.users(id) on delete cascade,
 email text not null, expires_at timestamptz not null, used_at timestamptz
);
create index if not exists afi_recovery_codes_email on afi_private.recovery_codes(email);
create table if not exists afi_private.security_questions (
 email text primary key,user_id uuid not null references auth.users(id) on delete cascade,
 question text not null,answer_salt text not null,answer_hash text not null,
 failures integer not null default 0,locked_until timestamptz,busy_until timestamptz,claim text
);
alter table afi_private.recovery_codes enable row level security;
alter table afi_private.security_questions enable row level security;
revoke all on all tables in schema afi_private from public,anon,authenticated,service_role;

create or replace function public.afi_recovery_issue(p_user uuid,p_email text,p_hash text,p_expires timestamptz) returns void
language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from auth.users where id=p_user and lower(email)=lower(p_email)) then raise exception 'Recovery identity mismatch'; end if;
 if p_hash !~ '^[a-f0-9]{64}$' or p_expires<=now() or p_expires>now()+interval '31 minutes' then raise exception 'Invalid recovery code'; end if;
 perform pg_advisory_xact_lock(hashtextextended('afi_recovery:'||lower(p_email),0));
 update afi_private.recovery_codes set used_at=now() where email=lower(p_email) and used_at is null;
 insert into afi_private.recovery_codes(token_hash,user_id,email,expires_at) values(p_hash,p_user,lower(p_email),p_expires);
end $$;

create or replace function public.afi_recovery_consume(p_email text,p_hash text) returns uuid
language plpgsql security definer set search_path='' as $$
declare result uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended('afi_recovery:'||lower(p_email),0));
 update afi_private.recovery_codes set used_at=now() where token_hash=p_hash and email=lower(p_email) and used_at is null and expires_at>now() returning user_id into result;
 return result;
end $$;

create or replace function public.afi_recovery_question(p_email text) returns text
language sql stable security definer set search_path='' as $$
 select question from afi_private.security_questions where email=lower(p_email)
$$;

create or replace function public.afi_recovery_save_question(p_user uuid,p_email text,p_question text,p_salt text,p_hash text,p_import boolean default false) returns void
language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from auth.users where id=p_user and lower(email)=lower(p_email)) then raise exception 'Recovery identity mismatch'; end if;
 if length(p_question) not between 10 and 180 or p_salt !~ '^[a-f0-9]{32}$' or p_hash !~ '^[a-f0-9]{64}$' then raise exception 'Invalid security question'; end if;
 perform pg_advisory_xact_lock(hashtextextended('afi_recovery:'||lower(p_email),0));
 if p_import then
   insert into afi_private.security_questions(email,user_id,question,answer_salt,answer_hash) values(lower(p_email),p_user,p_question,p_salt,p_hash) on conflict do nothing;
   return;
 end if;
 if exists(select 1 from afi_private.security_questions where email=lower(p_email) and busy_until>now()) then raise exception 'Recovery in progress'; end if;
 insert into afi_private.security_questions(email,user_id,question,answer_salt,answer_hash) values(lower(p_email),p_user,p_question,p_salt,p_hash)
 on conflict(email) do update set user_id=excluded.user_id,question=excluded.question,answer_salt=excluded.answer_salt,answer_hash=excluded.answer_hash,failures=0,locked_until=null,busy_until=null,claim=null;
end $$;

create or replace function public.afi_recovery_claim(p_email text,p_claim text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare row afi_private.security_questions; attempts integer;
begin
 if p_claim !~ '^[a-f0-9]{32}$' then raise exception 'Invalid recovery claim'; end if;
 select * into row from afi_private.security_questions where email=lower(p_email) for update;
 if not found or row.locked_until>now() or row.busy_until>now() then return null; end if;
 attempts:=case when row.locked_until is not null then 1 else row.failures+1 end;
 update afi_private.security_questions set failures=attempts,locked_until=case when attempts>=5 then now()+interval '30 minutes' else null end,busy_until=now()+interval '60 seconds',claim=p_claim where email=lower(p_email);
 return jsonb_build_object('userId',row.user_id,'salt',row.answer_salt,'hash',row.answer_hash,'claim',p_claim);
end $$;

create or replace function public.afi_recovery_finish(p_email text,p_claim text,p_success boolean) returns void
language plpgsql security definer set search_path='' as $$
begin
 update afi_private.security_questions set failures=case when p_success then 0 else failures end,locked_until=case when p_success then null else locked_until end,busy_until=null,claim=null
 where email=lower(p_email) and claim=p_claim;
end $$;

revoke execute on function public.afi_recovery_issue(uuid,text,text,timestamptz),public.afi_recovery_consume(text,text),public.afi_recovery_question(text),public.afi_recovery_save_question(uuid,text,text,text,text,boolean),public.afi_recovery_claim(text,text),public.afi_recovery_finish(text,text,boolean) from public,anon,authenticated;
grant execute on function public.afi_recovery_issue(uuid,text,text,timestamptz),public.afi_recovery_consume(text,text),public.afi_recovery_question(text),public.afi_recovery_save_question(uuid,text,text,text,text,boolean),public.afi_recovery_claim(text,text),public.afi_recovery_finish(text,text,boolean) to service_role;
notify pgrst,'reload schema';
commit;

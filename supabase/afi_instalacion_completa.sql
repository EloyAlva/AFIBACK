-- AFI: INSTALACIÓN COMPLETA Y DOS USUARIOS INICIALES
-- Generado desde las migraciones y seeds/initial_users.sql. No editar la estructura generada.
-- 1. Ejecuta TODO en Supabase SQL Editor como postgres, sin reemplazar contraseñas.
-- 2. Copia contrasena_inicial del resultado: solo se muestra al crear cada usuario.
-- 3. Usuarios nuevos quedan confirmados para login con contraseña.
-- 4. Usuarios existentes conservan sus contraseñas y estado de confirmación.
-- Las tablas de Auth las administra Supabase. Este archivo presupone su esquema actual.
-- Referencia: https://supabase.com/docs/guides/auth/identities
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

-- Instalación inicial: conserva una instalación AFI existente.
do $afi_install$
declare required_table text;
begin
 if to_regclass('auth.users') is null or to_regclass('auth.identities') is null then
  raise exception 'Ejecuta este archivo en Supabase SQL Editor, como postgres.';
 end if;
 if to_regclass('public.profiles') is null then
  -- 001_schema.sql
  execute $afi_migration_0$
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table public.profiles (
 id uuid primary key references auth.users(id) on delete cascade,
 display_name text not null default '', currency text not null default 'PEN' check(currency ~ '^[A-Z]{3}$'),
 timezone text not null default 'America/Lima', created_at timestamptz not null default now()
);
create table public.user_preferences (
 user_id uuid primary key references public.profiles(id), ant_expense_threshold numeric(18,2) not null default 20 check(ant_expense_threshold>=0),
 budget_thresholds integer[] not null default array[80,90,100] check(cardinality(budget_thresholds) between 1 and 10 and 1<=all(budget_thresholds) and 100>=all(budget_thresholds))
);
create table public.financial_accounts (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id), name text not null check(length(name) between 1 and 120),
 type text not null check(type in ('cash','bank','wallet','savings','other')), currency text not null default 'PEN' check(currency ~ '^[A-Z]{3}$'),
 opening_balance numeric(18,2) not null default 0, active boolean not null default true, created_at timestamptz not null default now(), unique(id,user_id)
);
create table public.categories (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id), name text not null,
 type text not null check(type in ('income','expense')), unique(user_id,name,type), unique(id,user_id)
);
create table public.credit_cards (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id), bank text not null, name text not null,
 currency text not null default 'PEN' check(currency ~ '^[A-Z]{3}$'), credit_limit numeric(18,2) not null check(credit_limit>0), initial_debt numeric(18,2) not null default 0 check(initial_debt>=0),
 closing_day integer not null check(closing_day between 1 and 31), due_day integer not null check(due_day between 1 and 31),
 utilization_limit numeric(5,2) not null default 50 check(utilization_limit between 0 and 100), active boolean not null default true, unique(id,user_id)
);
create table public.debts (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id), creditor text not null, name text not null,
 currency text not null default 'PEN' check(currency ~ '^[A-Z]{3}$'), principal numeric(18,2) not null check(principal>0), annual_interest numeric(8,4) not null default 0 check(annual_interest>=0),
 installments integer not null check(installments between 1 and 600), first_due_date date not null, active boolean not null default true, unique(id,user_id)
);
create table public.payment_obligations (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id), name text not null, type text not null default 'service', entity text not null default '',
 amount numeric(18,2) not null check(amount>0), currency text not null default 'PEN' check(currency ~ '^[A-Z]{3}$'),
 frequency text not null check(frequency in ('once','monthly','yearly')), start_date date not null, end_date date,
 account_id uuid, card_id uuid, debt_id uuid, notes text not null default '', active boolean not null default true,
 foreign key(account_id,user_id) references public.financial_accounts(id,user_id), foreign key(card_id,user_id) references public.credit_cards(id,user_id),
 foreign key(debt_id,user_id) references public.debts(id,user_id), check(num_nonnulls(card_id,debt_id)<=1), check(end_date is null or end_date>=start_date), unique(id,user_id)
);
create table public.payment_occurrences (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id), obligation_id uuid not null,
 period date not null, due_date date not null, amount numeric(18,2) not null check(amount>0), currency text not null,
 foreign key(obligation_id,user_id) references public.payment_obligations(id,user_id), unique(obligation_id,period), unique(id,user_id)
);
create table public.financial_transactions (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id),
 type text not null check(type in ('income','expense','transfer','card_payment','loan_payment','obligation_payment','savings_reserve','savings_withdrawal','adjustment')),
 amount numeric(18,2) not null check(amount>0), currency text not null check(currency ~ '^[A-Z]{3}$'), occurred_at timestamptz not null,
 category_id uuid, source_account_id uuid, destination_account_id uuid, card_id uuid, debt_id uuid, occurrence_id uuid,
 description text not null check(length(description) between 1 and 500), notes text not null default '', payment_method text not null default '',
 voided_at timestamptz, idempotency_key uuid not null, request_body jsonb not null,
 created_at timestamptz not null default now(), unique(user_id,idempotency_key), unique(id,user_id),
 foreign key(category_id,user_id) references public.categories(id,user_id), foreign key(source_account_id,user_id) references public.financial_accounts(id,user_id),
 foreign key(destination_account_id,user_id) references public.financial_accounts(id,user_id), foreign key(card_id,user_id) references public.credit_cards(id,user_id),
 foreign key(debt_id,user_id) references public.debts(id,user_id), foreign key(occurrence_id,user_id) references public.payment_occurrences(id,user_id),
 check(source_account_id is null or destination_account_id is null or source_account_id<>destination_account_id)
);
create table public.transaction_entries (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id), transaction_id uuid not null, account_id uuid not null,
 amount numeric(18,2) not null check(amount<>0), foreign key(transaction_id,user_id) references public.financial_transactions(id,user_id),
 foreign key(account_id,user_id) references public.financial_accounts(id,user_id), unique(transaction_id,account_id)
);
create table public.obligation_payments (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id), transaction_id uuid not null,
 occurrence_id uuid not null, amount numeric(18,2) not null check(amount>0),
 principal_amount numeric(18,2) not null default 0 check(principal_amount>=0), interest_amount numeric(18,2) not null default 0 check(interest_amount>=0 and interest_amount+principal_amount<=amount),
 foreign key(transaction_id,user_id) references public.financial_transactions(id,user_id), foreign key(occurrence_id,user_id) references public.payment_occurrences(id,user_id), unique(transaction_id,occurrence_id)
);
create table public.budgets (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id), category_id uuid,
 month date not null check(extract(day from month)=1), amount numeric(18,2) not null check(amount>0), currency text not null default 'PEN' check(currency ~ '^[A-Z]{3}$'),
 foreign key(category_id,user_id) references public.categories(id,user_id)
);
create unique index budgets_scope on public.budgets(user_id,month,currency,coalesce(category_id,'00000000-0000-0000-0000-000000000000'::uuid));
create table public.credit_card_purchases (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id), card_id uuid not null, category_id uuid,
 amount numeric(18,2) not null check(amount>0), description text not null, purchased_at date not null, installments integer not null default 1 check(installments between 1 and 120),
 kind text not null default 'purchase' check(kind in ('purchase','interest','fee','refund')), idempotency_key uuid not null,
 foreign key(card_id,user_id) references public.credit_cards(id,user_id), foreign key(category_id,user_id) references public.categories(id,user_id), unique(user_id,idempotency_key), unique(id,user_id)
);
create table public.credit_card_installments (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id), purchase_id uuid not null,
 number integer not null, due_date date not null, amount numeric(18,2) not null check(amount>0),
 foreign key(purchase_id,user_id) references public.credit_card_purchases(id,user_id), unique(purchase_id,number)
);
create table public.credit_card_statements (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id), card_id uuid not null,
 period date not null, closing_date date not null, due_date date not null, amount numeric(18,2) not null check(amount>=0), minimum_payment numeric(18,2) not null check(minimum_payment>=0 and minimum_payment<=amount),
 foreign key(card_id,user_id) references public.credit_cards(id,user_id), unique(card_id,period)
);
create table public.debt_installments (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id), debt_id uuid not null, number integer not null,
 due_date date not null, principal numeric(18,2) not null check(principal>0), interest numeric(18,2) not null check(interest>=0),
 foreign key(debt_id,user_id) references public.debts(id,user_id), unique(debt_id,number)
);
create table public.shared_spaces (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references public.profiles(id), name text not null, created_at timestamptz not null default now()
);
create table public.shared_space_members (
 space_id uuid not null references public.shared_spaces(id), user_id uuid not null references public.profiles(id),
 role text not null check(role in ('admin','member')), can_create_goals boolean not null default false, primary key(space_id,user_id)
);
create table public.shared_space_invitations (
 id uuid primary key default gen_random_uuid(), space_id uuid not null references public.shared_spaces(id), invited_by uuid not null references public.profiles(id),
 email text not null, token_hash text not null unique, expires_at timestamptz not null default now()+interval '7 days',
 status text not null default 'pending' check(status in ('pending','accepted','rejected','revoked')), created_at timestamptz not null default now()
);
create table public.savings_goals (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id), space_id uuid references public.shared_spaces(id),
 name text not null, description text not null default '', minimum_amount numeric(18,2) not null check(minimum_amount>=0), ideal_amount numeric(18,2) not null check(ideal_amount>0 and ideal_amount>=minimum_amount),
 currency text not null default 'PEN' check(currency ~ '^[A-Z]{3}$'), target_date date not null, priority integer not null default 2 check(priority between 1 and 3)
);
create table public.savings_goal_members (
 goal_id uuid not null references public.savings_goals(id), user_id uuid not null references public.profiles(id), percentage numeric(5,2) not null check(percentage between 0 and 100), primary key(goal_id,user_id)
);
create table public.savings_plans (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id), goal_id uuid not null references public.savings_goals(id),
 month date not null, amount numeric(18,2) not null check(amount>=0), unique(user_id,goal_id,month)
);
-- A reserve remains owned cash. Allocation moves only its attribution, never the account balance.
create table public.savings_fund_movements (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id), transaction_id uuid not null unique,
 amount numeric(18,2) not null check(amount<>0), currency text not null, foreign key(transaction_id,user_id) references public.financial_transactions(id,user_id)
);
create table public.savings_allocations (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id), goal_id uuid not null references public.savings_goals(id),
 amount numeric(18,2) not null check(amount<>0), currency text not null, idempotency_key uuid not null, created_at timestamptz not null default now(), unique(user_id,idempotency_key)
);
create table public.notifications (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id), occurrence_id uuid not null,
 reminder_day date not null, title text not null, read_at timestamptz, foreign key(occurrence_id,user_id) references public.payment_occurrences(id,user_id), unique(occurrence_id,reminder_day)
);
create table public.notification_preferences (user_id uuid primary key references public.profiles(id), enabled boolean not null default true);
create table public.ai_usage_limits (user_id uuid primary key references public.profiles(id), monthly_limit integer not null default 100 check(monthly_limit>=0));
create table public.ai_usage_logs (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id), idempotency_key uuid not null,
 input_tokens integer not null default 0, output_tokens integer not null default 0, estimated_cost numeric(12,8) not null check(estimated_cost>=0),
 status text not null default 'reserved', result jsonb, created_at timestamptz not null default now(), unique(user_id,idempotency_key)
);
create table public.ai_drafts (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id), payload jsonb not null,
 expires_at timestamptz not null default now()+interval '30 minutes', transaction_id uuid references public.financial_transactions(id)
);
create table public.audit_logs (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id), entity text not null, entity_id uuid not null,
 action text not null, created_at timestamptz not null default now(), details jsonb not null default '{}'
);

create function public.is_member(s uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.shared_space_members where space_id=s and user_id=auth.uid())
$$;
create function public.is_admin(s uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.shared_space_members where space_id=s and user_id=auth.uid() and role='admin')
$$;
create function public.can_access_goal(g uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.savings_goals where id=g and ((space_id is null and user_id=auth.uid()) or public.is_member(space_id)))
$$;
create function public.bootstrap_user() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into public.profiles(id,display_name) values(new.id,coalesce(new.raw_user_meta_data->>'display_name',''));
 insert into public.user_preferences(user_id) values(new.id);
 insert into public.notification_preferences(user_id) values(new.id);
 insert into public.categories(user_id,name,type) values(new.id,'Alimentación','expense'),(new.id,'Transporte','expense'),(new.id,'Servicios','expense'),(new.id,'Salud','expense'),(new.id,'Otros gastos','expense'),(new.id,'Sueldo','income'),(new.id,'Otros ingresos','income');
 return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.bootstrap_user();

do $$ declare t text; begin
 foreach t in array array['profiles','user_preferences','financial_accounts','categories','credit_cards','debts','payment_obligations','payment_occurrences','financial_transactions','transaction_entries','obligation_payments','budgets','credit_card_purchases','credit_card_installments','credit_card_statements','debt_installments','savings_plans','savings_fund_movements','savings_allocations','notifications','notification_preferences','ai_usage_limits','ai_usage_logs','ai_drafts','audit_logs'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('create policy owner_read on public.%I for select to authenticated using (%I=auth.uid())',t,case when t='profiles' then 'id' else 'user_id' end);
 end loop;
 foreach t in array array['shared_spaces','shared_space_members','shared_space_invitations','savings_goals','savings_goal_members'] loop
 execute format('alter table public.%I enable row level security',t);
 end loop;
end $$;
create policy space_read on public.shared_spaces for select to authenticated using(public.is_member(id));
create policy members_read on public.shared_space_members for select to authenticated using(public.is_member(space_id));
create policy invitations_read on public.shared_space_invitations for select to authenticated using(public.is_admin(space_id));
create policy goal_read on public.savings_goals for select to authenticated using((space_id is null and user_id=auth.uid()) or public.is_member(space_id));
create policy goal_members_read on public.savings_goal_members for select to authenticated using(public.can_access_goal(goal_id));
-- Expose shared contributions without ever exposing personal account identifiers.
create policy shared_allocation_read on public.savings_allocations for select to authenticated using(public.can_access_goal(goal_id));
create policy shared_plan_read on public.savings_plans for select to authenticated using(public.can_access_goal(goal_id));
revoke all on all tables in schema public from anon, authenticated;
grant select on all tables in schema public to authenticated;
-- All writes go through narrow checked RPCs in the following migration.
create index transactions_user_date on public.financial_transactions(user_id,occurred_at desc);
create index occurrences_user_due on public.payment_occurrences(user_id,due_date);
create index entries_account on public.transaction_entries(account_id);
create index allocations_goal on public.savings_allocations(goal_id);
create index ai_usage_month on public.ai_usage_logs(created_at,user_id);
$afi_migration_0$;
  -- 002_operations.sql
  execute $afi_migration_1$
create function public.require_user() returns uuid language plpgsql stable set search_path='' as $$
begin if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if; return auth.uid(); end $$;
create function public.month_date(base date, offset_months integer) returns date language sql immutable set search_path='' as $$
 select (date_trunc('month',base)+make_interval(months=>offset_months)+ make_interval(days=>least(extract(day from base)::int,extract(day from (date_trunc('month',base)+make_interval(months=>offset_months+1)-interval '1 day'))::int)-1))::date
$$;

create function public.record_transaction(p jsonb, k uuid) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid:=public.require_user(); tid uuid; old public.financial_transactions; a public.financial_accounts; src uuid:=(p->>'source_account_id')::uuid;
 dst uuid:=(p->>'destination_account_id')::uuid; typ text:=p->>'type'; amt numeric:=(p->>'amount')::numeric; cur text:=p->>'currency';
 cat uuid:=(p->>'category_id')::uuid; card uuid:=(p->>'card_id')::uuid; debt uuid:=(p->>'debt_id')::uuid; occ public.payment_occurrences; ob public.payment_obligations;
 reserved numeric; allocated numeric;
begin
 perform pg_advisory_xact_lock(hashtextextended(u::text,0));
 select * into old from public.financial_transactions where user_id=u and idempotency_key=k;
 if found then if old.request_body<>p then raise exception 'Idempotency key reused with different payload'; end if; return old.id; end if;
 if amt is null or amt<=0 or amt<>round(amt,2) then raise exception 'Invalid amount'; end if;
 if typ not in ('income','expense','transfer','card_payment','loan_payment','obligation_payment','savings_reserve','savings_withdrawal','adjustment') then raise exception 'Invalid type'; end if;
 if typ='income' and (dst is null or src is not null) then raise exception 'Income requires destination only'; end if;
 if typ in ('expense','card_payment','loan_payment','obligation_payment','savings_reserve','savings_withdrawal','adjustment') and (src is null or dst is not null) then raise exception 'Source account required'; end if;
 if typ='transfer' and (src is null or dst is null or src=dst) then raise exception 'Two distinct accounts required'; end if;
 if cat is not null and not exists(select 1 from public.categories where id=cat and user_id=u and type=typ) then raise exception 'Invalid category'; end if;
 if card is not null and typ<>'card_payment' or debt is not null and typ<>'loan_payment' then raise exception 'Unexpected credit reference'; end if;
 for a in select * from public.financial_accounts where id in (src,dst) order by id for update loop
  if a.user_id<>u or not a.active or a.currency<>cur then raise exception 'Account unavailable or currency mismatch'; end if;
 end loop;
 if src is not null and not exists(select 1 from public.financial_accounts where id=src and user_id=u) or dst is not null and not exists(select 1 from public.financial_accounts where id=dst and user_id=u) then raise exception 'Account unavailable'; end if;
 if typ='card_payment' and not exists(select 1 from public.credit_cards where id=card and user_id=u and currency=cur) then raise exception 'Card unavailable'; end if;
 if typ='loan_payment' and not exists(select 1 from public.debts where id=debt and user_id=u and currency=cur) then raise exception 'Debt unavailable'; end if;
 if p->>'occurrence_id' is not null then
  select * into occ from public.payment_occurrences where id=(p->>'occurrence_id')::uuid and user_id=u for update;
  if not found or occ.currency<>cur then raise exception 'Occurrence unavailable'; end if;
  select * into ob from public.payment_obligations where id=occ.obligation_id;
  if (ob.card_id is not null and (typ<>'card_payment' or card is distinct from ob.card_id)) or (ob.debt_id is not null and (typ<>'loan_payment' or debt is distinct from ob.debt_id)) or (ob.card_id is null and ob.debt_id is null and typ<>'obligation_payment') then raise exception 'Payment type mismatch'; end if;
  if amt>occ.amount-coalesce((select sum(op.amount) from public.obligation_payments op join public.financial_transactions ft on ft.id=op.transaction_id where op.occurrence_id=occ.id and ft.voided_at is null),0) then raise exception 'Payment exceeds pending amount'; end if;
 elsif typ='obligation_payment' then raise exception 'Occurrence required';
 end if;
 -- Reservations remain in the account; globally preserve sufficient liquidity.
 select coalesce(sum(f.amount),0) into reserved from public.savings_fund_movements f join public.financial_transactions t on t.id=f.transaction_id where f.user_id=u and f.currency=cur and t.voided_at is null;
 select coalesce(sum(amount),0) into allocated from public.savings_allocations where user_id=u and currency=cur;
 if typ='savings_withdrawal' and amt>reserved-allocated then raise exception 'Release allocations before withdrawing'; end if;
 if typ in ('expense','transfer','card_payment','loan_payment','obligation_payment','adjustment') and amt>(select opening_balance+coalesce((select sum(e.amount) from public.transaction_entries e join public.financial_transactions t on t.id=e.transaction_id where e.account_id=src and t.voided_at is null),0) from public.financial_accounts where id=src) then raise exception 'Insufficient account balance'; end if;
 if typ in ('expense','card_payment','loan_payment','obligation_payment','adjustment','savings_reserve') and amt>(select coalesce(sum(fa.opening_balance),0)+coalesce((select sum(e.amount) from public.transaction_entries e join public.financial_transactions t on t.id=e.transaction_id join public.financial_accounts ac on ac.id=e.account_id where e.user_id=u and ac.currency=cur and t.voided_at is null),0)-reserved from public.financial_accounts fa where fa.user_id=u and fa.currency=cur) then raise exception 'Insufficient unreserved funds'; end if;
 if typ='card_payment' and amt>(select c.initial_debt+coalesce((select sum(case when kind='refund' then -amount else amount end) from public.credit_card_purchases where card_id=c.id),0)-coalesce((select sum(amount) from public.financial_transactions where card_id=c.id and type='card_payment' and voided_at is null),0) from public.credit_cards c where c.id=card) then raise exception 'Payment exceeds card debt'; end if;
 if typ='loan_payment' and amt>(select principal+coalesce((select sum(interest) from public.debt_installments where debt_id=d.id),0)-coalesce((select sum(amount) from public.financial_transactions where debt_id=d.id and type='loan_payment' and voided_at is null),0) from public.debts d where d.id=debt) then raise exception 'Payment exceeds debt'; end if;
 insert into public.financial_transactions(user_id,type,amount,currency,occurred_at,category_id,source_account_id,destination_account_id,card_id,debt_id,occurrence_id,description,notes,payment_method,idempotency_key,request_body)
 values(u,typ,amt,cur,(p->>'occurred_at')::timestamptz,cat,src,dst,card,debt,(p->>'occurrence_id')::uuid,p->>'description',coalesce(p->>'notes',''),coalesce(p->>'payment_method',''),k,p) returning id into tid;
 if typ not in ('savings_reserve','savings_withdrawal') then
  if src is not null then insert into public.transaction_entries(user_id,transaction_id,account_id,amount) values(u,tid,src,-amt); end if;
  if dst is not null then insert into public.transaction_entries(user_id,transaction_id,account_id,amount) values(u,tid,dst,amt); end if;
 else insert into public.savings_fund_movements(user_id,transaction_id,amount,currency) values(u,tid,case when typ='savings_reserve' then amt else -amt end,cur); end if;
 insert into public.audit_logs(user_id,entity,entity_id,action) values(u,'transaction',tid,'create');
 return tid;
end $$;

create function public.void_transaction(tid uuid) returns void language plpgsql security definer set search_path='' as $$
declare u uuid:=public.require_user(); t public.financial_transactions;
begin
 perform pg_advisory_xact_lock(hashtextextended(u::text,0));
 select * into t from public.financial_transactions where id=tid and user_id=u for update;
 if not found then raise exception 'Transaction unavailable'; end if;
 if t.voided_at is not null then return; end if;
 update public.financial_transactions set voided_at=now() where id=tid;
 if exists(select 1 from public.financial_accounts a where a.user_id=u and a.opening_balance+coalesce((select sum(e.amount) from public.transaction_entries e join public.financial_transactions f on f.id=e.transaction_id where e.account_id=a.id and f.voided_at is null),0)<0) then raise exception 'Void would make balance negative'; end if;
 if exists(select 1 from public.savings_allocations al where al.user_id=u and al.currency=t.currency group by al.currency having sum(al.amount)>coalesce((select sum(f.amount) from public.savings_fund_movements f join public.financial_transactions x on x.id=f.transaction_id where f.user_id=u and f.currency=t.currency and x.voided_at is null),0)) then raise exception 'Release allocations first'; end if;
 insert into public.audit_logs(user_id,entity,entity_id,action) values(u,'transaction',tid,'void');
end $$;

-- Whitelisted configuration creation, never accepting caller-provided ownership.
create function public.create_resource(resource text, p jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid:=public.require_user(); rid uuid; d public.debts; n int; principal_part numeric; interest_part numeric; bal numeric;
begin
 case resource
 when 'accounts' then insert into public.financial_accounts(user_id,name,type,currency,opening_balance) values(u,p->>'name',p->>'type',p->>'currency',(p->>'opening_balance')::numeric) returning id into rid;
 when 'categories' then insert into public.categories(user_id,name,type) values(u,p->>'name',p->>'type') returning id into rid;
 when 'cards' then insert into public.credit_cards(user_id,bank,name,currency,credit_limit,initial_debt,closing_day,due_day,utilization_limit) values(u,p->>'bank',p->>'name',p->>'currency',(p->>'credit_limit')::numeric,(p->>'initial_debt')::numeric,(p->>'closing_day')::int,(p->>'due_day')::int,(p->>'utilization_limit')::numeric) returning id into rid;
 when 'debts' then
  insert into public.debts(user_id,creditor,name,currency,principal,annual_interest,installments,first_due_date) values(u,p->>'creditor',p->>'name',p->>'currency',(p->>'principal')::numeric,(p->>'annual_interest')::numeric,(p->>'installments')::int,(p->>'first_due_date')::date) returning * into d; rid:=d.id; bal:=d.principal;
  for n in 1..d.installments loop
   principal_part:=case when n=d.installments then bal else trunc(d.principal/d.installments,2) end;
   interest_part:=round(bal*d.annual_interest/1200,2); bal:=bal-principal_part;
   insert into public.debt_installments(user_id,debt_id,number,due_date,principal,interest) values(u,rid,n,public.month_date(d.first_due_date,n-1),principal_part,interest_part);
  end loop;
  perform public.sync_debt_schedule(rid);
 when 'obligations' then insert into public.payment_obligations(user_id,name,type,entity,amount,currency,frequency,start_date,end_date,account_id,card_id,debt_id,notes) values(u,p->>'name',p->>'type',coalesce(p->>'entity',''),(p->>'amount')::numeric,p->>'currency',p->>'frequency',(p->>'start_date')::date,(p->>'end_date')::date,(p->>'account_id')::uuid,(p->>'card_id')::uuid,(p->>'debt_id')::uuid,coalesce(p->>'notes','')) returning id into rid;
 when 'budgets' then insert into public.budgets(user_id,category_id,month,amount,currency) values(u,(p->>'category_id')::uuid,(p->>'month')::date,(p->>'amount')::numeric,p->>'currency') returning id into rid;
 when 'spaces' then
  insert into public.shared_spaces(owner_id,name) values(u,p->>'name') returning id into rid;
  insert into public.shared_space_members(space_id,user_id,role,can_create_goals) values(rid,u,'admin',true);
 when 'goals' then
  if p->>'space_id' is not null and not exists(select 1 from public.shared_space_members where space_id=(p->>'space_id')::uuid and user_id=u and (role='admin' or can_create_goals)) then raise exception 'Forbidden'; end if;
  insert into public.savings_goals(user_id,space_id,name,description,minimum_amount,ideal_amount,currency,target_date,priority) values(u,(p->>'space_id')::uuid,p->>'name',coalesce(p->>'description',''),(p->>'minimum_amount')::numeric,(p->>'ideal_amount')::numeric,p->>'currency',(p->>'target_date')::date,(p->>'priority')::int) returning id into rid;
 else raise exception 'Unknown resource';
 end case;
 insert into public.audit_logs(user_id,entity,entity_id,action) values(u,resource,rid,'create'); return rid;
end $$;

create function public.generate_occurrences(from_date date, to_date date) returns integer language plpgsql security definer set search_path='' as $$
declare u uuid:=public.require_user(); o public.payment_obligations; dt date; n int; c int:=0; rows_count int;
begin
 if to_date<from_date or to_date>from_date+interval '2 years' then raise exception 'Invalid range'; end if;
 for o in select * from public.payment_obligations where user_id=u and active and type not in ('card_statement','debt_schedule') loop
  for n in 0..least(1200,greatest(0,((extract(year from to_date)::int-extract(year from o.start_date)::int)*12+extract(month from to_date)::int-extract(month from o.start_date)::int))) loop
   if o.frequency='once' and n>0 then exit; end if;
   if o.frequency='yearly' and n%12<>0 then continue; end if;
   dt:=public.month_date(o.start_date,n);
   if dt between from_date and to_date and (o.end_date is null or dt<=o.end_date) then
    insert into public.payment_occurrences(user_id,obligation_id,period,due_date,amount,currency) values(u,o.id,date_trunc('month',dt)::date,dt,o.amount,o.currency) on conflict(obligation_id,period) do nothing;
    get diagnostics rows_count=row_count; c:=c+rows_count;
   end if;
  end loop;
 end loop; return c;
end $$;

create function public.record_purchase(p jsonb, k uuid) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid:=public.require_user(); c public.credit_cards; rid uuid; existing public.credit_card_purchases; n int; qty int:=(p->>'installments')::int;
 amt numeric:=(p->>'amount')::numeric; part numeric; first_due date; purchase_date date:=(p->>'purchased_at')::date; debt numeric;
begin
 perform pg_advisory_xact_lock(hashtextextended(u::text,0));
 select * into existing from public.credit_card_purchases where user_id=u and idempotency_key=k;
 if found then
  if existing.card_id<>(p->>'card_id')::uuid or existing.amount<>amt or existing.description<>p->>'description' or existing.kind<>p->>'kind' or existing.purchased_at<>purchase_date or existing.installments<>qty or existing.category_id is distinct from (p->>'category_id')::uuid then raise exception 'Idempotency conflict'; end if;
  return existing.id;
 end if;
 select * into c from public.credit_cards where id=(p->>'card_id')::uuid and user_id=u and active for update;
 if not found then raise exception 'Card unavailable'; end if;
 if amt<=0 or amt<>round(amt,2) or qty<1 or qty>120 or trunc(amt/qty,2)<=0 then raise exception 'Invalid purchase'; end if;
 if p->>'category_id' is not null and not exists(select 1 from public.categories where id=(p->>'category_id')::uuid and user_id=u and type='expense') then raise exception 'Invalid category'; end if;
 select c.initial_debt+coalesce((select sum(case when kind='refund' then -amount else amount end) from public.credit_card_purchases where card_id=c.id),0)-coalesce((select sum(amount) from public.financial_transactions where card_id=c.id and voided_at is null),0) into debt;
 if (p->>'kind'='refund' and amt>debt) or (p->>'kind'<>'refund' and debt+amt>c.credit_limit) then raise exception 'Credit limit or refund exceeded'; end if;
 insert into public.credit_card_purchases(user_id,card_id,category_id,amount,description,purchased_at,installments,kind,idempotency_key) values(u,c.id,(p->>'category_id')::uuid,amt,p->>'description',purchase_date,qty,p->>'kind',k) returning id into rid;
 if p->>'kind'<>'refund' then
  first_due:=date_trunc('month',purchase_date)::date+least(c.due_day,extract(day from (date_trunc('month',purchase_date)+interval '1 month -1 day'))::int)-1;
  if extract(day from purchase_date)>c.closing_day or first_due<=purchase_date or c.due_day<=c.closing_day then first_due:=public.month_date(first_due,1); end if;
  for n in 1..qty loop
   part:=case when n=qty then amt-trunc(amt/qty,2)*(qty-1) else trunc(amt/qty,2) end;
   insert into public.credit_card_installments(user_id,purchase_id,number,due_date,amount) values(u,rid,n,(date_trunc('month',first_due)+make_interval(months=>n-1)+make_interval(days=>least(c.due_day,extract(day from (date_trunc('month',first_due)+make_interval(months=>n)-interval '1 day'))::int)-1))::date,part);
  end loop;
 end if;
 insert into public.audit_logs(user_id,entity,entity_id,action) values(u,'purchase',rid,'create'); return rid;
end $$;

create function public.allocate_savings(g uuid, amt numeric, k uuid) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid:=public.require_user(); goal public.savings_goals; reserved numeric; allocated numeric; rid uuid; old public.savings_allocations;
begin
 perform pg_advisory_xact_lock(hashtextextended(u::text,0));
 select * into old from public.savings_allocations where user_id=u and idempotency_key=k;
 if found then if old.goal_id<>g or old.amount<>amt then raise exception 'Idempotency conflict'; end if; return old.id; end if;
 select * into goal from public.savings_goals where id=g;
 if not found or not public.can_access_goal(g) then raise exception 'Goal unavailable'; end if;
 if amt=0 or amt<>round(amt,2) then raise exception 'Invalid allocation'; end if;
 select coalesce(sum(f.amount),0) into reserved from public.savings_fund_movements f join public.financial_transactions t on t.id=f.transaction_id where f.user_id=u and f.currency=goal.currency and t.voided_at is null;
 select coalesce(sum(amount),0) into allocated from public.savings_allocations where user_id=u and currency=goal.currency;
 if amt>0 and amt>reserved-allocated then raise exception 'Insufficient unallocated savings'; end if;
 if amt<0 and -amt>coalesce((select sum(amount) from public.savings_allocations where user_id=u and goal_id=g),0) then raise exception 'Withdrawal exceeds contribution'; end if;
 insert into public.savings_allocations(user_id,goal_id,amount,currency,idempotency_key) values(u,g,amt,goal.currency,k) returning id into rid;
 insert into public.audit_logs(user_id,entity,entity_id,action) values(u,'allocation',rid,'create'); return rid;
end $$;

create function public.plan_savings(g uuid, m date, amt numeric) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid:=public.require_user(); rid uuid;
begin
 if not public.can_access_goal(g) then raise exception 'Goal unavailable'; end if;
 insert into public.savings_plans(user_id,goal_id,month,amount) values(u,g,date_trunc('month',m)::date,amt) on conflict(user_id,goal_id,month) do update set amount=excluded.amount returning id into rid;
 return rid;
end $$;

create function public.invite_member(s uuid, email_address text) returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=public.require_user(); token text:=encode(extensions.gen_random_bytes(32),'hex'); rid uuid;
begin
 if not public.is_admin(s) then raise exception 'Forbidden'; end if;
 insert into public.shared_space_invitations(space_id,invited_by,email,token_hash) values(s,u,lower(email_address),encode(extensions.digest(token,'sha256'),'hex')) returning id into rid;
 return jsonb_build_object('id',rid,'token',token,'expires_in_days',7);
end $$;

create function public.respond_invitation(token text, accept boolean) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid:=public.require_user(); inv public.shared_space_invitations;
begin
 select * into inv from public.shared_space_invitations where token_hash=encode(extensions.digest(token,'sha256'),'hex') for update;
 if not found or inv.status<>'pending' or inv.expires_at<now() or lower(coalesce(auth.jwt()->>'email',''))<>inv.email then raise exception 'Invitation invalid or expired'; end if;
 if accept then insert into public.shared_space_members(space_id,user_id,role) values(inv.space_id,u,'member') on conflict do nothing; end if;
 update public.shared_space_invitations set status=case when accept then 'accepted' else 'rejected' end where id=inv.id;
 return inv.space_id;
end $$;

create function public.manage_space(s uuid, operation text, target uuid, flag boolean default false) returns void language plpgsql security definer set search_path='' as $$
declare u uuid:=public.require_user();
begin
 if not public.is_admin(s) then raise exception 'Forbidden'; end if;
 if operation='revoke' then update public.shared_space_invitations set status='revoked' where id=target and space_id=s and status='pending';
 elsif operation='remove' then
  if exists(select 1 from public.shared_spaces where id=s and owner_id=target) then raise exception 'Cannot remove owner'; end if;
  delete from public.shared_space_members where space_id=s and user_id=target;
 elsif operation='allow_goals' then update public.shared_space_members set can_create_goals=flag where space_id=s and user_id=target;
 else raise exception 'Invalid operation'; end if;
end $$;

create function public.set_goal_members(g uuid, members jsonb) returns void language plpgsql security definer set search_path='' as $$
declare u uuid:=public.require_user(); goal public.savings_goals; r jsonb; total numeric:=0;
begin
 select * into goal from public.savings_goals where id=g for update;
 if not found or goal.space_id is null or not public.is_admin(goal.space_id) then raise exception 'Forbidden'; end if;
 for r in select * from jsonb_array_elements(members) loop
  if not exists(select 1 from public.shared_space_members where space_id=goal.space_id and user_id=(r->>'user_id')::uuid) then raise exception 'Participant unavailable'; end if;
  total:=total+(r->>'percentage')::numeric;
 end loop;
 if total<>100 then raise exception 'Participation must total 100'; end if;
 delete from public.savings_goal_members where goal_id=g;
 insert into public.savings_goal_members(goal_id,user_id,percentage) select g,(v->>'user_id')::uuid,(v->>'percentage')::numeric from jsonb_array_elements(members) v;
end $$;

create function public.update_profile(p jsonb) returns void language plpgsql security definer set search_path='' as $$
declare u uuid:=public.require_user();
begin
 if not exists(select 1 from pg_timezone_names where name=p->>'timezone') then raise exception 'Invalid timezone'; end if;
 update public.profiles set display_name=p->>'display_name',currency=p->>'currency',timezone=p->>'timezone' where id=u;
 update public.user_preferences set ant_expense_threshold=(p->>'ant_expense_threshold')::numeric,
 budget_thresholds=case when p?'budget_thresholds' then array(select jsonb_array_elements_text(p->'budget_thresholds')::int) else budget_thresholds end where user_id=u;
end $$;

create function public.refresh_notifications() returns void language plpgsql security definer set search_path='' as $$
declare u uuid:=public.require_user(); today date;
begin
 select (now() at time zone timezone)::date into today from public.profiles where id=u;
 if exists(select 1 from public.notification_preferences where user_id=u and not enabled) then return; end if;
 insert into public.notifications(user_id,occurrence_id,reminder_day,title)
 select u,o.id,today,b.name||case when o.due_date<today then ': pago vencido' when o.due_date=today then ': vence hoy' else ': próximo vencimiento' end
 from public.payment_occurrences o join public.payment_obligations b on b.id=o.obligation_id
 where o.user_id=u and (o.due_date-today in (7,3,1,0) or o.due_date<today) and o.amount>coalesce((select sum(op.amount) from public.obligation_payments op join public.financial_transactions ft on ft.id=op.transaction_id where op.occurrence_id=o.id and ft.voided_at is null),0)
 on conflict do nothing;
end $$;
create function public.read_notification(n uuid) returns void language sql security definer set search_path='' as $$
 update public.notifications set read_at=now() where id=n and user_id=auth.uid()
$$;
-- No public execution by anonymous clients. Default future grants are also closed.
revoke execute on all functions in schema public from public,anon;
grant execute on all functions in schema public to authenticated;
alter default privileges in schema public revoke execute on functions from public;
$afi_migration_1$;
  -- 003_ai.sql
  execute $afi_migration_2$
-- Only backend service role may reserve or settle provider spend. Financial writes never use this role.
create function public.reserve_ai(u uuid, k uuid, cost numeric, budget numeric, quota integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare existing public.ai_usage_logs; lim integer; rid uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended('afi_global_ai_budget',0));
 select * into existing from public.ai_usage_logs where user_id=u and idempotency_key=k;
 if found then return jsonb_build_object('id',existing.id,'status',existing.status,'result',existing.result); end if;
 select monthly_limit into lim from public.ai_usage_limits where user_id=u;
 lim:=least(coalesce(lim,quota),quota);
 if (select count(*) from public.ai_usage_logs where user_id=u and created_at>=date_trunc('month',now() at time zone 'UTC') at time zone 'UTC')>=lim then raise exception 'AI quota exhausted'; end if;
 if cost<=0 or (select coalesce(sum(estimated_cost),0) from public.ai_usage_logs where created_at>=date_trunc('month',now() at time zone 'UTC') at time zone 'UTC')+cost>budget then raise exception 'AI budget exhausted'; end if;
 insert into public.ai_usage_logs(user_id,idempotency_key,estimated_cost) values(u,k,cost) returning id into rid;
 return jsonb_build_object('id',rid,'status','new');
end $$;
create function public.settle_ai(log_id uuid, result_payload jsonb, in_tokens integer, out_tokens integer, actual_cost numeric, failed boolean) returns void language plpgsql security definer set search_path='' as $$
begin
 -- Failed/unknown calls retain the reservation so a timeout cannot hide provider spend.
 update public.ai_usage_logs set status=case when failed then 'failed' else 'completed' end,result=result_payload,input_tokens=in_tokens,output_tokens=out_tokens,
 estimated_cost=case when failed then estimated_cost else greatest(estimated_cost,actual_cost) end where id=log_id and status='reserved';
end $$;
create function public.save_ai_draft(p jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid:=public.require_user(); rid uuid;
begin
 if p->>'type' not in ('income','expense') then raise exception 'AI only supports income and expense'; end if;
 insert into public.ai_drafts(user_id,payload) values(u,p) returning id into rid; return rid;
end $$;
create function public.confirm_ai_draft(d uuid, k uuid, confirmed boolean) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid:=public.require_user(); draft public.ai_drafts; tid uuid;
begin
 if not confirmed then raise exception 'Explicit confirmation required'; end if;
 select * into draft from public.ai_drafts where id=d and user_id=u for update;
 if not found then raise exception 'Draft unavailable'; end if;
 if draft.transaction_id is not null then return draft.transaction_id; end if;
 if draft.expires_at<now() then raise exception 'Draft expired'; end if;
 if draft.payload->>'type' not in ('income','expense') then raise exception 'Invalid AI scope'; end if;
 tid:=public.record_transaction(draft.payload,k);
 update public.ai_drafts set transaction_id=tid where id=d;
 return tid;
end $$;
revoke execute on function public.reserve_ai(uuid,uuid,numeric,numeric,integer) from public,anon,authenticated;
revoke execute on function public.settle_ai(uuid,jsonb,integer,integer,numeric,boolean) from public,anon,authenticated;
grant execute on function public.reserve_ai(uuid,uuid,numeric,numeric,integer),public.settle_ai(uuid,jsonb,integer,integer,numeric,boolean) to service_role;
grant execute on function public.save_ai_draft(jsonb),public.confirm_ai_draft(uuid,uuid,boolean) to authenticated;
$afi_migration_2$;
  -- 004_editing_and_statements.sql
  execute $afi_migration_3$
create function public.assert_savings_integrity() returns void language plpgsql security definer set search_path='' as $$
declare u uuid:=public.require_user(); cur text; reserved numeric; cash numeric;
begin
 for cur in select distinct currency from public.financial_accounts where user_id=u loop
  select coalesce(sum(f.amount),0) into reserved from public.savings_fund_movements f join public.financial_transactions t on t.id=f.transaction_id where f.user_id=u and f.currency=cur and t.voided_at is null;
  select coalesce(sum(opening_balance),0)+coalesce((select sum(e.amount) from public.transaction_entries e join public.financial_transactions t on t.id=e.transaction_id join public.financial_accounts a on a.id=e.account_id where e.user_id=u and a.currency=cur and t.voided_at is null),0) into cash from public.financial_accounts where user_id=u and currency=cur;
  if reserved<0 or reserved>cash then raise exception 'Operation would violate savings reserve'; end if;
 end loop;
end $$;
alter function public.void_transaction(uuid) rename to internal_void_transaction;
revoke execute on function public.internal_void_transaction(uuid) from public,anon,authenticated;
create function public.void_transaction(tid uuid) returns void language plpgsql security definer set search_path='' as $$
begin
 perform public.internal_void_transaction(tid);
 perform public.assert_savings_integrity();
end $$;
grant execute on function public.void_transaction(uuid) to authenticated;
-- Reversal + replacement is a single DB transaction; no history is overwritten.
create function public.replace_transaction(tid uuid, p jsonb, k uuid) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid:=public.require_user(); replacement uuid; old public.financial_transactions;
begin
 perform pg_advisory_xact_lock(hashtextextended(u::text,0));
 select * into old from public.financial_transactions where user_id=u and idempotency_key=k;
 if found then
  if old.request_body<>p or not exists(select 1 from public.audit_logs where user_id=u and entity_id=tid and action='replace' and details->>'replacement_id'=old.id::text) then raise exception 'Idempotency conflict'; end if;
  return old.id;
 end if;
 select * into old from public.financial_transactions where id=tid and user_id=u;
 if not found or old.voided_at is not null then raise exception 'Transaction unavailable'; end if;
 perform public.internal_void_transaction(tid);
 replacement:=public.record_transaction(p,k);
 perform public.assert_savings_integrity();
 insert into public.audit_logs(user_id,entity,entity_id,action,details) values(u,'transaction',tid,'replace',jsonb_build_object('replacement_id',replacement));
 return replacement;
end $$;

create function public.update_resource(resource text, rid uuid, p jsonb) returns void language plpgsql security definer set search_path='' as $$
declare u uuid:=public.require_user(); tbl text; allowed text[]; keys text[]; col text; columns text; goal public.savings_goals; n integer;
begin
 perform pg_advisory_xact_lock(hashtextextended(u::text,0));
 case resource
 when 'accounts' then tbl:='financial_accounts';allowed:=array['name','active'];
 when 'categories' then tbl:='categories';allowed:=array['name'];
 when 'cards' then tbl:='credit_cards';allowed:=array['name','bank','closing_day','due_day','utilization_limit','active'];
 when 'debts' then tbl:='debts';allowed:=array['name','creditor','active'];
 when 'obligations' then tbl:='payment_obligations';allowed:=array['name','entity','amount','frequency','end_date','active','notes'];
 when 'occurrences' then tbl:='payment_occurrences';allowed:=array['amount','due_date'];
 when 'budgets' then tbl:='budgets';allowed:=array['amount'];
 when 'goals' then
  tbl:='savings_goals';allowed:=array['name','description','minimum_amount','ideal_amount','target_date','priority'];
  select * into goal from public.savings_goals where id=rid;
  if not found or (goal.space_id is null and goal.user_id<>u) or (goal.space_id is not null and not public.is_admin(goal.space_id)) then raise exception 'Forbidden'; end if;
 else raise exception 'Unknown resource'; end case;
 select array_agg(key) into keys from jsonb_object_keys(p) key;
 if keys is null or not keys<@allowed then raise exception 'Unsupported update fields'; end if;
 select string_agg(format('%I',k),',') into columns from unnest(keys) k;
 execute format('update public.%I set (%s)=(select %s from jsonb_populate_record(null::public.%I,$1)) where id=$2 %s',tbl,columns,columns,tbl,case when resource='goals' then '' else 'and user_id=$3' end) using p,rid,u;
 get diagnostics n=row_count;if n<>1 then raise exception 'Resource unavailable'; end if;
 if resource='occurrences' and exists(select 1 from public.payment_occurrences o where o.id=rid and o.amount<coalesce((select sum(op.amount) from public.obligation_payments op join public.financial_transactions ft on ft.id=op.transaction_id where op.occurrence_id=rid and ft.voided_at is null),0)) then raise exception 'Amount below payments'; end if;
 insert into public.audit_logs(user_id,entity,entity_id,action,details) values(u,resource,rid,'update',p);
end $$;

create function public.record_statement(p jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid:=public.require_user(); c public.credit_cards; sid uuid; oid uuid; due date:=(p->>'due_date')::date; amt numeric:=(p->>'amount')::numeric; per date:=(p->>'period')::date;
begin
 perform pg_advisory_xact_lock(hashtextextended(u::text,0));
 select * into c from public.credit_cards where id=(p->>'card_id')::uuid and user_id=u;
 if not found then raise exception 'Card unavailable'; end if;
 if due<=(p->>'closing_date')::date or extract(day from per)<>1 then raise exception 'Invalid statement dates'; end if;
 insert into public.credit_card_statements(user_id,card_id,period,closing_date,due_date,amount,minimum_payment) values(u,c.id,per,(p->>'closing_date')::date,due,amt,(p->>'minimum_payment')::numeric)
 on conflict(card_id,period) do update set closing_date=excluded.closing_date,due_date=excluded.due_date,amount=excluded.amount,minimum_payment=excluded.minimum_payment returning id into sid;
 select id into oid from public.payment_obligations where card_id=c.id and user_id=u and type='card_statement';
 if oid is null then insert into public.payment_obligations(user_id,name,type,amount,currency,frequency,start_date,card_id) values(u,c.name||' · Estado de cuenta','card_statement',greatest(amt,0.01),c.currency,'once',due,c.id) returning id into oid;end if;
 if amt>0 then
  insert into public.payment_occurrences(user_id,obligation_id,period,due_date,amount,currency) values(u,oid,per,due,amt,c.currency)
  on conflict(obligation_id,period) do update set due_date=excluded.due_date,amount=excluded.amount;
  if exists(select 1 from public.payment_occurrences o where o.obligation_id=oid and o.period=per and o.amount<coalesce((select sum(op.amount) from public.obligation_payments op join public.financial_transactions ft on ft.id=op.transaction_id where op.occurrence_id=o.id and ft.voided_at is null),0)) then raise exception 'Statement below payments'; end if;
 end if;
 return sid;
end $$;
-- Loan schedules also generate payable occurrences; interest is scheduled once.
create function public.sync_debt_schedule(d uuid) returns void language plpgsql security definer set search_path='' as $$
declare u uuid:=public.require_user(); debt public.debts; oid uuid; i public.debt_installments;
begin
 perform pg_advisory_xact_lock(hashtextextended(u::text,0));
 select * into debt from public.debts where id=d and user_id=u;
 if not found then raise exception 'Debt unavailable'; end if;
 select id into oid from public.payment_obligations where user_id=u and debt_id=d and type='debt_schedule';
 if oid is null then insert into public.payment_obligations(user_id,name,type,amount,currency,frequency,start_date,debt_id) values(u,debt.name,'debt_schedule',debt.principal,debt.currency,'once',debt.first_due_date,d) returning id into oid;end if;
 for i in select * from public.debt_installments where debt_id=d loop
  insert into public.payment_occurrences(user_id,obligation_id,period,due_date,amount,currency) values(u,oid,date_trunc('month',i.due_date)::date,i.due_date,i.principal+i.interest,debt.currency) on conflict do nothing;
 end loop;
end $$;
revoke execute on function public.assert_savings_integrity(),public.replace_transaction(uuid,jsonb,uuid),public.update_resource(text,uuid,jsonb),public.record_statement(jsonb),public.sync_debt_schedule(uuid) from public,anon;
grant execute on function public.assert_savings_integrity(),public.replace_transaction(uuid,jsonb,uuid),public.update_resource(text,uuid,jsonb),public.record_statement(jsonb),public.sync_debt_schedule(uuid) to authenticated;
$afi_migration_3$;
  -- 005_payment_applications.sql
  execute $afi_migration_4$
create function public.apply_payment() returns trigger language plpgsql security definer set search_path='' as $$
declare remaining numeric:=new.amount; o public.payment_occurrences; pending numeric; portion numeric; payment record; interest_part numeric; interest_due numeric;
begin
 if new.occurrence_id is not null then
  insert into public.obligation_payments(user_id,transaction_id,occurrence_id,amount) values(new.user_id,new.id,new.occurrence_id,new.amount);
 elsif new.type in ('card_payment','loan_payment') then
  for o in select po.* from public.payment_occurrences po join public.payment_obligations ob on ob.id=po.obligation_id
   where po.user_id=new.user_id and ((new.card_id is not null and ob.card_id=new.card_id) or (new.debt_id is not null and ob.debt_id=new.debt_id)) order by po.due_date,po.id for update of po loop
   select o.amount-coalesce(sum(op.amount),0) into pending from public.obligation_payments op join public.financial_transactions ft on ft.id=op.transaction_id where op.occurrence_id=o.id and ft.voided_at is null;
   portion:=least(remaining,pending);
   if portion>0 then insert into public.obligation_payments(user_id,transaction_id,occurrence_id,amount) values(new.user_id,new.id,o.id,portion);remaining:=remaining-portion;end if;
   exit when remaining<=0;
  end loop;
 end if;
 if new.type='loan_payment' then
  for payment in select op.id,op.amount,op.occurrence_id,di.interest from public.obligation_payments op
   join public.payment_occurrences po on po.id=op.occurrence_id
   join public.debt_installments di on di.debt_id=new.debt_id and date_trunc('month',di.due_date)=po.period
   where op.transaction_id=new.id order by po.due_date loop
   select greatest(0,payment.interest-coalesce(sum(op.interest_amount),0)) into interest_due from public.obligation_payments op
    join public.financial_transactions ft on ft.id=op.transaction_id where op.occurrence_id=payment.occurrence_id and ft.voided_at is null and op.id<>payment.id;
   interest_part:=least(payment.amount,interest_due);
   update public.obligation_payments set interest_amount=interest_part,principal_amount=amount-interest_part where id=payment.id;
  end loop;
 end if;
 return new;
end $$;
create trigger apply_financial_payment after insert on public.financial_transactions for each row execute function public.apply_payment();
revoke execute on function public.apply_payment() from public,anon,authenticated;
create index obligation_payments_occurrence on public.obligation_payments(occurrence_id);
$afi_migration_4$;
  -- 006_savings_distribution.sql
  execute $afi_migration_5$
create table public.savings_operations (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id), idempotency_key uuid not null,
 payload jsonb not null, created_at timestamptz not null default now(), unique(user_id,idempotency_key)
);
alter table public.savings_operations enable row level security;
create policy owner_read on public.savings_operations for select to authenticated using(user_id=auth.uid());
revoke all on public.savings_operations from anon,authenticated;
grant select on public.savings_operations to authenticated;

create function public.distribute_savings(p jsonb,k uuid) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid:=public.require_user(); old public.savings_operations; total numeric:=(p->>'amount')::numeric; r jsonb; percentage_sum numeric:=0; allocated numeric:=0; portion numeric; n int:=0; rid uuid; cur text:=p->>'currency'; reserved numeric;
begin
 perform pg_advisory_xact_lock(hashtextextended(u::text,0));
 select * into old from public.savings_operations where user_id=u and idempotency_key=k;
 if found then if old.payload<>p then raise exception 'Idempotency conflict';end if;return old.id;end if;
 if total<=0 or total<>round(total,2) then raise exception 'Invalid distribution amount';end if;
 select coalesce(sum(f.amount),0) into reserved from public.savings_fund_movements f join public.financial_transactions t on t.id=f.transaction_id where f.user_id=u and f.currency=cur and t.voided_at is null;
 if total>reserved-coalesce((select sum(amount) from public.savings_allocations where user_id=u and currency=cur),0) then raise exception 'Insufficient unallocated savings';end if;
 for r in select * from jsonb_array_elements(p->'distribution') loop
  if (r->>'percentage')::numeric<0 or (r->>'percentage')::numeric>100 then raise exception 'Invalid percentage';end if;
  percentage_sum:=percentage_sum+(r->>'percentage')::numeric;
  if r->>'goal_id' is not null then
   if not exists(select 1 from public.savings_goals where id=(r->>'goal_id')::uuid and currency=cur) then raise exception 'Currency mismatch';end if;
   portion:=trunc(total*(r->>'percentage')::numeric/100,2);
   if portion>0 then perform public.allocate_savings((r->>'goal_id')::uuid,portion,md5(k::text||':'||n::text)::uuid);end if;
  end if;
  n:=n+1;
 end loop;
 if percentage_sum<>100 then raise exception 'Percentages must total 100';end if;
 insert into public.savings_operations(user_id,idempotency_key,payload) values(u,k,p) returning id into rid;
 return rid;
end $$;
create function public.reallocate_savings(from_goal uuid,to_goal uuid,amt numeric,k uuid) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid:=public.require_user(); old public.savings_operations; p jsonb:=jsonb_build_object('from_goal',from_goal,'to_goal',to_goal,'amount',amt);rid uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended(u::text,0));
 select * into old from public.savings_operations where user_id=u and idempotency_key=k;
 if found then if old.payload<>p then raise exception 'Idempotency conflict';end if;return old.id;end if;
 if from_goal=to_goal or amt<=0 then raise exception 'Invalid reallocation';end if;
 if (select currency from public.savings_goals where id=from_goal) is distinct from (select currency from public.savings_goals where id=to_goal) then raise exception 'Currency mismatch';end if;
 perform public.allocate_savings(from_goal,-amt,md5(k::text||':source')::uuid);
 perform public.allocate_savings(to_goal,amt,md5(k::text||':destination')::uuid);
 insert into public.savings_operations(user_id,idempotency_key,payload) values(u,k,p) returning id into rid;return rid;
end $$;
revoke execute on function public.distribute_savings(jsonb,uuid),public.reallocate_savings(uuid,uuid,numeric,uuid) from public,anon;
grant execute on function public.distribute_savings(jsonb,uuid),public.reallocate_savings(uuid,uuid,numeric,uuid) to authenticated;
$afi_migration_5$;
  -- 007_shared_member_names.sql
  execute $afi_migration_6$
create function public.list_shared_members() returns table(space_id uuid,user_id uuid,role text,can_create_goals boolean,display_name text) language sql stable security definer set search_path='' as $$
 select m.space_id,m.user_id,m.role,m.can_create_goals,p.display_name
 from public.shared_space_members m join public.profiles p on p.id=m.user_id
 where public.is_member(m.space_id)
$$;
revoke execute on function public.list_shared_members() from public,anon;
grant execute on function public.list_shared_members() to authenticated;
$afi_migration_6$;
  -- 008_registered_invitations.sql
  execute $afi_migration_7$
alter table public.shared_space_invitations add column if not exists invitee_user_id uuid references public.profiles(id), add column if not exists goal_id uuid references public.savings_goals(id) on delete set null;
create unique index if not exists invitation_registered_pending on public.shared_space_invitations(space_id,invitee_user_id) where status='pending' and invitee_user_id is not null;

create or replace function public.search_registered_users(s uuid, q text default '') returns table(id uuid,display_name text,username text,is_member boolean,is_invited boolean)
language plpgsql stable security definer set search_path='' as $$
begin
 perform public.require_user();
 if not public.is_admin(s) then raise exception 'Solo el administrador puede buscar usuarios para invitar'; end if;
 return query select p.id,p.display_name,split_part(a.email,'@',1),
 exists(select 1 from public.shared_space_members m where m.space_id=s and m.user_id=p.id),
 exists(select 1 from public.shared_space_invitations i where i.space_id=s and i.status='pending' and i.expires_at>now() and (i.invitee_user_id=p.id or (i.invitee_user_id is null and lower(i.email)=lower(a.email))))
 from public.profiles p join auth.users a on a.id=p.id
 where p.id<>auth.uid() and a.email is not null and (position(lower(left(trim(q),80)) in lower(p.display_name))>0 or position(lower(left(trim(q),80)) in lower(split_part(a.email,'@',1)))>0)
 order by p.display_name,p.id limit 30;
end $$;

create or replace function public.invite_registered_user(s uuid,target uuid,g uuid default null) returns uuid
language plpgsql security definer set search_path='' as $$
declare u uuid:=public.require_user(); address text; result uuid;
begin
 if not public.is_admin(s) then raise exception 'Solo el administrador puede invitar'; end if;
 perform pg_advisory_xact_lock(hashtextextended(s::text,0));
 if target=u or exists(select 1 from public.shared_space_members where space_id=s and user_id=target) then raise exception 'El usuario ya pertenece al espacio'; end if;
 if g is not null and not exists(select 1 from public.savings_goals where id=g and space_id=s) then raise exception 'El objetivo no pertenece al espacio'; end if;
 select a.email into address from auth.users a join public.profiles p on p.id=a.id where a.id=target;
 if address is null then raise exception 'Usuario no registrado'; end if;
 update public.shared_space_invitations set status='revoked' where space_id=s and status='pending' and expires_at<=now() and (invitee_user_id=target or lower(email)=lower(address));
 select id into result from public.shared_space_invitations where space_id=s and status='pending' and expires_at>now() and (invitee_user_id=target or lower(email)=lower(address)) order by created_at limit 1;
 if result is not null then return result; end if;
 insert into public.shared_space_invitations(space_id,invited_by,email,token_hash,invitee_user_id,goal_id)
 values(s,u,lower(address),encode(extensions.digest(extensions.gen_random_bytes(32),'sha256'),'hex'),target,g) returning id into result;
 return result;
end $$;

create or replace function public.incoming_invitations() returns table(id uuid,space_id uuid,space_name text,inviter_name text,goal_id uuid,goal_name text,expires_at timestamptz,created_at timestamptz)
language plpgsql stable security definer set search_path='' as $$
begin
 perform public.require_user();
 return query select i.id,i.space_id,s.name,p.display_name,i.goal_id,g.name,i.expires_at,i.created_at
 from public.shared_space_invitations i join public.shared_spaces s on s.id=i.space_id join public.profiles p on p.id=i.invited_by left join public.savings_goals g on g.id=i.goal_id
 where i.status='pending' and i.expires_at>now() and (i.invitee_user_id=auth.uid() or (i.invitee_user_id is null and lower(i.email)=lower(auth.jwt()->>'email')))
 order by i.created_at desc;
end $$;

create or replace function public.respond_registered_invitation(invitation_id uuid,accept boolean) returns uuid
language plpgsql security definer set search_path='' as $$
declare u uuid:=public.require_user(); i public.shared_space_invitations;
begin
 select * into i from public.shared_space_invitations where id=invitation_id for update;
 if i.id is null or not coalesce(i.invitee_user_id=u or (i.invitee_user_id is null and lower(i.email)=lower(auth.jwt()->>'email')),false) then raise exception 'Invitación no disponible'; end if;
 if (i.status='accepted' and accept) or (i.status='rejected' and not accept) then return i.space_id; end if;
 if i.status<>'pending' or i.expires_at<=now() then raise exception 'La invitación expiró o ya fue respondida'; end if;
 if accept then insert into public.shared_space_members(space_id,user_id,role,can_create_goals) values(i.space_id,u,'member',false) on conflict do nothing; end if;
 update public.shared_space_invitations set status=case when accept then 'accepted' else 'rejected' end where id=i.id;
 return i.space_id;
end $$;
revoke execute on function public.search_registered_users(uuid,text),public.invite_registered_user(uuid,uuid,uuid),public.incoming_invitations(),public.respond_registered_invitation(uuid,boolean) from public,anon;
grant execute on function public.search_registered_users(uuid,text),public.invite_registered_user(uuid,uuid,uuid),public.incoming_invitations(),public.respond_registered_invitation(uuid,boolean) to authenticated;
notify pgrst, 'reload schema';
$afi_migration_7$;
 else
  foreach required_table in array array['profiles','user_preferences','financial_accounts','categories','credit_cards','debts','payment_obligations','payment_occurrences','financial_transactions','transaction_entries','obligation_payments','budgets','credit_card_purchases','credit_card_installments','credit_card_statements','debt_installments','shared_spaces','shared_space_members','shared_space_invitations','savings_goals','savings_goal_members','savings_plans','savings_fund_movements','savings_allocations','notifications','notification_preferences','ai_usage_limits','ai_usage_logs','ai_drafts','audit_logs','savings_operations'] loop
   if to_regclass('public.'||required_table) is null then
    raise exception 'La instalación AFI está incompleta: falta public.%. Aplica las migraciones pendientes antes de repetir.',required_table;
   end if;
   if not (select relrowsecurity from pg_class where oid=to_regclass('public.'||required_table)) then
    raise exception 'RLS está desactivado en public.%. Revisa su configuración antes de continuar.',required_table;
   end if;
  end loop;
  -- Actualizacion repetible de invitaciones para instalaciones existentes.
  execute $afi_upgrade_invitations$
alter table public.shared_space_invitations add column if not exists invitee_user_id uuid references public.profiles(id), add column if not exists goal_id uuid references public.savings_goals(id) on delete set null;
create unique index if not exists invitation_registered_pending on public.shared_space_invitations(space_id,invitee_user_id) where status='pending' and invitee_user_id is not null;

create or replace function public.search_registered_users(s uuid, q text default '') returns table(id uuid,display_name text,username text,is_member boolean,is_invited boolean)
language plpgsql stable security definer set search_path='' as $$
begin
 perform public.require_user();
 if not public.is_admin(s) then raise exception 'Solo el administrador puede buscar usuarios para invitar'; end if;
 return query select p.id,p.display_name,split_part(a.email,'@',1),
 exists(select 1 from public.shared_space_members m where m.space_id=s and m.user_id=p.id),
 exists(select 1 from public.shared_space_invitations i where i.space_id=s and i.status='pending' and i.expires_at>now() and (i.invitee_user_id=p.id or (i.invitee_user_id is null and lower(i.email)=lower(a.email))))
 from public.profiles p join auth.users a on a.id=p.id
 where p.id<>auth.uid() and a.email is not null and (position(lower(left(trim(q),80)) in lower(p.display_name))>0 or position(lower(left(trim(q),80)) in lower(split_part(a.email,'@',1)))>0)
 order by p.display_name,p.id limit 30;
end $$;

create or replace function public.invite_registered_user(s uuid,target uuid,g uuid default null) returns uuid
language plpgsql security definer set search_path='' as $$
declare u uuid:=public.require_user(); address text; result uuid;
begin
 if not public.is_admin(s) then raise exception 'Solo el administrador puede invitar'; end if;
 perform pg_advisory_xact_lock(hashtextextended(s::text,0));
 if target=u or exists(select 1 from public.shared_space_members where space_id=s and user_id=target) then raise exception 'El usuario ya pertenece al espacio'; end if;
 if g is not null and not exists(select 1 from public.savings_goals where id=g and space_id=s) then raise exception 'El objetivo no pertenece al espacio'; end if;
 select a.email into address from auth.users a join public.profiles p on p.id=a.id where a.id=target;
 if address is null then raise exception 'Usuario no registrado'; end if;
 update public.shared_space_invitations set status='revoked' where space_id=s and status='pending' and expires_at<=now() and (invitee_user_id=target or lower(email)=lower(address));
 select id into result from public.shared_space_invitations where space_id=s and status='pending' and expires_at>now() and (invitee_user_id=target or lower(email)=lower(address)) order by created_at limit 1;
 if result is not null then return result; end if;
 insert into public.shared_space_invitations(space_id,invited_by,email,token_hash,invitee_user_id,goal_id)
 values(s,u,lower(address),encode(extensions.digest(extensions.gen_random_bytes(32),'sha256'),'hex'),target,g) returning id into result;
 return result;
end $$;

create or replace function public.incoming_invitations() returns table(id uuid,space_id uuid,space_name text,inviter_name text,goal_id uuid,goal_name text,expires_at timestamptz,created_at timestamptz)
language plpgsql stable security definer set search_path='' as $$
begin
 perform public.require_user();
 return query select i.id,i.space_id,s.name,p.display_name,i.goal_id,g.name,i.expires_at,i.created_at
 from public.shared_space_invitations i join public.shared_spaces s on s.id=i.space_id join public.profiles p on p.id=i.invited_by left join public.savings_goals g on g.id=i.goal_id
 where i.status='pending' and i.expires_at>now() and (i.invitee_user_id=auth.uid() or (i.invitee_user_id is null and lower(i.email)=lower(auth.jwt()->>'email')))
 order by i.created_at desc;
end $$;

create or replace function public.respond_registered_invitation(invitation_id uuid,accept boolean) returns uuid
language plpgsql security definer set search_path='' as $$
declare u uuid:=public.require_user(); i public.shared_space_invitations;
begin
 select * into i from public.shared_space_invitations where id=invitation_id for update;
 if i.id is null or not coalesce(i.invitee_user_id=u or (i.invitee_user_id is null and lower(i.email)=lower(auth.jwt()->>'email')),false) then raise exception 'Invitación no disponible'; end if;
 if (i.status='accepted' and accept) or (i.status='rejected' and not accept) then return i.space_id; end if;
 if i.status<>'pending' or i.expires_at<=now() then raise exception 'La invitación expiró o ya fue respondida'; end if;
 if accept then insert into public.shared_space_members(space_id,user_id,role,can_create_goals) values(i.space_id,u,'member',false) on conflict do nothing; end if;
 update public.shared_space_invitations set status=case when accept then 'accepted' else 'rejected' end where id=i.id;
 return i.space_id;
end $$;
revoke execute on function public.search_registered_users(uuid,text),public.invite_registered_user(uuid,uuid,uuid),public.incoming_invitations(),public.respond_registered_invitation(uuid,boolean) from public,anon;
grant execute on function public.search_registered_users(uuid,text),public.invite_registered_user(uuid,uuid,uuid),public.incoming_invitations(),public.respond_registered_invitation(uuid,boolean) to authenticated;
notify pgrst, 'reload schema';
$afi_upgrade_invitations$;
 end if;
end $afi_install$;

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

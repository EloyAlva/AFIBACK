begin;
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
commit;

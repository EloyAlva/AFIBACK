begin;

alter table public.savings_goals add column start_date date not null default current_date;
update public.savings_goals g set start_date=least(current_date,coalesce((select min(created_at)::date from public.savings_allocations a where a.goal_id=g.id),current_date),g.target_date);
alter table public.savings_plans add column share_authorized boolean not null default false;
drop policy shared_plan_read on public.savings_plans;
create policy shared_plan_read on public.savings_plans for select to authenticated using(share_authorized and public.can_access_goal(goal_id));

create table public.savings_planner_budgets (
 user_id uuid not null references public.profiles(id), currency text not null check(currency ~ '^[A-Z]{3}$'),
 month date not null check(extract(day from month)=1), monthly_income numeric(18,2) not null check(monthly_income>=0),
 savings_percentage numeric(5,2) not null check(savings_percentage between 0 and 100),
 maximum_savings numeric(18,2) not null check(maximum_savings>=0), essential_expenses numeric(18,2) not null default 0 check(essential_expenses>=0),
 primary key(user_id,currency,month)
);
alter table public.savings_planner_budgets enable row level security;
create policy owner_read on public.savings_planner_budgets for select to authenticated using(user_id=auth.uid());
revoke all on public.savings_planner_budgets from public,anon,authenticated;
grant select on public.savings_planner_budgets to authenticated;

create function public.save_planner_budget(p jsonb) returns void language plpgsql security definer set search_path='' as $$
declare u uuid:=public.require_user();
begin
 insert into public.savings_planner_budgets(user_id,currency,month,monthly_income,savings_percentage,maximum_savings,essential_expenses)
 values(u,p->>'currency',(p->>'month')::date,(p->>'monthly_income')::numeric,(p->>'savings_percentage')::numeric,(p->>'maximum_savings')::numeric,(p->>'essential_expenses')::numeric)
 on conflict(user_id,currency,month) do update set monthly_income=excluded.monthly_income,savings_percentage=excluded.savings_percentage,maximum_savings=excluded.maximum_savings,essential_expenses=excluded.essential_expenses;
 -- Audit contains no private income values.
 insert into public.audit_logs(user_id,entity,entity_id,action) values(u,'planner_budget',u,'update');
end $$;

create function public.save_savings_plans(entries jsonb) returns void language plpgsql security definer set search_path='' as $$
declare u uuid:=public.require_user(); r jsonb; g uuid; m date; amt numeric; rid uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended(u::text,0));
 if jsonb_typeof(entries)<>'array' or jsonb_array_length(entries)>5000 then raise exception 'Invalid plan'; end if;
 if exists(select 1 from jsonb_array_elements(entries) e group by e->>'goal_id',e->>'month' having count(*)>1) then raise exception 'Duplicate plan'; end if;
 for r in select * from jsonb_array_elements(entries) loop
  g:=(r->>'goal_id')::uuid;m:=(r->>'month')::date;amt:=(r->>'amount')::numeric;
  if not public.can_access_goal(g) then raise exception 'Goal unavailable'; end if;
  if m<>date_trunc('month',m)::date or amt is null or amt<0 or amt<>round(amt,2) then raise exception 'Invalid plan amount or month'; end if;
  insert into public.savings_plans(user_id,goal_id,month,amount,share_authorized)
  values(u,g,m,amt,coalesce((r->>'share_authorized')::boolean,false))
  on conflict(user_id,goal_id,month) do update set amount=excluded.amount,share_authorized=excluded.share_authorized returning id into rid;
  insert into public.audit_logs(user_id,entity,entity_id,action) values(u,'savings_plan',rid,'update');
 end loop;
end $$;

-- Preserve existing business rules and add start-date validation/auditing.
create or replace function public.plan_savings(g uuid,m date,amt numeric) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid:=public.require_user(); rid uuid;
begin
 perform public.save_savings_plans(jsonb_build_array(jsonb_build_object('goal_id',g,'month',date_trunc('month',m)::date,'amount',amt,'share_authorized',false)));
 select id into rid from public.savings_plans where user_id=u and goal_id=g and month=date_trunc('month',m)::date;
 return rid;
end $$;

alter function public.create_resource(text,jsonb) rename to create_resource_before_planner;
create function public.create_resource(resource text,p jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare rid uuid;
begin
 if resource='goals' and (p->>'start_date')::date>(p->>'target_date')::date then raise exception 'La fecha de inicio debe ser anterior al vencimiento'; end if;
 rid:=public.create_resource_before_planner(resource,case when resource='goals' then p-'start_date' else p end);
 if resource='goals' then update public.savings_goals set start_date=coalesce((p->>'start_date')::date,least(current_date,target_date)) where id=rid;end if;
 return rid;
end $$;
alter function public.update_resource(text,uuid,jsonb) rename to update_resource_before_planner;
create function public.update_resource(resource text,rid uuid,p jsonb) returns void language plpgsql security definer set search_path='' as $$
declare goal public.savings_goals; u uuid:=public.require_user();
begin
 perform pg_advisory_xact_lock(hashtextextended(u::text,0));
 if resource='goals' then
  select * into goal from public.savings_goals where id=rid for update;
  if not found or (goal.space_id is null and goal.user_id<>u) or (goal.space_id is not null and not public.is_admin(goal.space_id)) then raise exception 'Forbidden';end if;
  if coalesce((p->>'start_date')::date,goal.start_date)>coalesce((p->>'target_date')::date,goal.target_date) then raise exception 'La fecha de inicio debe ser anterior al vencimiento';end if;
  if p-'start_date'<>'{}'::jsonb then perform public.update_resource_before_planner(resource,rid,p-'start_date');end if;
  if p?'start_date' then
   update public.savings_goals set start_date=(p->>'start_date')::date where id=rid;
   insert into public.audit_logs(user_id,entity,entity_id,action,details) values(u,'goals',rid,'timeline',jsonb_build_object('start_date',p->>'start_date'));
  end if;
 else perform public.update_resource_before_planner(resource,rid,p);end if;
end $$;

-- Serialize goal totals across contributors and prevent contributions above a goal's balance.
create or replace function public.allocate_savings(g uuid,amt numeric,k uuid) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid:=public.require_user(); goal public.savings_goals; reserved numeric; allocated numeric; rid uuid; old public.savings_allocations;
begin
 perform pg_advisory_xact_lock(hashtextextended(u::text,0));
 select * into old from public.savings_allocations where user_id=u and idempotency_key=k;
 if found then if old.goal_id<>g or old.amount<>amt then raise exception 'Idempotency conflict';end if;return old.id;end if;
 select * into goal from public.savings_goals where id=g for update;
 if not found or not public.can_access_goal(g) then raise exception 'Goal unavailable';end if;
 if amt=0 or amt<>round(amt,2) then raise exception 'Invalid allocation';end if;
 if amt>0 and amt>goal.ideal_amount-coalesce((select sum(amount) from public.savings_allocations where goal_id=g),0) then raise exception 'El aporte supera el saldo pendiente del objetivo';end if;
 select coalesce(sum(f.amount),0) into reserved from public.savings_fund_movements f join public.financial_transactions t on t.id=f.transaction_id where f.user_id=u and f.currency=goal.currency and t.voided_at is null;
 select coalesce(sum(amount),0) into allocated from public.savings_allocations where user_id=u and currency=goal.currency;
 if amt>0 and amt>reserved-allocated then raise exception 'Insufficient unallocated savings';end if;
 if amt<0 and -amt>coalesce((select sum(amount) from public.savings_allocations where user_id=u and goal_id=g),0) then raise exception 'Withdrawal exceeds contribution';end if;
 insert into public.savings_allocations(user_id,goal_id,amount,currency,idempotency_key) values(u,g,amt,goal.currency,k) returning id into rid;
 insert into public.audit_logs(user_id,entity,entity_id,action) values(u,'allocation',rid,'create');return rid;
end $$;

create or replace function public.reallocate_savings(from_goal uuid,to_goal uuid,amt numeric,k uuid) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid:=public.require_user(); old public.savings_operations; p jsonb:=jsonb_build_object('from_goal',from_goal,'to_goal',to_goal,'amount',amt);rid uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended(u::text,0));
 select * into old from public.savings_operations where user_id=u and idempotency_key=k;
 if found then if old.payload<>p then raise exception 'Idempotency conflict';end if;return old.id;end if;
 if from_goal=to_goal or amt<=0 then raise exception 'Invalid reallocation';end if;
 perform 1 from public.savings_goals where id in (from_goal,to_goal) order by id for update;
 if (select currency from public.savings_goals where id=from_goal) is distinct from (select currency from public.savings_goals where id=to_goal) then raise exception 'Currency mismatch';end if;
 perform public.allocate_savings(from_goal,-amt,md5(k::text||':source')::uuid);
 perform public.allocate_savings(to_goal,amt,md5(k::text||':destination')::uuid);
 insert into public.savings_operations(user_id,idempotency_key,payload) values(u,k,p) returning id into rid;return rid;
end $$;

create or replace function public.set_goal_members(g uuid,members jsonb) returns void language plpgsql security definer set search_path='' as $$
declare u uuid:=public.require_user(); goal public.savings_goals; r jsonb; total numeric:=0;
begin
 select * into goal from public.savings_goals where id=g for update;
 if not found or goal.space_id is null or not public.is_admin(goal.space_id) then raise exception 'Forbidden';end if;
 if jsonb_typeof(members)<>'array' or jsonb_array_length(members)=0 then raise exception 'Invalid participants';end if;
 if exists(select 1 from jsonb_array_elements(members) e group by e->>'user_id' having count(*)>1) then raise exception 'Duplicate participant';end if;
 for r in select * from jsonb_array_elements(members) loop
  if not exists(select 1 from public.shared_space_members where space_id=goal.space_id and user_id=(r->>'user_id')::uuid) then raise exception 'Participant unavailable';end if;
  if r->>'percentage' is null or (r->>'percentage')::numeric not between 0 and 100 or (r->>'percentage')::numeric<>round((r->>'percentage')::numeric,2) then raise exception 'Invalid percentage';end if;
  total:=total+(r->>'percentage')::numeric;
 end loop;
 if total<>100 then raise exception 'Participation must total 100';end if;
 delete from public.savings_goal_members where goal_id=g;
 insert into public.savings_goal_members(goal_id,user_id,percentage) select g,(v->>'user_id')::uuid,(v->>'percentage')::numeric from jsonb_array_elements(members) v;
 insert into public.audit_logs(user_id,entity,entity_id,action) values(u,'goal_members',g,'update');
end $$;

create or replace function public.distribute_savings(p jsonb,k uuid) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid:=public.require_user(); old public.savings_operations; total numeric:=(p->>'amount')::numeric; r jsonb; percentage_sum numeric:=0; portion numeric; n int:=0; rid uuid; cur text:=p->>'currency'; reserved numeric;
begin
 perform pg_advisory_xact_lock(hashtextextended(u::text,0));
 select * into old from public.savings_operations where user_id=u and idempotency_key=k;
 if found then if old.payload<>p then raise exception 'Idempotency conflict';end if;return old.id;end if;
 if total<=0 or total<>round(total,2) then raise exception 'Invalid distribution amount';end if;
 if exists(select 1 from jsonb_array_elements(p->'distribution') e group by e->>'goal_id' having count(*)>1) then raise exception 'Duplicate distribution target';end if;
 perform 1 from public.savings_goals where id in (select (e->>'goal_id')::uuid from jsonb_array_elements(p->'distribution') e) order by id for update;
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
 insert into public.savings_operations(user_id,idempotency_key,payload) values(u,k,p) returning id into rid;return rid;
end $$;

revoke execute on function public.create_resource_before_planner(text,jsonb),public.update_resource_before_planner(text,uuid,jsonb) from public,anon,authenticated;
revoke execute on function public.save_planner_budget(jsonb),public.save_savings_plans(jsonb),public.create_resource(text,jsonb),public.update_resource(text,uuid,jsonb) from public,anon;
grant execute on function public.save_planner_budget(jsonb),public.save_savings_plans(jsonb),public.create_resource(text,jsonb),public.update_resource(text,uuid,jsonb) to authenticated;
commit;

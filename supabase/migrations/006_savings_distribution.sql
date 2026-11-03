begin;
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
commit;

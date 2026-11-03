begin;
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
commit;

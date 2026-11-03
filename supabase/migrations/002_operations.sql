begin;
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
commit;

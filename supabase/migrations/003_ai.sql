begin;
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
commit;

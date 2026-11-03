begin;
alter table public.user_preferences add column if not exists savings_target_percentage numeric(5,2) not null default 20 check(savings_target_percentage between 0 and 100);

create or replace function public.update_profile(p jsonb) returns void language plpgsql security definer set search_path='' as $$
declare u uuid:=public.require_user();
begin
 if not exists(select 1 from pg_timezone_names where name=p->>'timezone') then raise exception 'Invalid timezone'; end if;
 update public.profiles set display_name=p->>'display_name',currency=p->>'currency',timezone=p->>'timezone' where id=u;
 update public.user_preferences set ant_expense_threshold=(p->>'ant_expense_threshold')::numeric,
 savings_target_percentage=coalesce((p->>'savings_target_percentage')::numeric,savings_target_percentage),
 budget_thresholds=case when p?'budget_thresholds' then array(select jsonb_array_elements_text(p->'budget_thresholds')::int) else budget_thresholds end where user_id=u;
end $$;
commit;

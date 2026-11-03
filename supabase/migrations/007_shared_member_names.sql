begin;
create function public.list_shared_members() returns table(space_id uuid,user_id uuid,role text,can_create_goals boolean,display_name text) language sql stable security definer set search_path='' as $$
 select m.space_id,m.user_id,m.role,m.can_create_goals,p.display_name
 from public.shared_space_members m join public.profiles p on p.id=m.user_id
 where public.is_member(m.space_id)
$$;
revoke execute on function public.list_shared_members() from public,anon;
grant execute on function public.list_shared_members() to authenticated;
commit;

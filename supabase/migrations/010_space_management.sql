begin;

create or replace function public.edit_space(s uuid, new_name text) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform public.require_user();
 perform 1 from public.shared_spaces where id=s for update;
 if not public.is_admin(s) then raise exception 'Forbidden'; end if;
 if new_name is null or length(trim(new_name)) not between 1 and 120 then
  raise exception 'Nombre de espacio inválido';
 end if;
 update public.shared_spaces set name=trim(new_name) where id=s;
end $$;

create or replace function public.delete_space(s uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform public.require_user();
 perform 1 from public.shared_spaces where id=s for update;
 if not public.is_admin(s) then raise exception 'Forbidden'; end if;
 if exists(select 1 from public.savings_goals where space_id=s) then
  raise exception 'No se puede eliminar un espacio con objetivos asociados';
 end if;
 delete from public.shared_space_invitations where space_id=s;
 delete from public.shared_space_members where space_id=s;
 delete from public.shared_spaces where id=s;
end $$;

revoke execute on function public.edit_space(uuid,text),public.delete_space(uuid) from public,anon;
grant execute on function public.edit_space(uuid,text),public.delete_space(uuid) to authenticated;

commit;

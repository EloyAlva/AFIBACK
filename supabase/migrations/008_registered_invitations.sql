begin;
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
commit;

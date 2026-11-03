begin;
create function public.apply_payment() returns trigger language plpgsql security definer set search_path='' as $$
declare remaining numeric:=new.amount; o public.payment_occurrences; pending numeric; portion numeric; payment record; interest_part numeric; interest_due numeric;
begin
 if new.occurrence_id is not null then
  insert into public.obligation_payments(user_id,transaction_id,occurrence_id,amount) values(new.user_id,new.id,new.occurrence_id,new.amount);
 elsif new.type in ('card_payment','loan_payment') then
  for o in select po.* from public.payment_occurrences po join public.payment_obligations ob on ob.id=po.obligation_id
   where po.user_id=new.user_id and ((new.card_id is not null and ob.card_id=new.card_id) or (new.debt_id is not null and ob.debt_id=new.debt_id)) order by po.due_date,po.id for update of po loop
   select o.amount-coalesce(sum(op.amount),0) into pending from public.obligation_payments op join public.financial_transactions ft on ft.id=op.transaction_id where op.occurrence_id=o.id and ft.voided_at is null;
   portion:=least(remaining,pending);
   if portion>0 then insert into public.obligation_payments(user_id,transaction_id,occurrence_id,amount) values(new.user_id,new.id,o.id,portion);remaining:=remaining-portion;end if;
   exit when remaining<=0;
  end loop;
 end if;
 if new.type='loan_payment' then
  for payment in select op.id,op.amount,op.occurrence_id,di.interest from public.obligation_payments op
   join public.payment_occurrences po on po.id=op.occurrence_id
   join public.debt_installments di on di.debt_id=new.debt_id and date_trunc('month',di.due_date)=po.period
   where op.transaction_id=new.id order by po.due_date loop
   select greatest(0,payment.interest-coalesce(sum(op.interest_amount),0)) into interest_due from public.obligation_payments op
    join public.financial_transactions ft on ft.id=op.transaction_id where op.occurrence_id=payment.occurrence_id and ft.voided_at is null and op.id<>payment.id;
   interest_part:=least(payment.amount,interest_due);
   update public.obligation_payments set interest_amount=interest_part,principal_amount=amount-interest_part where id=payment.id;
  end loop;
 end if;
 return new;
end $$;
create trigger apply_financial_payment after insert on public.financial_transactions for each row execute function public.apply_payment();
revoke execute on function public.apply_payment() from public,anon,authenticated;
create index obligation_payments_occurrence on public.obligation_payments(occurrence_id);
commit;

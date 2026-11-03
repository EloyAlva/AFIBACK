import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

test("Migraciones completas, RLS y operaciones atómicas en PostgreSQL", async (t) => {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
   create schema auth;
   create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb not null default '{}');
   create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
   grant usage on schema public,auth to authenticated,anon,service_role;
   grant execute on all functions in schema auth to authenticated,anon,service_role;`);
    for (const file of (
      await readdir(new URL("../supabase/migrations/", import.meta.url))
    )
      .filter((f) => f.endsWith(".sql"))
      .sort())
      await db.exec(
        await readFile(
          new URL("../supabase/migrations/" + file, import.meta.url),
          "utf8",
        ),
      );
    // La reparación puede repetirse aunque la migración ya esté aplicada.
    await db.exec(await readFile(new URL("../supabase/migrations/008_registered_invitations.sql", import.meta.url), "utf8"));
    const u = randomUUID(),
      v = randomUUID();
    await db.query(
      `insert into auth.users(id,email) values($1,'one@example.com'),($2,'two@example.com')`,
      [u, v],
    );
    const login = async (id: string, email = "one@example.com") => {
      await db.exec("reset role");
      await db.query(
        "select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
        [id, JSON.stringify({ sub: id, email })],
      );
      await db.exec("set role authenticated");
    };
    const rpc = async (name: string, args: unknown[]) => {
      const r = await db.query<{ result: any }>(
        `select public.${name}(${args.map((_, i) => "$" + (i + 1)).join(",")}) as result`,
        args,
      );
      return r.rows[0].result;
    };
    const create = (resource: string, p: unknown) =>
      rpc("create_resource", [resource, JSON.stringify(p)]);
    await login(u);
    await t.test(
      "Invitaciones registradas requieren aceptación y protegen acceso",
      async () => {
        const space = await create("spaces", { name: "Familia" });
        const users = await db.query<any>(
          "select * from public.search_registered_users($1,'two')",
          [space],
        );
        assert.equal(users.rows.length, 1);
        assert.equal(users.rows[0].id, v);
        assert.equal(users.rows[0].email, undefined);
        const invitation = await rpc("invite_registered_user", [
          space,
          v,
          null,
        ]);
        assert.equal(
          await rpc("invite_registered_user", [space, v, null]),
          invitation,
        );
        assert.deepEqual(
          (await db.query("select * from public.incoming_invitations()")).rows,
          [],
        );
        await assert.rejects(
          rpc("respond_registered_invitation", [invitation, true]),
        );
        await login(v, "two@example.com");
        await assert.rejects(
          db.query("select * from public.search_registered_users($1,'')", [
            space,
          ]),
        );
        assert.equal(
          (
            await db.query("select * from public.shared_spaces where id=$1", [
              space,
            ])
          ).rows.length,
          0,
        );
        assert.equal(
          (await db.query("select * from public.incoming_invitations()")).rows
            .length,
          1,
        );
        await rpc("respond_registered_invitation", [invitation, false]);
        assert.equal(
          (
            await db.query("select * from public.shared_spaces where id=$1", [
              space,
            ])
          ).rows.length,
          0,
        );
        await login(u);
        const second = await rpc("invite_registered_user", [space, v, null]);
        await login(v, "two@example.com");
        await rpc("respond_registered_invitation", [second, true]);
        await rpc("respond_registered_invitation", [second, true]);
        assert.equal(
          (
            await db.query("select * from public.shared_spaces where id=$1", [
              space,
            ])
          ).rows.length,
          1,
        );
        assert.equal(
          (await db.query("select * from public.incoming_invitations()")).rows
            .length,
          0,
        );
        await db.exec("reset role");
        await db.query(
          "delete from public.shared_space_invitations where space_id=$1",
          [space],
        );
        await db.query(
          "delete from public.shared_space_members where space_id=$1",
          [space],
        );
        await db.query("delete from public.shared_spaces where id=$1", [space]);
        await login(u);
      },
    );
    const a = await create("accounts", {
      name: "Efectivo",
      type: "cash",
      currency: "PEN",
      opening_balance: 1000,
    });
    const b = await create("accounts", {
      name: "Yape",
      type: "wallet",
      currency: "PEN",
      opening_balance: 0,
    });
    await t.test(
      "Categorías personales: crear por tipo, renombrar y proteger contra cambios ajenos",
      async () => {
        const income = await create("categories", {
          name: "Regalos",
          type: "income",
        });
        const expense = await create("categories", {
          name: "Regalos",
          type: "expense",
        });
        assert.notEqual(income, expense);
        await assert.rejects(
          create("categories", { name: "Regalos", type: "income" }),
        );
        await rpc("update_resource", [
          "categories",
          income,
          JSON.stringify({ name: "Regalos recibidos" }),
        ]);
        const row = (
          await db.query<any>(
            "select name,type from public.categories where id=$1",
            [income],
          )
        ).rows[0];
        assert.equal(row.name, "Regalos recibidos");
        assert.equal(row.type, "income");
        await assert.rejects(
          rpc("update_resource", [
            "categories",
            income,
            JSON.stringify({ type: "expense" }),
          ]),
        );
        await login(v, "two@example.com");
        assert.equal(
          (
            await db.query("select * from public.categories where id=$1", [
              income,
            ])
          ).rows.length,
          0,
        );
        await assert.rejects(
          rpc("update_resource", [
            "categories",
            income,
            JSON.stringify({ name: "Alterada" }),
          ]),
        );
        await login(u);
      },
    );
    await t.test("RLS impide leer y gastar cuentas ajenas", async () => {
      await login(v, "two@example.com");
      assert.equal(
        (await db.query("select * from public.financial_accounts")).rows.length,
        0,
      );
      await assert.rejects(
        rpc("record_transaction", [
          JSON.stringify({
            type: "expense",
            amount: 10,
            currency: "PEN",
            source_account_id: a,
            occurred_at: "2026-11-02T12:00:00Z",
            description: "Ataque",
          }),
          randomUUID(),
        ]),
      );
      await assert.rejects(
        db.query(
          "insert into public.financial_accounts(user_id,name,type) values($1,'Ataque','cash')",
          [v],
        ),
      );
      await login(u);
    });
    const base = {
      currency: "PEN",
      occurred_at: "2026-11-02T12:00:00Z",
      description: "Transferencia",
    };
    const transfer = {
      ...base,
      type: "transfer",
      amount: 250,
      source_account_id: a,
      destination_account_id: b,
    };
    const k = randomUUID();
    await t.test(
      "Idempotencia concurrente y doble partida en transferencias",
      async () => {
        const ids = await Promise.all([
          rpc("record_transaction", [JSON.stringify(transfer), k]),
          rpc("record_transaction", [JSON.stringify(transfer), k]),
        ]);
        assert.equal(ids[0], ids[1]);
        const r = await db.query<{ total: string; count: number }>(
          "select sum(amount)::text as total,count(*)::int as count from public.transaction_entries where transaction_id=$1",
          [ids[0]],
        );
        assert.equal(Number(r.rows[0].total), 0);
        assert.equal(r.rows[0].count, 2);
        await assert.rejects(
          rpc("record_transaction", [
            JSON.stringify({ ...transfer, amount: 300 }),
            k,
          ]),
        );
      },
    );
    let obligation: string;
    await t.test(
      "Recurrencias ancladas al día 31, sin duplicar y con pagos parciales",
      async () => {
        obligation = await create("obligations", {
          name: "Internet",
          type: "service",
          amount: 100,
          currency: "PEN",
          frequency: "monthly",
          start_date: "2028-01-31",
        });
        assert.equal(
          await rpc("generate_occurrences", ["2028-01-01", "2028-03-31"]),
          3,
        );
        assert.equal(
          await rpc("generate_occurrences", ["2028-01-01", "2028-03-31"]),
          0,
        );
        const o = await db.query<any>(
          "select * from public.payment_occurrences order by due_date",
        );
        assert.deepEqual(
          o.rows.map((r: any) =>
            new Date(r.due_date).toISOString().slice(0, 10),
          ),
          ["2028-01-31", "2028-02-29", "2028-03-31"],
        );
        await rpc("record_transaction", [
          JSON.stringify({
            ...base,
            type: "obligation_payment",
            amount: 30,
            source_account_id: a,
            occurrence_id: o.rows[0].id,
          }),
          randomUUID(),
        ]);
        await assert.rejects(
          rpc("record_transaction", [
            JSON.stringify({
              ...base,
              type: "obligation_payment",
              amount: 80,
              source_account_id: a,
              occurrence_id: o.rows[0].id,
            }),
            randomUUID(),
          ]),
        );
        const count = await db.query<any>(
          "select count(*)::int as n from public.financial_transactions where occurrence_id=$1",
          [o.rows[1].id],
        );
        assert.equal(count.rows[0].n, 0);
      },
    );
    let goal: string;
    await t.test(
      "Ahorro confirmado, planificado cero, reasignación e integridad del fondo",
      async () => {
        goal = await create("goals", {
          name: "Viaje",
          minimum_amount: 0,
          ideal_amount: 1000,
          currency: "PEN",
          target_date: "2027-10-01",
          priority: 2,
        });
        await rpc("plan_savings", [goal, "2026-11-01", 0]);
        await assert.rejects(rpc("allocate_savings", [goal, 1, randomUUID()]));
        const reserve = await rpc("record_transaction", [
          JSON.stringify({
            ...base,
            type: "savings_reserve",
            amount: 200,
            source_account_id: a,
          }),
          randomUUID(),
        ]);
        await rpc("allocate_savings", [goal, 100, randomUUID()]);
        await assert.rejects(
          rpc("allocate_savings", [goal, 101, randomUUID()]),
        );
        await assert.rejects(rpc("void_transaction", [reserve]));
        await rpc("allocate_savings", [goal, -100, randomUUID()]);
        await rpc("void_transaction", [reserve]);
      },
    );
    await t.test(
      "Tarjetas: cuotas exactas, crédito y pagos sin doble gasto",
      async () => {
        const c = await create("cards", {
          name: "Visa",
          bank: "Banco",
          currency: "PEN",
          credit_limit: 1000,
          initial_debt: 0,
          closing_day: 20,
          due_day: 5,
          utilization_limit: 50,
        });
        const purchase = await rpc("record_purchase", [
          JSON.stringify({
            card_id: c,
            amount: 100,
            description: "Compra",
            purchased_at: "2026-11-21",
            installments: 3,
            kind: "purchase",
          }),
          randomUUID(),
        ]);
        const rows = await db.query<any>(
          "select sum(amount)::text as total from public.credit_card_installments where purchase_id=$1",
          [purchase],
        );
        assert.equal(Number(rows.rows[0].total), 100);
        await rpc("record_transaction", [
          JSON.stringify({
            ...base,
            type: "card_payment",
            amount: 25,
            card_id: c,
            source_account_id: a,
          }),
          randomUUID(),
        ]);
        await assert.rejects(
          rpc("record_transaction", [
            JSON.stringify({
              ...base,
              type: "card_payment",
              amount: 76,
              card_id: c,
              source_account_id: a,
            }),
            randomUUID(),
          ]),
        );
      },
    );
    await t.test("Préstamos conservan principal en cronograma", async () => {
      const d = await create("debts", {
        name: "Préstamo",
        creditor: "Banco",
        currency: "PEN",
        principal: 100,
        annual_interest: 12,
        installments: 3,
        first_due_date: "2026-11-30",
      });
      const rows = await db.query<any>(
        "select sum(principal)::text as total from public.debt_installments where debt_id=$1",
        [d],
      );
      assert.equal(Number(rows.rows[0].total), 100);
      const occurrences = await db.query<any>(
        "select po.* from public.payment_occurrences po join public.payment_obligations ob on ob.id=po.obligation_id where ob.debt_id=$1 order by due_date",
        [d],
      );
      assert.equal(occurrences.rows.length, 3);
      const tx = await rpc("record_transaction", [
        JSON.stringify({
          ...base,
          type: "loan_payment",
          amount: 50,
          debt_id: d,
          source_account_id: a,
        }),
        randomUUID(),
      ]);
      const payments = await db.query<any>(
        "select sum(amount)::text as paid,count(*)::int as n from public.obligation_payments where transaction_id=$1",
        [tx],
      );
      assert.equal(Number(payments.rows[0].paid), 50);
      assert.equal(payments.rows[0].n, 2);
      const interest = await db.query<any>(
        "select sum(interest_amount)::text as interest from public.obligation_payments where transaction_id=$1",
        [tx],
      );
      assert.equal(Number(interest.rows[0].interest), 1.67);
    });
    await t.test(
      "Edición auditada es atómica y rechaza importes inviables",
      async () => {
        const old = await rpc("record_transaction", [
          JSON.stringify({
            ...base,
            type: "expense",
            amount: 10,
            source_account_id: a,
          }),
          randomUUID(),
        ]);
        const k = randomUUID();
        const payload = JSON.stringify({
          ...base,
          type: "expense",
          amount: 15,
          source_account_id: a,
        });
        const replacement = await rpc("replace_transaction", [old, payload, k]);
        assert.equal(
          await rpc("replace_transaction", [old, payload, k]),
          replacement,
        );
        await assert.rejects(
          rpc("replace_transaction", [
            replacement,
            JSON.stringify({
              ...base,
              type: "expense",
              amount: 999999,
              source_account_id: a,
            }),
            randomUUID(),
          ]),
        );
        assert.equal(
          (
            await db.query<any>(
              "select voided_at from public.financial_transactions where id=$1",
              [replacement],
            )
          ).rows[0].voided_at,
          null,
        );
        await rpc("update_resource", [
          "accounts",
          a,
          JSON.stringify({ name: "Caja" }),
        ]);
        assert.equal(
          (
            await db.query<any>(
              "select name from public.financial_accounts where id=$1",
              [a],
            )
          ).rows[0].name,
          "Caja",
        );
        await assert.rejects(
          rpc("update_resource", [
            "accounts",
            a,
            JSON.stringify({ opening_balance: 99999 }),
          ]),
        );
      },
    );
    await t.test(
      "Estados de tarjeta y pagos mínimos conservan saldo pendiente",
      async () => {
        const c = await create("cards", {
          name: "Mastercard",
          bank: "Banco",
          currency: "PEN",
          credit_limit: 1000,
          initial_debt: 100,
          closing_day: 20,
          due_day: 5,
          utilization_limit: 50,
        });
        await rpc("record_statement", [
          JSON.stringify({
            card_id: c,
            period: "2026-11-01",
            closing_date: "2026-11-20",
            due_date: "2026-12-05",
            amount: 100,
            minimum_payment: 10,
          }),
        ]);
        await rpc("record_transaction", [
          JSON.stringify({
            ...base,
            type: "card_payment",
            amount: 10,
            card_id: c,
            source_account_id: a,
          }),
          randomUUID(),
        ]);
        const rows = await db.query<any>(
          "select sum(op.amount)::text as paid from public.obligation_payments op join public.payment_occurrences po on po.id=op.occurrence_id join public.payment_obligations ob on ob.id=po.obligation_id where ob.card_id=$1",
          [c],
        );
        assert.equal(Number(rows.rows[0].paid), 10);
      },
    );
    await t.test(
      "Distribución por porcentajes y reasignación son atómicas",
      async () => {
        const second = await create("goals", {
          name: "Reserva",
          minimum_amount: 0,
          ideal_amount: 100,
          currency: "PEN",
          target_date: "2027-10-01",
          priority: 2,
        });
        await rpc("record_transaction", [
          JSON.stringify({
            ...base,
            type: "savings_reserve",
            amount: 100,
            source_account_id: a,
          }),
          randomUUID(),
        ]);
        const p = JSON.stringify({
          amount: 100,
          currency: "PEN",
          distribution: [
            { goal_id: goal, percentage: 60 },
            { goal_id: second, percentage: 30 },
            { goal_id: null, percentage: 10 },
          ],
        });
        const k = randomUUID();
        const id = await rpc("distribute_savings", [p, k]);
        assert.equal(await rpc("distribute_savings", [p, k]), id);
        await rpc("reallocate_savings", [goal, second, 20, randomUUID()]);
        const rows = await db.query<any>(
          "select sum(amount)::text as amount from public.savings_allocations where user_id=$1 and goal_id=$2",
          [u, second],
        );
        assert.equal(Number(rows.rows[0].amount), 50);
        await assert.rejects(
          rpc("reallocate_savings", [goal, second, 9999, randomUUID()]),
        );
      },
    );
    await t.test(
      "Invitaciones ligadas al correo, rol y privacidad",
      async () => {
        const space = await create("spaces", { name: "Familia" });
        const inv = await rpc("invite_member", [space, "two@example.com"]);
        await assert.rejects(rpc("respond_invitation", [inv.token, true]));
        await login(v, "two@example.com");
        await rpc("respond_invitation", [inv.token, true]);
        assert.equal(
          (await db.query("select * from public.shared_spaces")).rows.length,
          1,
        );
        assert.equal(
          (await db.query("select * from public.financial_accounts")).rows
            .length,
          0,
        );
        await assert.rejects(
          rpc("invite_member", [space, "other@example.com"]),
        );
        await login(u);
        const g = await create("goals", {
          space_id: space,
          name: "Familia",
          minimum_amount: 0,
          ideal_amount: 100,
          currency: "PEN",
          target_date: "2027-01-01",
          priority: 2,
        });
        await assert.rejects(
          rpc("set_goal_members", [
            g,
            JSON.stringify([
              { user_id: u, percentage: 60 },
              { user_id: v, percentage: 30 },
            ]),
          ]),
        );
        await rpc("set_goal_members", [
          g,
          JSON.stringify([
            { user_id: u, percentage: 60 },
            { user_id: v, percentage: 40 },
          ]),
        ]);
      },
    );
    await t.test(
      "IA requiere confirmación y reserva cuotas globales atómicamente",
      async () => {
        const draft = await rpc("save_ai_draft", [
          JSON.stringify({
            ...base,
            type: "expense",
            amount: 1,
            source_account_id: a,
          }),
        ]);
        await assert.rejects(
          rpc("confirm_ai_draft", [draft, randomUUID(), false]),
        );
        const id = await rpc("confirm_ai_draft", [draft, randomUUID(), true]);
        assert.equal(
          await rpc("confirm_ai_draft", [draft, randomUUID(), true]),
          id,
        );
        await assert.rejects(
          rpc("save_ai_draft", [
            JSON.stringify({
              ...base,
              type: "transfer",
              amount: 1,
              source_account_id: a,
              destination_account_id: b,
            }),
          ]),
        );
        await assert.rejects(rpc("reserve_ai", [u, randomUUID(), 0.1, 5, 1]));
        await db.exec("reset role; set role service_role");
        await rpc("reserve_ai", [u, randomUUID(), 0.1, 5, 1]);
        await assert.rejects(rpc("reserve_ai", [u, randomUUID(), 0.1, 5, 1]));
      },
    );
  } finally {
    await db.close();
  }
});

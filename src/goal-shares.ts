import { Decimal } from "decimal.js";
import type { Row } from "./finance.js";

// Largest remainders keep responsibility quotas equal to the goal's exact cent total.
export function responsibilityTargets(
  amount: number | string,
  members: Row[],
): Row[] {
  if (
    !members.length ||
    !members.reduce((s, m) => s.plus(m.percentage), new Decimal(0)).eq(100)
  )
    return [];
  const target = new Decimal(amount).times(100).toDecimalPlaces(0);
  const quotas = members
    .map<Row & { units: number; remainder: number }>((m) => {
      const exact = target.times(m.percentage).div(100);
      return {
        ...m,
        units: exact.floor().toNumber(),
        remainder: exact.minus(exact.floor()).toNumber(),
      };
    })
    .sort(
      (a, b) =>
        b.remainder - a.remainder ||
        String(a.user_id).localeCompare(String(b.user_id)),
    );
  const residual = target
    .minus(quotas.reduce((s, q) => s.plus(q.units), new Decimal(0)))
    .toNumber();
  quotas.forEach((q, i) => {
    if (i < residual) q.units++;
  });
  return quotas.map(({ units, remainder: _, ...m }) => ({
    ...m,
    target_amount: units / 100,
  }));
}

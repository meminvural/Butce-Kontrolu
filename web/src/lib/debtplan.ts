// Ödeme önerisi: bütçeyi önce asgari ödemelere, kalanı seçilen stratejiye göre dağıtır. Saf mantık.
export type Strategy = 'rate' | 'small' | 'due';

export interface PlanCard {
  account_id: string; name: string; remaining: number; min_remaining: number; days_to_due: number;
  purchase_rate: number; late_rate: number;
}

export const STRATEGY_LABEL: Record<Strategy, string> = {
  rate: 'Önce en yüksek faizli kart (en az faiz ödenir)',
  small: 'Önce en küçük borç (borç sayısı hızla azalır)',
  due: 'Önce vadesi en yakın kart',
};

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Ödemeden sonra kalan borcun tahmini aylık faizi: ödenmeyen asgari kısma gecikme, geri kalana akdi faiz */
export function interestAfter(c: PlanCard, paid: number): number {
  const minLeft = Math.max(c.min_remaining - paid, 0);
  const rest = Math.max(c.remaining - paid - minLeft, 0);
  return r2((minLeft * c.late_rate + rest * c.purchase_rate) / 100);
}

export interface Allocation {
  pay: Map<string, number>;
  leftover: number;          // dağıtılamayan (tüm borçlar kapandıysa)
  minShortfall: number;      // bütçe asgarilere yetmediyse eksik tutar
  interestNow: number;       // hiç ödeme yapılmazsa tahmini faiz
  interestAfter: number;     // bu planla tahmini faiz
}

export function allocate(cards: PlanCard[], budget: number, strategy: Strategy): Allocation {
  const open = cards.filter((c) => c.remaining > 0);
  const pay = new Map<string, number>();
  let left = Math.max(budget, 0);
  // 1) asgariler: vadesi yakın olan önce
  for (const c of [...open].sort((a, b) => a.days_to_due - b.days_to_due)) {
    const p = r2(Math.min(c.min_remaining, left));
    pay.set(c.account_id, p);
    left = r2(left - p);
  }
  const minShortfall = r2(open.reduce((a, c) => a + c.min_remaining, 0) - open.reduce((a, c) => a + (pay.get(c.account_id) ?? 0), 0));
  // 2) kalan bütçe stratejiye göre
  const order = [...open].sort((a, b) =>
    strategy === 'rate' ? b.purchase_rate - a.purchase_rate || b.remaining - a.remaining
    : strategy === 'small' ? a.remaining - b.remaining
    : a.days_to_due - b.days_to_due);
  for (const c of order) {
    const room = r2(c.remaining - (pay.get(c.account_id) ?? 0));
    const p = r2(Math.min(room, left));
    if (p > 0) { pay.set(c.account_id, r2((pay.get(c.account_id) ?? 0) + p)); left = r2(left - p); }
  }
  return {
    pay, leftover: left, minShortfall,
    interestNow: r2(open.reduce((a, c) => a + interestAfter(c, 0), 0)),
    interestAfter: r2(open.reduce((a, c) => a + interestAfter(c, pay.get(c.account_id) ?? 0), 0)),
  };
}

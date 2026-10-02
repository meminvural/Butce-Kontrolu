import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  rpc, table, useAccounts, useAutopayPending, useCardAutomation, useDebtPlan, useLedgerMutation, useProfile, useRateTiers,
  type AutopayRow, type CardAutomation, type DebtPlanRow,
} from '../lib/api';
import { supabase } from '../lib/supabase';
import { fmtDate, money, parseAmount, todayISO } from '../lib/format';
import { STRATEGY_LABEL, allocate, type PlanCard, type Strategy } from '../lib/debtplan';
import type { AccountBalance } from '../lib/types';
import { Empty, ErrorText, Field, Money } from '../components/ui';

const WHAT: Record<string, string> = { min: 'Asgari', full: 'Ekstre tamamı', fixed: 'Sabit tutar' };
const STATUS: Record<string, { label: string; cls: string }> = {
  paid: { label: 'Ödendi', cls: 'tag-risk-normal' }, partial: { label: 'Kısmi ödendi', cls: 'tag-risk-warn' },
  awaiting: { label: 'Ödeme bekliyor', cls: 'tag-risk-warn' }, overdue: { label: 'Vadesi geçti', cls: 'tag-risk-crit' },
};
const fmt = (n: number | null) => (n === null ? '' : String(n).replace('.', ','));

function dueTag(d: DebtPlanRow) {
  if (d.days_to_due === null || d.status === 'paid') return null;
  return d.days_to_due < 0 ? `${-d.days_to_due} gün gecikti` : d.days_to_due === 0 ? 'bugün' : `${d.days_to_due} gün kaldı`;
}

// ---------------------------------------------------------------------------
//  Bekleyen otomatik ödemeler
// ---------------------------------------------------------------------------
function PendingRow({ p }: { p: AutopayRow }) {
  const [date, setDate] = useState(p.pay_date < todayISO() ? p.pay_date : todayISO());
  const apply = useLedgerMutation(() => rpc('apply_autopay', { p_account_id: p.account_id, p_date: date }));
  return (
    <tr>
      <th scope="row">{p.name}</th>
      <td>{WHAT[p.what]}</td>
      <td className="num"><Money value={p.amount} currency="TRY" /></td>
      <td>{p.source_name}<span className="muted small"> · bakiye {money(p.source_balance, 'TRY')}</span>{p.source_balance < p.amount && <span className="tag tag-risk-warn">bakiye yetersiz</span>}</td>
      <td>{fmtDate(p.pay_date)}{p.due_now ? <span className="tag tag-risk-warn">zamanı geldi</span> : <span className="muted small"> · vade {fmtDate(p.due_date)}</span>}</td>
      <td className="row-actions">
        <input type="date" aria-label="Ödeme tarihi" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} />
        <button className="btn btn-primary" disabled={apply.isPending} onClick={() => apply.mutate(undefined)}>Ödendi olarak kaydet</button>
        <ErrorText error={apply.error} />
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
//  Kart ayarları: asgari ödeme + otomatik ödeme
// ---------------------------------------------------------------------------
function CardSettings({ card, auto, banks }: { card: AccountBalance; auto: CardAutomation; banks: AccountBalance[] }) {
  const sources = banks.filter((b) => b.currency === card.currency);
  const [minAuto, setMinAuto] = useState(auto.min_payment_auto);
  const [pct, setPct] = useState(String(auto.min_payment_pct));
  const [mode, setMode] = useState(auto.autopay_mode);
  const [src, setSrc] = useState(auto.autopay_account_id ?? '');
  const [fixed, setFixed] = useState(fmt(auto.autopay_fixed));
  const [days, setDays] = useState(String(auto.autopay_days_before));
  const [rec, setRec] = useState(auto.autopay_record);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setMinAuto(auto.min_payment_auto); setPct(String(auto.min_payment_pct)); setMode(auto.autopay_mode);
    setSrc(auto.autopay_account_id ?? ''); setFixed(fmt(auto.autopay_fixed)); setDays(String(auto.autopay_days_before)); setRec(auto.autopay_record);
  }, [auto]);

  const save = useLedgerMutation(() => rpc('set_card_automation', {
    p_account_id: card.id,
    p: {
      min_payment_auto: minAuto, min_payment_pct: minAuto ? null : parseAmount(pct),
      autopay_mode: mode, autopay_account_id: mode === 'off' ? null : src || null,
      autopay_fixed: mode === 'fixed' ? parseAmount(fixed) : null, autopay_days_before: days, autopay_record: rec,
    },
  }));

  return (
    <form className="card-auto" onSubmit={(e) => { e.preventDefault(); setSaved(false); save.mutate(undefined, { onSuccess: () => setSaved(true) }); }}>
      <h3>{card.name}{card.iban_last4 && <span className="muted small"> ···{card.iban_last4}</span>}</h3>
      <div className="head-grid">
        <div className="stmt-field">
          <span>Asgari ödeme oranı</span>
          <label className="check small"><input type="checkbox" checked={minAuto} onChange={(e) => setMinAuto(e.target.checked)} /> Limite göre otomatik hesapla</label>
          <input inputMode="decimal" aria-label="Asgari ödeme oranı (%)" disabled={minAuto} value={minAuto ? String(auto.min_payment_pct) : pct} onChange={(e) => setPct(e.target.value)} />
          <span className="muted small">{minAuto ? `Şu an %${auto.min_payment_pct} (limit ${money(card.credit_limit, card.currency)})` : 'Yüzde olarak. Ekstreden gelen asgari tutar her zaman önceliklidir.'}</span>
        </div>
        <label className="stmt-field">Otomatik ödeme
          <select value={mode} onChange={(e) => setMode(e.target.value as CardAutomation['autopay_mode'])}>
            <option value="off">Kapalı</option><option value="min">Asgari tutar</option><option value="full">Ekstre tamamı</option><option value="fixed">Sabit tutar</option>
          </select>
        </label>
        {mode !== 'off' && (
          <>
            <label className="stmt-field">Ödeme hangi hesaptan?
              <select value={src} onChange={(e) => setSrc(e.target.value)} required>
                <option value="">Seçin…</option>{sources.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </label>
            {mode === 'fixed' && <label className="stmt-field">Sabit tutar<input inputMode="decimal" required value={fixed} onChange={(e) => setFixed(e.target.value)} /></label>}
            <label className="stmt-field">Son ödemeden kaç gün önce?
              <input type="number" min={0} max={30} value={days} onChange={(e) => setDays(e.target.value)} />
            </label>
            <label className="stmt-field">Nasıl kaydedilsin?
              <select value={rec} onChange={(e) => setRec(e.target.value as 'confirm' | 'auto')}>
                <option value="confirm">Önce bana sor (onayımla kaydet)</option>
                <option value="auto">Vadesi gelince kendiliğinden kaydet</option>
              </select>
            </label>
          </>
        )}
      </div>
      {mode !== 'off' && <p className="muted small">{rec === 'auto'
        ? 'Bankanız ödemeyi yaptığında defter de aynı gün güncellenir. Siz siteyi açmasanız bile kayıt, sunucuda zamanlanmış görev kuruluysa gün içinde, kurulu değilse siteyi bir sonraki açışınızda işlenir (geçmiş tarihli).'
        : 'Ödeme zamanı gelince “Bekleyen otomatik ödemeler” listesinde görünür; ödemeyi bankanızdan yaptıktan sonra tek tıkla kaydedersiniz.'}</p>}
      <div className="stmt-actions">
        <span className="muted small">{saved ? '✓ Kaydedildi' : ''}</span>
        <button className="btn btn-primary" disabled={save.isPending}>Ayarları kaydet</button>
      </div>
      <ErrorText error={save.error} />
    </form>
  );
}

// ---------------------------------------------------------------------------
//  Faiz kademeleri ve asgari ödeme kuralı
// ---------------------------------------------------------------------------
function Rules() {
  const profile = useProfile().data;
  const tiers = useRateTiers().data ?? [];
  const [lim, setLim] = useState(''); const [low, setLow] = useState(''); const [high, setHigh] = useState('');
  useEffect(() => { if (profile) { setLim(String(profile.min_rule_limit ?? 50000)); setLow(String(profile.min_rule_low ?? 20)); setHigh(String(profile.min_rule_high ?? 40)); } }, [profile]);
  const saveRule = useLedgerMutation(async () => {
    await table(supabase.from('profiles').update({ min_rule_limit: parseAmount(lim), min_rule_low: parseAmount(low), min_rule_high: parseAmount(high) }).eq('id', profile!.id));
    await rpc('apply_min_payment_rule', {});
  });
  const [nt, setNt] = useState({ upto: '', buy: '', late: '' });
  const addTier = useLedgerMutation(() => table(supabase.from('card_rate_tiers').insert({ upto: parseAmount(nt.upto), purchase_rate: parseAmount(nt.buy), late_rate: parseAmount(nt.late) })).then(() => setNt({ upto: '', buy: '', late: '' })));
  const delTier = useLedgerMutation((id: string) => table(supabase.from('card_rate_tiers').delete().eq('id', id)));
  const defaults = useLedgerMutation(() => table(supabase.from('card_rate_tiers').insert([
    { upto: 30000, purchase_rate: 3.25, late_rate: 3.55 }, { upto: 180000, purchase_rate: 3.75, late_rate: 4.05 }, { upto: 999999999999, purchase_rate: 4.25, late_rate: 4.55 }])));

  return (
    <section className="panel">
      <h2>Faiz kademeleri ve asgari ödeme kuralı</h2>
      <p className="muted small">Tahmini faiz hesapları bu oranları kullanır. Oranlar zamanla değişir; bankanızın ekstresinde yazanı girin. Hesaplar tahmindir, bankanın ekstresi esastır.</p>

      <h3>Aylık faiz oranları (ekstre borcuna göre)</h3>
      {tiers.length === 0 ? (
        <p className="muted small">Kademe girilmedi; varsayılanlar kullanılıyor (30.000 TL’ye kadar %3,25 · 180.000 TL’ye kadar %3,75 · üzeri %4,25; gecikme +%0,30). <button type="button" className="link-btn" onClick={() => defaults.mutate(undefined)}>Düzenlemek için varsayılanları yükle</button></p>
      ) : (
        <table className="sum-table">
          <thead><tr><th>Ekstre borcu üst sınırı</th><th className="num">Akdi faiz %</th><th className="num">Gecikme faizi %</th><th /></tr></thead>
          <tbody>
            {tiers.map((t) => (
              <tr key={t.id}><td>{t.upto >= 1e11 ? 'Sınırsız' : money(t.upto, 'TRY')}</td><td className="num">%{t.purchase_rate}</td><td className="num">%{t.late_rate}</td>
                <td><button type="button" className="btn btn-quiet" onClick={() => delTier.mutate(t.id)}>Sil</button></td></tr>
            ))}
          </tbody>
        </table>
      )}
      <form className="inline-form" onSubmit={(e) => { e.preventDefault(); addTier.mutate(undefined); }}>
        <input aria-label="Üst sınır" placeholder="Üst sınır (TL)" inputMode="decimal" required value={nt.upto} onChange={(e) => setNt({ ...nt, upto: e.target.value })} />
        <input aria-label="Akdi faiz" placeholder="Akdi %" inputMode="decimal" required value={nt.buy} onChange={(e) => setNt({ ...nt, buy: e.target.value })} />
        <input aria-label="Gecikme faizi" placeholder="Gecikme %" inputMode="decimal" required value={nt.late} onChange={(e) => setNt({ ...nt, late: e.target.value })} />
        <button className="btn">Kademe ekle</button>
      </form>
      <ErrorText error={addTier.error ?? delTier.error ?? defaults.error} />

      <h3>Otomatik asgari ödeme kuralı</h3>
      <p className="muted small">“Limite göre otomatik” seçili kartlarda oran, kart limitine göre bu kuraldan belirlenir ve limit değişince kendiliğinden güncellenir. Varsayılan değerler yaygın uygulamadır; bankanızın uyguladığı farklıysa değiştirin.</p>
      <form className="head-grid" onSubmit={(e) => { e.preventDefault(); saveRule.mutate(undefined); }}>
        <Field label="Limit eşiği (TL)"><input inputMode="decimal" value={lim} onChange={(e) => setLim(e.target.value)} /></Field>
        <Field label="Eşik ve altı için oran (%)"><input inputMode="decimal" value={low} onChange={(e) => setLow(e.target.value)} /></Field>
        <Field label="Eşiğin üstü için oran (%)"><input inputMode="decimal" value={high} onChange={(e) => setHigh(e.target.value)} /></Field>
        <div className="stmt-field"><span>&nbsp;</span><button className="btn" disabled={saveRule.isPending}>Kuralı kaydet ve uygula</button></div>
      </form>
      <ErrorText error={saveRule.error} />
    </section>
  );
}

// ---------------------------------------------------------------------------
export default function DebtPlan() {
  const plan = useDebtPlan();
  const pending = useAutopayPending();
  const autos = useCardAutomation().data ?? [];
  const accounts = (useAccounts().data ?? []).filter((a) => !a.archived_at);
  const cards = accounts.filter((a) => a.kind === 'credit_card');
  const banks = accounts.filter((a) => ['bank', 'cash', 'savings'].includes(a.kind));
  const rows = plan.data ?? [];

  // Ödeme önerisi
  const cash = banks.filter((b) => b.currency === 'TRY').reduce((a, b) => a + Math.max(b.balance, 0), 0);
  const [budget, setBudget] = useState('');
  const [strategy, setStrategy] = useState<Strategy>('rate');
  const [source, setSource] = useState('');
  const budgetN = budget.trim() === '' ? cash : parseAmount(budget) ?? 0;
  const open: PlanCard[] = useMemo(() => rows.filter((r) => (r.remaining ?? 0) > 0 && r.currency === 'TRY').map((r) => ({
    account_id: r.account_id, name: r.name, remaining: r.remaining!, min_remaining: r.min_remaining ?? 0, days_to_due: r.days_to_due ?? 0,
    purchase_rate: r.purchase_rate ?? 0, late_rate: r.late_rate ?? 0 })), [rows]);
  const alloc = useMemo(() => allocate(open, budgetN, strategy), [open, budgetN, strategy]);
  const [applyMsg, setApplyMsg] = useState<string | null>(null);
  const applyPlan = useLedgerMutation(async () => {
    setApplyMsg(null); let ok = 0; const errs: string[] = [];
    for (const c of open) {
      const amt = alloc.pay.get(c.account_id) ?? 0;
      if (amt <= 0) continue;
      try { await rpc('record_transfer', { p_from_account_id: source, p_to_account_id: c.account_id, p_amount: amt, p_description: 'Ödeme planı' }); ok++; }
      catch (e) { errs.push(`${c.name}: ${e instanceof Error ? e.message : e}`); }
    }
    setApplyMsg(`${ok} ödeme kaydedildi${errs.length ? `; hatalar: ${errs.join(' · ')}` : '.'}`);
  });

  const totalDebt = rows.reduce((a, r) => a + r.debt, 0);
  const totalRem = rows.reduce((a, r) => a + (r.remaining ?? 0), 0);
  const totalMin = rows.reduce((a, r) => a + (r.min_remaining ?? 0), 0);
  const due7 = rows.filter((r) => (r.remaining ?? 0) > 0 && r.days_to_due !== null && r.days_to_due <= 7).reduce((a, r) => a + (r.remaining ?? 0), 0);

  return (
    <div className="page debt-plan">
      <header className="page-head"><h1>Borç planı ve otomatik ödeme</h1></header>
      <p className="muted">Her kartın ekstre borcu, asgari ödemesi, kalanı ve vadesi defterden otomatik hesaplanır; faiz maliyeti tahmin edilir. Ödeme ve asgari ödeme otomasyonlarını aşağıdan kart başına ayarlayabilirsiniz. Bankanın ekstresi esastır: <Link to="/ekstre">ekstre yükleyince</Link> rakamlar bankanınkine eşitlenir.</p>

      {plan.isLoading ? <p aria-busy="true">Hesaplanıyor…</p> : rows.length === 0 ? (
        <Empty title="Kredi kartı yok"><p className="muted">Kart eklediğinizde borç planı burada görünür.</p></Empty>
      ) : (
        <>
          <section className="kpis">
            <div className="kpi"><span className="muted small">Toplam kart borcu</span><Money value={totalDebt} currency="TRY" tone="out" /></div>
            <div className="kpi"><span className="muted small">Ödenmemiş ekstre borcu</span><Money value={totalRem} currency="TRY" /></div>
            <div className="kpi"><span className="muted small">Kalan asgari ödemeler</span><Money value={totalMin} currency="TRY" /></div>
            <div className="kpi"><span className="muted small">7 gün içinde vadesi gelen</span><Money value={due7} currency="TRY" tone={due7 > 0 ? 'out' : 'muted'} /></div>
          </section>

          <section className="panel">
            <h2>Otomatik borç hesabı</h2>
            <div className="table-wrap">
              <table className="sum-table">
                <thead><tr><th>Kart</th><th>Son ekstre</th><th>Son ödeme</th><th className="num">Ekstre borcu</th><th className="num">Asgari</th><th className="num">Ödenen</th><th className="num">Kalan</th><th className="num">Faiz %</th><th className="num" title="Sadece asgariyi öderseniz kalan tutarın tahmini aylık faizi">Faiz (asgari)</th><th className="num" title="Hiç ödemezseniz gecikme + akdi faiz">Faiz (ödemezsem)</th><th className="num">Güncel borç</th></tr></thead>
                <tbody>
                  {rows.map((r) => {
                    const st = r.status ? STATUS[r.status] : null;
                    return (
                      <tr key={r.account_id}>
                        <th scope="row">{r.name}{r.last4 && <span className="muted small"> ···{r.last4}</span>}</th>
                        <td>{r.cut_date ? fmtDate(r.cut_date) : <span className="muted">—</span>}</td>
                        <td>{r.due_date ? <>{fmtDate(r.due_date)} {st && <span className={`tag ${st.cls}`}>{st.label}</span>}<div className="muted small">{dueTag(r)}</div></> : '—'}</td>
                        <td className="num">{r.statement_amount === null ? '—' : money(r.statement_amount, r.currency)}</td>
                        <td className="num">{r.min_payment === null ? '—' : money(r.min_payment, r.currency)}</td>
                        <td className="num">{r.paid === null ? '—' : money(r.paid, r.currency)}</td>
                        <td className="num"><strong>{r.remaining === null ? '—' : money(r.remaining, r.currency)}</strong></td>
                        <td className="num">{r.purchase_rate === null ? '—' : `%${r.purchase_rate}`}</td>
                        <td className="num">{r.est_interest_min === null ? '—' : money(r.est_interest_min, r.currency)}</td>
                        <td className="num tone-out">{r.est_interest_none === null ? '—' : money(r.est_interest_none, r.currency)}</td>
                        <td className="num">{money(r.debt, r.currency)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="muted small">Faiz tahminleri aylıktır: asgariyi ödeyen kalana akdi faiz, ödemeyen asgari kısma gecikme faizi uygulanır. “Güncel borç” açık dönem harcamalarını ve gelecek taksitleri de içerir.</p>
          </section>

          {(pending.data ?? []).length > 0 && (
            <section className="panel">
              <h2>Bekleyen otomatik ödemeler</h2>
              <div className="table-wrap">
                <table className="sum-table">
                  <thead><tr><th>Kart</th><th>Tür</th><th className="num">Tutar</th><th>Kaynak</th><th>Ödeme günü</th><th /></tr></thead>
                  <tbody>{(pending.data ?? []).map((p) => <PendingRow key={p.account_id} p={p} />)}</tbody>
                </table>
              </div>
              <p className="muted small">“Otomatik kaydet” seçili kartlar, zamanı gelince kendiliğinden kaydedilir; buradakiler sizin onayınızı bekleyenlerdir. Ödemeyi bankanızdan yaptıysanız kaydedin.</p>
            </section>
          )}

          <section className="panel">
            <h2>Ödeme önerisi</h2>
            <p className="muted small">Elinizdeki tutarı önce tüm asgari ödemelere (vadesi yakın olan önce), kalanı seçtiğiniz stratejiye göre dağıtır.</p>
            <div className="head-grid">
              <label className="stmt-field">Ödeyebileceğim tutar (TL)
                <input inputMode="decimal" placeholder={`Banka/nakit toplamı: ${fmt(cash)}`} value={budget} onChange={(e) => setBudget(e.target.value)} /></label>
              <label className="stmt-field">Strateji
                <select value={strategy} onChange={(e) => setStrategy(e.target.value as Strategy)}>
                  {(Object.keys(STRATEGY_LABEL) as Strategy[]).map((s) => <option key={s} value={s}>{STRATEGY_LABEL[s]}</option>)}
                </select></label>
            </div>
            {open.length === 0 ? <p className="muted">Ödenmemiş ekstre borcu yok.</p> : (
              <>
                <table className="sum-table">
                  <thead><tr><th>Kart</th><th className="num">Kalan</th><th className="num">Asgari</th><th className="num">Önerilen ödeme</th><th className="num">Kalacak</th></tr></thead>
                  <tbody>
                    {open.map((c) => {
                      const p = alloc.pay.get(c.account_id) ?? 0;
                      return <tr key={c.account_id}><th scope="row">{c.name}</th><td className="num">{money(c.remaining, 'TRY')}</td><td className="num">{money(c.min_remaining, 'TRY')}</td>
                        <td className="num"><strong>{money(p, 'TRY')}</strong>{p < c.min_remaining && <span className="tag tag-risk-crit">asgariye yetmiyor</span>}</td><td className="num">{money(c.remaining - p, 'TRY')}</td></tr>;
                    })}
                  </tbody>
                </table>
                <div className="import-summary">
                  <span>Tahmini aylık faiz: <strong>{money(alloc.interestAfter, 'TRY')}</strong></span>
                  <span className="muted">Hiç ödemezseniz {money(alloc.interestNow, 'TRY')} · fark <strong className="tone-in">{money(alloc.interestNow - alloc.interestAfter, 'TRY')}</strong></span>
                  {alloc.minShortfall > 0 && <span className="tone-out">Asgari ödemeler için {money(alloc.minShortfall, 'TRY')} eksik</span>}
                  {alloc.leftover > 0 && <span className="muted">{money(alloc.leftover, 'TRY')} artan tutar</span>}
                </div>
                <div className="stmt-actions">
                  <label className="stmt-field">Ödemeleri kaydetmek için kaynak hesap
                    <select value={source} onChange={(e) => setSource(e.target.value)}>
                      <option value="">Seçin…</option>{banks.filter((b) => b.currency === 'TRY').map((b) => <option key={b.id} value={b.id}>{b.name} · {money(b.balance, 'TRY')}</option>)}
                    </select></label>
                  <button className="btn btn-primary" disabled={!source || applyPlan.isPending || [...alloc.pay.values()].every((v) => v <= 0)}
                    onClick={() => { if (window.confirm('Önerilen ödemeler seçili hesaptan kartlara kaydedilecek. Bankanızdan ödemeyi yaptıysanız onaylayın.')) applyPlan.mutate(undefined); }}>Önerilen ödemeleri kaydet</button>
                </div>
                {applyMsg && <p className="small">{applyMsg}</p>}
                <ErrorText error={applyPlan.error} />
              </>
            )}
          </section>

          <section className="panel">
            <h2>Kart ayarları: asgari ödeme ve otomatik ödeme</h2>
            {cards.map((c) => {
              const a = autos.find((x) => x.account_id === c.id);
              return a ? <CardSettings key={c.id} card={c} auto={a} banks={banks} /> : null;
            })}
          </section>
        </>
      )}
      <Rules />
    </div>
  );
}

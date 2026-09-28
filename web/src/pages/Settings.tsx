import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { table, useExchangeRates, useLedgerMutation, useProfile } from '../lib/api';
import { fmtDate, parseAmount, todayISO } from '../lib/format';
import { CURRENCIES, type Currency } from '../lib/types';
import { ErrorText, Field } from '../components/ui';

const ZONES = ['Europe/Istanbul', 'Africa/Dar_es_Salaam', 'Europe/London', 'Europe/Berlin', 'Asia/Dubai', 'UTC'];

export default function Settings() {
  const profile = useProfile().data;
  const rates = useExchangeRates().data ?? [];
  const [form, setForm] = useState({ full_name: '', base_currency: 'TRY' as Currency, timezone: 'Europe/Istanbul', warn: '70', crit: '90' });
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (profile) setForm({ full_name: profile.full_name ?? '', base_currency: profile.base_currency, timezone: profile.timezone,
      warn: String(profile.budget_warn_pct), crit: String(profile.budget_crit_pct) });
  }, [profile]);

  const save = useLedgerMutation(() => table(supabase.from('profiles').update({
    full_name: form.full_name || null, base_currency: form.base_currency, timezone: form.timezone,
    budget_warn_pct: Number(form.warn), budget_crit_pct: Number(form.crit),
  }).eq('id', profile!.id)));

  const [rate, setRate] = useState({ date: todayISO(), base: 'USD' as Currency, quote: 'TRY' as Currency, value: '' });
  const addRate = useLedgerMutation(async () => {
    const v = parseAmount(rate.value);
    if (!v || v <= 0) throw new Error('Geçerli bir kur girin');
    if (rate.base === rate.quote) throw new Error('İki farklı para birimi seçin');
    await table(supabase.from('exchange_rates').upsert(
      { rate_date: rate.date, base: rate.base, quote: rate.quote, rate: v, source: 'manual' },
      { onConflict: 'user_id,rate_date,base,quote' }));
  });
  const delRate = useLedgerMutation((id: string) => table(supabase.from('exchange_rates').delete().eq('id', id)));

  const [pw, setPw] = useState('');
  const [pwMsg, setPwMsg] = useState<string | null>(null);
  const changePw = async (e: FormEvent) => {
    e.preventDefault();
    const { error } = await supabase.auth.updateUser({ password: pw });
    setPwMsg(error ? error.message : 'Parola güncellendi.'); setPw('');
  };

  return (
    <div className="page">
      <header className="page-head"><h1>Ayarlar</h1></header>

      <section className="panel">
        <h2>Profil ve tercihler</h2>
        <form className="form" onSubmit={(e) => { e.preventDefault(); setSaved(false); save.mutate(undefined, { onSuccess: () => setSaved(true) }); }}>
          <div className="row-2">
            <Field label="Ad soyad"><input value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} /></Field>
            <Field label="Baz para birimi" hint="Özet ekranındaki toplam net varlık bu birimde gösterilir.">
              <select value={form.base_currency} onChange={(e) => setForm({ ...form, base_currency: e.target.value as Currency })}>
                {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
              </select>
            </Field>
          </div>
          <div className="row-2">
            <Field label="Saat dilimi" hint="“Bugün” ve vade hesapları bu saate göre yapılır.">
              <select value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
                {ZONES.map((z) => <option key={z}>{z}</option>)}
              </select>
            </Field>
            <div className="row-2">
              <Field label="Bütçe dikkat %"><input type="number" min={1} max={99} value={form.warn} onChange={(e) => setForm({ ...form, warn: e.target.value })} /></Field>
              <Field label="Bütçe kritik %"><input type="number" min={2} max={100} value={form.crit} onChange={(e) => setForm({ ...form, crit: e.target.value })} /></Field>
            </div>
          </div>
          <ErrorText error={save.error} />
          {saved && <p className="ok small">Kaydedildi.</p>}
          <div className="actions"><button className="btn btn-primary" disabled={!profile || save.isPending}>Kaydet</button></div>
        </form>
      </section>

      <section className="panel">
        <h2>Döviz kurları</h2>
        <p className="muted small">Kurları elle girersiniz; geçmiş raporlar o günkü kurla sabit kalır. Doğrudan kur yoksa ters kur, o da yoksa USD üzerinden çapraz kur kullanılır.</p>
        <form className="rate-form" onSubmit={(e) => { e.preventDefault(); addRate.mutate(undefined, { onSuccess: () => setRate({ ...rate, value: '' }) }); }}>
          <input type="date" value={rate.date} max={todayISO()} onChange={(e) => setRate({ ...rate, date: e.target.value })} aria-label="Tarih" />
          <span>1</span>
          <select value={rate.base} onChange={(e) => setRate({ ...rate, base: e.target.value as Currency })} aria-label="Birim">{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select>
          <span>=</span>
          <input inputMode="decimal" required placeholder="34,20" value={rate.value} onChange={(e) => setRate({ ...rate, value: e.target.value })} aria-label="Kur" />
          <select value={rate.quote} onChange={(e) => setRate({ ...rate, quote: e.target.value as Currency })} aria-label="Karşı birim">{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select>
          <button className="btn btn-primary" disabled={addRate.isPending}>Kuru kaydet</button>
        </form>
        <ErrorText error={addRate.error ?? delRate.error} />
        {rates.length > 0 && (
          <ul className="acc-list">
            {rates.map((r) => (
              <li key={r.id}>
                <span>{fmtDate(r.rate_date)} · 1 {r.base} = {Number(r.rate).toLocaleString('tr-TR', { maximumFractionDigits: 6 })} {r.quote}</span>
                <button className="link-btn small muted" onClick={() => delRate.mutate(r.id)}>Sil</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2>Güvenlik</h2>
        <form className="inline-input" onSubmit={changePw}>
          <input type="password" minLength={8} required placeholder="Yeni parola (en az 8 karakter)" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" />
          <button className="btn">Parolayı değiştir</button>
        </form>
        {pwMsg && <p className="small">{pwMsg}</p>}
        <p className="field-hint">Verileriniz satır düzeyinde güvenlikle yalnızca size açıktır. Yedek için Raporlar sayfasından tüm işlemleri CSV olarak indirebilirsiniz.</p>
      </section>
    </div>
  );
}

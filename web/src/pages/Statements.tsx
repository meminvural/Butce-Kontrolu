import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  importStatement, useAccounts, useCardLedger, useCategories, useLedgerMutation, useStatementReconcile, useStatementStatus,
  type ImportResult, type StatementStatusRow,
} from '../lib/api';
import { fmtDate, money } from '../lib/format';
import { BANK_LABEL, StatementError, type ParsedStatement, type StatementLine } from '../lib/statements/types';
import { matchStatement, suggestCategoryName, type LineMatch, type MatchStatus } from '../lib/statements/match';
import { buildPayload, defaultDecision, type LineDecision } from '../lib/statements/import';
import { readStatementFile } from '../lib/statements/pdf';
import { addDaysIso } from '../lib/statements/text';
import type { AccountBalance, Category } from '../lib/types';
import { Lbl } from '../components/Info';
import { Empty, ErrorText, Money } from '../components/ui';

type Phase = 'reading' | 'password' | 'ready' | 'error' | 'done';
interface Item { id: string; file: File; phase: Phase; error?: string; hash?: string; statement?: ParsedStatement; passwordTried?: boolean }

const pct = (n: number | null) => (n === null ? '—' : `%${n.toLocaleString('tr-TR', { maximumFractionDigits: 1 })}`);
const KIND_LABEL: Record<StatementLine['kind'], string> = {
  purchase: 'Harcama', installment: 'Taksit', cash_advance: 'Nakit avans', payment: 'Ödeme', refund: 'İade', interest: 'Faiz', tax: 'Vergi (KKDF/BSMV)', fee: 'Ücret',
};
const STATUS_LABEL: Record<MatchStatus, string> = { matched: 'Sistemde var', maybe: 'Olası eşleşme', new: 'Yeni' };

// ---------------------------------------------------------------------------
//  Kart ekstre durumu tablosu
// ---------------------------------------------------------------------------
function StatusTable({ rows }: { rows: StatementStatusRow[] }) {
  return (
    <section className="panel">
      <h2><Lbl k="statement_fresh">Kart ekstre durumu</Lbl></h2>
      <p className="chart-note small muted">Her kart için yüklenen son ekstre. “Fark”, defterin o kesimde hesapladığı borç ile bankanın ekstre borcu arasındaki farktır.</p>
      {rows.length === 0 ? <p className="muted empty-inline">Kredi kartı yok.</p> : (
        <div className="table-wrap">
          <table className="sum-table">
            <thead><tr><th>Kart</th><th>Son ekstre</th><th className="num">Dönem borcu</th><th className="num">Asgari</th><th>Son ödeme</th><th>Durum</th><th className="num"><Lbl k="statement_diff">Fark</Lbl></th></tr></thead>
            <tbody>
              {rows.map((r) => {
                const status = !r.last_cut ? ['Hiç yüklenmedi', 'crit'] : r.is_stale ? ['Yeni ekstre bekleniyor', 'warn'] : ['Güncel', 'ok'];
                const limDiff = r.stmt_limit !== null && r.sys_limit !== null && Math.abs(r.stmt_limit - r.sys_limit) > 0.5;
                return (
                  <tr key={r.account_id}>
                    <th scope="row">{r.name}{r.last4 && <span className="muted small"> ···{r.last4}</span>}</th>
                    <td>{r.last_cut ? <>{fmtDate(r.last_cut)}<span className="muted small"> · {r.days_since_cut} gün önce</span></> : <span className="muted">—</span>}</td>
                    <td className="num">{r.statement_debt === null ? '—' : money(r.statement_debt, 'TRY')}</td>
                    <td className="num">{r.min_payment === null ? '—' : money(r.min_payment, 'TRY')}</td>
                    <td>{r.last_due ? fmtDate(r.last_due) : '—'}</td>
                    <td><span className={`tag tag-${status[1] === 'ok' ? 'risk-normal' : status[1] === 'warn' ? 'risk-warn' : 'risk-crit'}`}>{status[0]}</span>
                      {r.is_stale && r.next_cut && <span className="muted small"> · kesim {fmtDate(r.next_cut)}</span>}
                      {limDiff && <span className="tag tag-warn" title={`Sistemde ${money(r.sys_limit!, 'TRY')}, ekstrede ${money(r.stmt_limit!, 'TRY')}`}>limit farklı</span>}</td>
                    <td className="num">{r.diff === null ? '—' : <span className={Math.abs(r.diff) <= 1 ? 'tone-in' : 'tone-out'}>{money(r.diff, 'TRY', true)}</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
//  Kategori seçici
// ---------------------------------------------------------------------------
function CategorySelect({ categories, value, onChange }: { categories: Category[]; value: string | null; onChange: (v: string | null) => void }) {
  const exp = categories.filter((c) => c.kind === 'expense' && !c.archived_at);
  const roots = exp.filter((c) => !c.parent_id);
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} aria-label="Kategori">
      <option value="">Otomatik / Diğer gider</option>
      {roots.map((r) => {
        const subs = exp.filter((c) => c.parent_id === r.id);
        return subs.length === 0 ? <option key={r.id} value={r.id}>{r.name}</option> : (
          <optgroup key={r.id} label={r.name}>
            <option value={r.id}>{r.name} (genel)</option>
            {subs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </optgroup>
        );
      })}
    </select>
  );
}

function suggestCategoryId(line: StatementLine, categories: Category[]): string | null {
  const exp = categories.filter((c) => c.kind === 'expense' && !c.archived_at);
  if (line.kind === 'interest' || line.kind === 'tax') return exp.find((c) => c.system_key === 'card_interest')?.id ?? null;
  if (line.kind === 'fee') return exp.find((c) => c.system_key === 'bank_fee')?.id ?? null;
  const name = suggestCategoryName(line);
  if (!name) return null;
  const hit = exp.find((c) => c.name === name && c.parent_id) ?? exp.find((c) => c.name === name);
  return hit?.id ?? null;
}

// ---------------------------------------------------------------------------
//  Tek ekstre önizleme ve onay
// ---------------------------------------------------------------------------
function Preview({ item, cards, banks, categories, onDone, onRemove }: {
  item: Item; cards: AccountBalance[]; banks: AccountBalance[]; categories: Category[]; onDone: (r: ImportResult) => void; onRemove: () => void;
}) {
  const st = item.statement!;
  const auto = cards.find((a) => a.iban_last4 && a.iban_last4 === st.cardLast4);
  const [accountId, setAccountId] = useState<string>(auto?.id ?? '');
  const acc = cards.find((a) => a.id === accountId) ?? null;
  const ledger = useCardLedger(accountId || null, addDaysIso(st.periodStart ?? st.cutDate, -45), addDaysIso(st.cutDate, 5));
  const recon = useStatementReconcile(accountId || null, st.cutDate);
  const match = useMemo(() => (ledger.data ? matchStatement(st, ledger.data) : null), [ledger.data, st]);

  const [dec, setDec] = useState<Map<number, LineDecision>>(new Map());
  const [rev, setRev] = useState<Set<string>>(new Set());
  const [updateProfile, setUpdateProfile] = useState(true);
  const [replace, setReplace] = useState(false);
  useEffect(() => {
    if (!match) return;
    setDec(new Map(match.lines.map((m) => {
      const d = defaultDecision(m);
      return [m.line.idx, { ...d, categoryId: d.action === 'add' && m.line.kind !== 'payment' ? suggestCategoryId(m.line, categories) : null }];
    })));
    setRev(new Set());
  }, [match, categories]);

  const patch = (idx: number, p: Partial<LineDecision>) => setDec((d) => new Map(d).set(idx, { ...(d.get(idx) ?? { action: 'skip' }), ...p }));
  const mut = useLedgerMutation(importStatement);

  const adds = match?.lines.filter((m) => dec.get(m.line.idx)?.action === 'add') ?? [];
  const addSum = adds.reduce((a, m) => a + m.line.amount, 0);
  const expected = recon.data ? recon.data.derived + addSum : null;
  const blocking = st.checks.filter((c) => !c.ok);
  const needsCard = !accountId;
  const dupErr = mut.error instanceof Error && /zaten/.test(mut.error.message);

  const submit = () => {
    if (!match || !accountId || !item.hash) return;
    const payload = buildPayload(st, accountId, item.hash, match.lines, dec, { updateProfile, reverseEntries: [...rev], replace });
    mut.mutate(payload, { onSuccess: (r) => onDone(r as ImportResult) });
  };

  const profileChanges: string[] = [];
  if (acc && st.limit !== null && Math.abs((acc.credit_limit ?? 0) - st.limit) > 0.5) profileChanges.push(`Limit: ${money(acc.credit_limit ?? 0, 'TRY')} → ${money(st.limit, 'TRY')}`);
  if (acc && acc.statement_day && Number(st.cutDate.slice(8)) !== acc.statement_day) profileChanges.push(`Kesim günü: ${acc.statement_day} → ${Number(st.cutDate.slice(8))}`);
  if (acc && acc.due_day && st.dueDate && Number(st.dueDate.slice(8)) !== acc.due_day) profileChanges.push(`Son ödeme günü: ${acc.due_day} → ${Number(st.dueDate.slice(8))}`);
  if (st.minPaymentPct !== null) profileChanges.push(`Asgari ödeme oranı: ${pct(st.minPaymentPct)}`);

  return (
    <section className="panel stmt-card">
      <header className="stmt-head">
        <div>
          <h2>{BANK_LABEL[st.bank]} · {st.product}</h2>
          <p className="muted small">{item.file.name}</p>
        </div>
        <button className="btn btn-quiet" onClick={onRemove}>Kaldır</button>
      </header>

      <div className="kpi-grid kpi-grid-tight">
        <div className="kpi"><span className="kpi-label"><Lbl k="statement">Dönem borcu</Lbl></span><span className="kpi-value">{money(st.statementDebt, 'TRY')}</span><span className="kpi-sub">Asgari {st.minPayment === null ? '—' : money(st.minPayment, 'TRY')}{st.minPaymentPct ? ` (${pct(st.minPaymentPct)})` : ''}</span></div>
        <div className="kpi"><span className="kpi-label">Hesap kesim</span><span className="kpi-value kpi-sm">{fmtDate(st.cutDate)}</span><span className="kpi-sub">Dönem {st.periodStart ? fmtDate(st.periodStart) : '—'} –</span></div>
        <div className="kpi"><span className="kpi-label">Son ödeme</span><span className="kpi-value kpi-sm">{st.dueDate ? fmtDate(st.dueDate) : '—'}</span><span className="kpi-sub">Sonraki kesim {st.nextCutDate ? fmtDate(st.nextCutDate) : '—'}</span></div>
        <div className="kpi"><span className="kpi-label">Limit</span><span className="kpi-value kpi-sm">{st.limit === null ? '—' : money(st.limit, 'TRY')}</span><span className="kpi-sub">Kullanılabilir {st.availableLimit === null ? '—' : money(st.availableLimit, 'TRY')}</span></div>
      </div>

      <div className="stmt-row">
        <label className="stmt-field">Sistemdeki kart
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">Kart seçin…</option>
            {cards.map((c) => <option key={c.id} value={c.id}>{c.name}{c.iban_last4 ? ` ···${c.iban_last4}` : ''}</option>)}
          </select>
        </label>
        {auto && <span className="tag tag-risk-normal">son 4 hane ({st.cardLast4}) ile otomatik eşleşti</span>}
        {!auto && <span className="tag tag-risk-warn">{st.cardLast4 ? `···${st.cardLast4} kayıtlı kartlarda yok: elle seçin` : 'Kart numarası okunamadı: elle seçin'}</span>}
      </div>

      {(st.warnings.length > 0 || st.checks.length > 0) && (
        <ul className="checks">
          {st.checks.map((c) => <li key={c.id} className={c.ok ? 'ok' : 'bad'}>{c.ok ? '✓' : '✗'} {c.label}{c.detail && <span className="muted small"> — {c.detail}</span>}</li>)}
          {st.warnings.filter((w) => !st.checks.some((c) => !c.ok && w.startsWith(c.label))).map((w) => <li key={w} className="note">ⓘ {w}</li>)}
        </ul>
      )}
      {blocking.length > 0 && <p className="error">Okunan kalemler ekstre toplamıyla tutmuyor. Aşağıdaki satırları ekstre PDF’iyle karşılaştırmadan işlemeyin.</p>}

      {needsCard ? <p className="muted">Devam etmek için bir kart seçin.</p> : ledger.isLoading || !match ? <p className="muted" aria-busy="true">Defterle karşılaştırılıyor…</p> : (
        <>
          <div className="recon">
            <h3><Lbl k="statement_diff">Defter ile karşılaştırma</Lbl></h3>
            <dl>
              <div><dt>Bankanın ekstre borcu</dt><dd>{money(st.statementDebt, 'TRY')}</dd></div>
              <div><dt>Defterin bu kesimde hesapladığı</dt><dd>{recon.data ? money(recon.data.derived, 'TRY') : '…'}</dd></div>
              <div><dt>Fark (şimdi)</dt><dd className={recon.data && Math.abs(recon.data.derived - st.statementDebt) > 1 ? 'tone-out' : 'tone-in'}>{recon.data ? money(recon.data.derived - st.statementDebt, 'TRY', true) : '…'}</dd></div>
              <div><dt>Seçtiğiniz kalemler eklenince (≈)</dt><dd className={expected !== null && Math.abs(expected - st.statementDebt) > 1 ? 'tone-out' : 'tone-in'}>{expected === null ? '…' : money(expected - st.statementDebt, 'TRY', true)}</dd></div>
            </dl>
            <p className="muted small">Fark kalırsa: Excel’den aktarılan kayıtlarda eksik/fazla kalem, yuvarlanmış tutar veya ekstrede olmayan taksit olabilir. Aşağıdaki “ekstrede görünmeyen” listesi ipucu verir.</p>
          </div>

          <div className="table-wrap">
            <table className="sum-table stmt-lines">
              <thead><tr><th>Ekle</th><th>Tarih</th><th>Açıklama</th><th className="num">Tutar</th><th>Durum</th><th>Kategori / kaynak</th></tr></thead>
              <tbody>
                {match.lines.map((m: LineMatch) => {
                  const d = dec.get(m.line.idx) ?? { action: 'skip' as const };
                  const on = d.action === 'add';
                  const inst = m.line.installment;
                  return (
                    <tr key={m.line.idx} className={`stmt-${m.status} ${on ? 'is-add' : ''}`}>
                      <td><input type="checkbox" checked={on} aria-label="Bu kalemi ekle" onChange={(e) => patch(m.line.idx, { action: e.target.checked ? 'add' : 'skip' })} /></td>
                      <td className="nowrap">{fmtDate(m.line.date)}{m.line.dateGuessed && <span className="muted small" title="Ekstrede tarih yok, kesim tarihi kullanıldı"> *</span>}</td>
                      <td>
                        {on ? <input className="desc-input" value={d.description ?? m.line.description} aria-label="Açıklama" onChange={(e) => patch(m.line.idx, { description: e.target.value })} /> : m.line.description}
                        <div className="muted small">{KIND_LABEL[m.line.kind]}{m.line.cardSuffix ? ` · ···${m.line.cardSuffix}` : ''}{inst && inst.count > 1 ? ` · ${inst.no}/${inst.count}. taksit${inst.total ? ` (toplam ${money(inst.total, 'TRY')})` : ''}` : ''}</div>
                      </td>
                      <td className="num"><Money value={m.line.amount} currency="TRY" tone={m.line.amount < 0 ? 'in' : undefined} /></td>
                      <td><span className={`tag tag-st-${m.status}`}>{STATUS_LABEL[m.status]}</span>
                        {m.status !== 'new' && <div className="muted small">{m.ledgerDate && fmtDate(m.ledgerDate)} · {m.ledgerDesc}</div>}
                        {m.status === 'new' && inst && inst.count > 1 && <div className="muted small">Taksitli: seçerseniz alışveriş tam tutarla, tahmini tarihte eklenir</div>}
                        {m.status === 'new' && m.line.kind === 'refund' && <div className="muted small">İade otomatik eklenemez, elle girin</div>}</td>
                      <td>
                        {on && m.line.kind === 'payment' && (
                          <select value={d.sourceAccountId ?? ''} onChange={(e) => patch(m.line.idx, { sourceAccountId: e.target.value || null })} aria-label="Ödeme kaynağı">
                            <option value="">Kaynak belirsiz</option>
                            {banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                          </select>
                        )}
                        {on && m.line.kind !== 'payment' && <CategorySelect categories={categories} value={d.categoryId ?? null} onChange={(v) => patch(m.line.idx, { categoryId: v })} />}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {match.ledgerOnly.length > 0 && (
            <div className="ledger-only">
              <h3>Defterde var, ekstrede görünmüyor <span className="muted small">({match.ledgerOnly.length})</span></h3>
              <p className="muted small">Bunlar aynı dönemde defterde kayıtlı ama ekstrede karşılığı bulunamadı. Tahmini faiz tahakkukları gibi geçici kayıtları ekstredeki gerçek tutarla değiştirmek için işaretleyip iptal edebilirsiniz.</p>
              <ul className="acc-list">
                {match.ledgerOnly.map((l) => (
                  <li key={l.entry_id}>
                    <label className="check"><input type="checkbox" checked={rev.has(l.entry_id)} onChange={(e) => setRev((s) => { const n = new Set(s); if (e.target.checked) n.add(l.entry_id); else n.delete(l.entry_id); return n; })} />
                      {fmtDate(l.entry_date)} · {l.description}{/OTO-FAIZ|tahakkuk/i.test(l.description ?? '') && <span className="tag tag-warn">tahmini</span>}</label>
                    <Money value={-l.amount} currency="TRY" />
                  </li>
                ))}
              </ul>
            </div>
          )}

          {profileChanges.length > 0 && (
            <label className="check profile-opt">
              <input type="checkbox" checked={updateProfile} onChange={(e) => setUpdateProfile(e.target.checked)} />
              <span>Kartı ekstreye göre güncelle: {profileChanges.join(' · ')}</span>
            </label>
          )}

          <div className="stmt-actions">
            <div>
              <strong>{adds.length}</strong> kalem eklenecek{adds.length > 0 && <> (net {money(addSum, 'TRY', true)})</>}
              {rev.size > 0 && <> · <strong>{rev.size}</strong> kayıt iptal edilecek</>}
            </div>
            {dupErr && <label className="check small"><input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> Aynı ekstrenin kaydının üzerine yaz</label>}
            <button className="btn btn-primary" disabled={mut.isPending || needsCard || (replace === false && false)} onClick={submit}>{mut.isPending ? 'İşleniyor…' : 'Ekstreyi işle'}</button>
          </div>
          {mut.error && <ErrorText error={mut.error} />}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
export default function Statements() {
  const accountsQ = useAccounts();
  const cats = useCategories().data ?? [];
  const status = useStatementStatus();
  const accounts = useMemo(() => (accountsQ.data ?? []).filter((a) => !a.archived_at), [accountsQ.data]);
  const cards = useMemo(() => accounts.filter((a) => a.kind === 'credit_card'), [accounts]);
  const banks = useMemo(() => accounts.filter((a) => a.class === 'asset' && (a.kind === 'bank' || a.kind === 'cash') && a.currency === 'TRY'), [accounts]);

  const [items, setItems] = useState<Item[]>([]);
  const [results, setResults] = useState<Record<string, ImportResult>>({});
  const [pw, setPw] = useState<Record<string, string>>({});
  const upd = useCallback((id: string, p: Partial<Item>) => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, ...p } : x))), []);

  const read = useCallback(async (item: Item, password?: string) => {
    upd(item.id, { phase: 'reading', error: undefined });
    try {
      const r = await readStatementFile(item.file, password);
      upd(item.id, { phase: 'ready', hash: r.hash, statement: r.statement });
    } catch (e) {
      if (e instanceof StatementError && e.code === 'PASSWORD') upd(item.id, { phase: 'password', error: e.message, passwordTried: !!password });
      else upd(item.id, { phase: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  }, [upd]);

  const onFiles = (files: FileList | null) => {
    if (!files) return;
    const added: Item[] = Array.from(files).filter((f) => /\.pdf$/i.test(f.name)).map((file) => ({ id: `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 7)}`, file, phase: 'reading' as Phase }));
    setItems((xs) => [...xs, ...added]);
    added.forEach((it) => void read(it));
  };

  return (
    <div className="page statements">
      <header className="page-head"><h1>Ekstre yükle</h1></header>
      <p className="muted">Bankadan indirdiğiniz kredi kartı ekstresini (PDF) yükleyin. Dosya yalnızca tarayıcınızda okunur, başka yere gönderilmez; adres ve kimlik bilgileri kaydedilmez. Hiçbir şey siz onaylamadan işlenmez.</p>

      <section className="panel dropzone" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); onFiles(e.dataTransfer.files); }}>
        <p><strong>PDF ekstreleri buraya sürükleyin</strong> ya da seçin</p>
        <label className="btn btn-primary">Dosya seç<input type="file" accept="application/pdf,.pdf" multiple hidden onChange={(e) => { onFiles(e.target.files); e.target.value = ''; }} /></label>
        <p className="muted small">Desteklenen bankalar: Akbank, Garanti BBVA, İş Bankası, QNB, VakıfBank, Yapı Kredi. Aynı anda birden çok ekstre yükleyebilirsiniz.</p>
      </section>

      {items.map((it) => {
        if (results[it.id]) {
          const r = results[it.id];
          return (
            <section key={it.id} className="panel stmt-done">
              <h2>✓ {it.file.name} işlendi</h2>
              <p>{r.added} kalem eklendi, {r.payments} ödeme işlendi{r.reversed ? `, ${r.reversed} kayıt iptal edildi` : ''}, {r.skipped} kalem atlandı.</p>
              <p className="muted">Ekstre borcu {money(r.statement_debt, 'TRY')} · defterin hesapladığı {money(r.ledger_after, 'TRY')} · kalan fark <strong className={Math.abs(r.difference_after) > 1 ? 'tone-out' : 'tone-in'}>{money(r.difference_after, 'TRY', true)}</strong></p>
              {Math.abs(r.difference_after) > 1 && <p className="muted small">Kalan fark, Excel’den gelen kayıtlardaki eksik ya da yuvarlanmış tutarlardan kaynaklanıyor olabilir. Kart sayfasından ilgili dönemi inceleyin.</p>}
            </section>
          );
        }
        if (it.phase === 'reading') return <section key={it.id} className="panel"><p aria-busy="true">{it.file.name} okunuyor…</p></section>;
        if (it.phase === 'password') return (
          <section key={it.id} className="panel">
            <h2>{it.file.name}</h2>
            <p className="muted">{it.passwordTried ? 'Şifre yanlış.' : 'Bu PDF şifreli.'} Şifre (genelde TC kimlik numarasının son 6 hanesi ya da doğum tarihi) yalnızca dosyayı açmak için kullanılır, kaydedilmez.</p>
            <div className="stmt-row">
              <input type="password" value={pw[it.id] ?? ''} placeholder="PDF şifresi" onChange={(e) => setPw((p) => ({ ...p, [it.id]: e.target.value }))} />
              <button className="btn btn-primary" onClick={() => void read(it, pw[it.id])}>Aç</button>
              <button className="btn btn-quiet" onClick={() => setItems((xs) => xs.filter((x) => x.id !== it.id))}>Kaldır</button>
            </div>
          </section>
        );
        if (it.phase === 'error') return (
          <section key={it.id} className="panel">
            <h2>{it.file.name}</h2><p className="error">{it.error}</p>
            <button className="btn btn-quiet" onClick={() => setItems((xs) => xs.filter((x) => x.id !== it.id))}>Kaldır</button>
          </section>
        );
        return <Preview key={it.id} item={it} cards={cards} banks={banks} categories={cats}
          onDone={(r) => setResults((x) => ({ ...x, [it.id]: r }))} onRemove={() => setItems((xs) => xs.filter((x) => x.id !== it.id))} />;
      })}

      {status.data ? <StatusTable rows={status.data} /> : status.isLoading ? <p className="muted" aria-busy="true">Yükleniyor…</p> : (
        <Empty title="Durum alınamadı">{status.error instanceof Error ? status.error.message : 'Bilinmeyen hata'} <Link to="/">Özet’e dön</Link></Empty>
      )}
    </div>
  );
}

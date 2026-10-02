import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  amendStatementLine, deleteStatement, importStatement, rpc, updateStatement, useAccounts, useCardLedger, useCategories,
  useCardSlices, useLedgerMutation, useStatementImports, useStatementReconcile, useStatementStatus,
  type AmendResult, type ImportResult, type ImportedLine, type StatementImport, type StatementStatusRow,
} from '../lib/api';
import { fmtDate, money, parseAmount } from '../lib/format';
import { BANK_LABEL, StatementError, type LineKind, type ParsedStatement, type StatementLine } from '../lib/statements/types';
import { matchStatement, suggestCategoryName, type LineMatch, type MatchStatus } from '../lib/statements/match';
import { buildPayload, defaultDecision, isCredit, signedAmount, type LineDecision } from '../lib/statements/import';
import { readStatementFile } from '../lib/statements/pdf';
import { computeChecks } from '../lib/statements/parsers';
import { addDaysIso } from '../lib/statements/text';
import type { AccountBalance, Category } from '../lib/types';
import { Lbl } from '../components/Info';
import { Empty, ErrorText, Money } from '../components/ui';

type Phase = 'reading' | 'password' | 'ready' | 'error' | 'done';
interface Item { id: string; file: File; phase: Phase; error?: string; hash?: string; statement?: ParsedStatement; passwordTried?: boolean }

const pct = (n: number | null) => (n === null ? '—' : `%${n.toLocaleString('tr-TR', { maximumFractionDigits: 1 })}`);
const numStr = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n).replace('.', ','));
const KIND_LABEL: Record<LineKind, string> = {
  purchase: 'Harcama', installment: 'Taksit', cash_advance: 'Nakit avans', payment: 'Ödeme', refund: 'İade',
  interest: 'Faiz', tax: 'Vergi (KKDF/BSMV)', fee: 'Ücret / aidat',
};
const KINDS = Object.keys(KIND_LABEL) as LineKind[];
const STATUS_LABEL: Record<MatchStatus, string> = { matched: 'Sistemde var', maybe: 'Olası eşleşme', new: 'Yeni' };

// ---------------------------------------------------------------------------
//  Küçük giriş bileşenleri
// ---------------------------------------------------------------------------
/** Tutar kutusu: yazarken serbest, alan bırakılınca (blur) ayrıştırılır; geçersizse eski değere döner. */
function AmountInput({ value, onCommit, label, allowEmpty, className }: {
  value: number | null; onCommit: (v: number | null) => void; label: string; allowEmpty?: boolean; className?: string;
}) {
  const [text, setText] = useState(numStr(value));
  useEffect(() => setText(numStr(value)), [value]);
  const commit = () => {
    if (text.trim() === '') { if (allowEmpty) onCommit(null); else setText(numStr(value)); return; }
    const n = parseAmount(text);
    if (n === null) setText(numStr(value)); else { onCommit(n); setText(numStr(n)); }
  };
  return <input className={className ?? 'amt-input'} inputMode="decimal" aria-label={label} value={text}
    onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />;
}

function IntInput({ value, onCommit, label, min = 1, max = 99 }: { value: number; onCommit: (v: number) => void; label: string; min?: number; max?: number }) {
  return <input className="int-input" type="number" aria-label={label} min={min} max={max} value={value}
    onChange={(e) => { const n = Math.round(Number(e.target.value)); if (Number.isFinite(n)) onCommit(Math.min(max, Math.max(min, n))); }} />;
}

// ---------------------------------------------------------------------------
//  Kart ekstre durumu tablosu
// ---------------------------------------------------------------------------
function StatusTable({ rows }: { rows: StatementStatusRow[] }) {
  return (
    <section className="panel">
      <h2><Lbl k="statement_fresh">Kart ekstre durumu</Lbl></h2>
      <p className="chart-note small muted">Her kart için yüklenen son ekstre. “Fark”, defterin o kesimde hesapladığı borç ile bankanın ekstre borcu arasındaki farktır.</p>
      {rows.length === 0 ? <p className="muted empty-inline">Henüz kredi kartı yok. İlk ekstreyi yüklediğinizde kart ekstreden oluşturulur.</p> : (
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
//  Ekstreden yeni kart oluşturma
// ---------------------------------------------------------------------------
function NewCardForm({ st, onCreated }: { st: ParsedStatement; onCreated: (id: string) => void }) {
  const [name, setName] = useState(`${BANK_LABEL[st.bank]} ${st.product}${st.cardLast4 ? ` ···${st.cardLast4}` : ''}`);
  const [limit, setLimit] = useState<number | null>(st.limit);
  const [cutDay, setCutDay] = useState(Number(st.cutDate.slice(8)) || 1);
  const [dueDay, setDueDay] = useState(st.dueDate ? Number(st.dueDate.slice(8)) : 0);
  const [opening, setOpening] = useState<number | null>(st.previousBalance ?? 0);
  const openedOn = addDaysIso(st.periodStart ?? st.cutDate, -1);
  const create = useLedgerMutation(() => rpc<string>('create_account', {
    p_name: name.trim(), p_kind: 'credit_card', p_currency: 'TRY', p_opening_balance: opening ?? 0, p_opened_on: openedOn,
    p_institution_name: BANK_LABEL[st.bank], p_credit_limit: limit, p_statement_day: cutDay, p_due_day: dueDay,
    p_iban_last4: st.cardLast4,
  }));
  const valid = name.trim().length > 0 && dueDay >= 1 && dueDay <= 31 && cutDay >= 1 && cutDay <= 31;
  return (
    <div className="newcard">
      <h3>Bu kart sistemde yok — ekstreden oluşturalım</h3>
      <p className="muted small">Bilgiler ekstreden dolduruldu; yanlış okunanları düzeltin. Ekstrenin <strong>önceki bakiyesi</strong>, kartın açılış borcu olur; böylece bu ekstredeki borç doğru tutar.</p>
      <div className="head-grid">
        <label className="stmt-field">Kart adı<input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="stmt-field">Limit<AmountInput value={limit} allowEmpty onCommit={setLimit} label="Limit" /></label>
        <label className="stmt-field">Hesap kesim günü<IntInput value={cutDay} onCommit={setCutDay} label="Kesim günü" max={31} /></label>
        <label className="stmt-field">Son ödeme günü<IntInput value={dueDay || 1} onCommit={setDueDay} label="Son ödeme günü" max={31} /></label>
        <label className="stmt-field">Devreden borç (açılış)<AmountInput value={opening} onCommit={(v) => setOpening(v ?? 0)} label="Devreden borç" /></label>
        <div className="stmt-field"><span>Açılış tarihi</span><strong>{fmtDate(openedOn)}</strong></div>
      </div>
      {!st.dueDate && <p className="muted small">Son ödeme günü ekstreden okunamadı; lütfen girin.</p>}
      <div className="stmt-actions">
        <span />
        <button className="btn btn-primary" disabled={!valid || create.isPending}
          onClick={() => create.mutate(undefined, { onSuccess: (id) => onCreated(String(id)) })}>{create.isPending ? 'Oluşturuluyor…' : 'Kartı oluştur ve seç'}</button>
      </div>
      {create.error && <ErrorText error={create.error} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Tek ekstre önizleme, düzenleme ve onay
// ---------------------------------------------------------------------------
function Preview({ item, cards, banks, categories, imports, onDone, onRemove }: {
  item: Item; cards: AccountBalance[]; banks: AccountBalance[]; categories: Category[]; imports: StatementImport[];
  onDone: (r: ImportResult) => void; onRemove: () => void;
}) {
  const original = item.statement!;
  const [st, setSt] = useState<ParsedStatement>(() => ({ ...original, lines: original.lines.map((l) => ({ ...l })) }));
  const checks = useMemo(() => computeChecks(st), [st]);
  const notes = original.warnings.filter((w) => !original.checks.some((c) => !c.ok && w.startsWith(c.label)));
  const start = st.periodStart ?? addDaysIso(st.cutDate, -30);

  const auto = cards.find((a) => a.iban_last4 && a.iban_last4 === st.cardLast4);
  const [accountId, setAccountId] = useState<string>(auto?.id ?? '');
  useEffect(() => { if (!accountId && auto) setAccountId(auto.id); }, [auto, accountId]);
  const acc = cards.find((a) => a.id === accountId) ?? null;

  const ledger = useCardLedger(accountId || null, addDaysIso(start, -45), addDaysIso(st.cutDate, 5));
  const recon = useStatementReconcile(accountId || null, st.cutDate);
  const prevRecon = useStatementReconcile(accountId || null, addDaysIso(start, -1));
  const slicesQ = useCardSlices(accountId || undefined);
  const match = useMemo(() => (ledger.data ? matchStatement(st, ledger.data, slicesQ.data ?? []) : null), [ledger.data, slicesQ.data, st]);

  const [over, setOver] = useState<Map<number, Partial<LineDecision>>>(new Map());
  const [rev, setRev] = useState<Set<string>>(new Set());
  const [updateProfile, setUpdateProfile] = useState(true);
  const [replace, setReplace] = useState(false);

  const decide = useCallback((m: LineMatch): LineDecision => {
    const base = defaultDecision(m);
    const o = over.get(m.line.idx) ?? {};
    return {
      action: o.action ?? base.action,
      categoryId: isCredit(m.line.kind) ? null : 'categoryId' in o ? o.categoryId ?? null : suggestCategoryId(m.line, categories),
      sourceAccountId: o.sourceAccountId ?? null,
    };
  }, [over, categories]);
  const setDec = (idx: number, p: Partial<LineDecision>) => setOver((m) => new Map(m).set(idx, { ...(m.get(idx) ?? {}), ...p }));

  // --- düzenleme
  const setHead = (p: Partial<ParsedStatement>) => setSt((s) => ({ ...s, ...p }));
  const setLine = (idx: number, p: Partial<StatementLine>) =>
    setSt((s) => ({ ...s, lines: s.lines.map((l) => {
      if (l.idx !== idx) return l;
      const n = { ...l, ...p };
      return { ...n, amount: signedAmount(n.kind, n.amount) };
    }) }));
  const setKind = (l: StatementLine, kind: LineKind) =>
    setLine(l.idx, { kind, installment: kind === 'installment' ? l.installment ?? { no: 1, count: 2, total: null, remaining: null } : null });
  const delLine = (idx: number) => setSt((s) => ({ ...s, lines: s.lines.filter((l) => l.idx !== idx) }));
  const addLine = () => setSt((s) => ({
    ...s, lines: [...s.lines, { idx: Math.max(-1, ...s.lines.map((l) => l.idx)) + 1, date: s.cutDate, dateGuessed: false, description: '',
      amount: 0, kind: 'purchase', cardSuffix: null, installment: null }],
  }));

  const mut = useLedgerMutation(importStatement);
  const adds = match?.lines.filter((m) => decide(m).action === 'add') ?? [];
  const addSum = adds.reduce((a, m) => a + m.line.amount, 0);
  const expected = recon.data ? recon.data.derived + addSum : null;
  const bad = adds.filter((m) => !(Math.abs(m.line.amount) > 0) || !m.line.date);
  const failedChecks = checks.filter((c) => !c.ok);
  const dupErr = mut.error instanceof Error && /zaten/.test(mut.error.message);
  const newer = imports.filter((i) => i.account_id === accountId && i.cut_date > st.cutDate);

  const submit = () => {
    if (!match || !accountId || !item.hash) return;
    const payload = buildPayload(st, accountId, item.hash, match.lines, decide, { updateProfile, reverseEntries: [...rev], replace });
    mut.mutate(payload, { onSuccess: (r) => onDone(r as ImportResult) });
  };

  const profileChanges: string[] = [];
  if (acc && st.limit !== null && Math.abs((acc.credit_limit ?? 0) - st.limit) > 0.5) profileChanges.push(`Limit: ${money(acc.credit_limit ?? 0, 'TRY')} → ${money(st.limit, 'TRY')}`);
  if (acc && acc.statement_day && Number(st.cutDate.slice(8)) !== acc.statement_day) profileChanges.push(`Kesim günü: ${acc.statement_day} → ${Number(st.cutDate.slice(8))}`);
  if (acc && acc.due_day && st.dueDate && Number(st.dueDate.slice(8)) !== acc.due_day) profileChanges.push(`Son ödeme günü: ${acc.due_day} → ${Number(st.dueDate.slice(8))}`);
  if (st.minPayment !== null && st.statementDebt > 0) profileChanges.push(`Asgari ödeme oranı: ${pct(Math.round((st.minPayment / st.statementDebt) * 100))}`);

  return (
    <section className="panel stmt-card">
      <header className="stmt-head">
        <div>
          <h2>{BANK_LABEL[st.bank]} · {st.product}</h2>
          <p className="muted small">{item.file.name}</p>
        </div>
        <button className="btn btn-quiet" onClick={onRemove}>Kaldır</button>
      </header>

      <h3 className="stmt-sub"><Lbl k="statement">Ekstre bilgileri</Lbl> <span className="muted small">— yanlış okunanı düzeltebilirsiniz</span></h3>
      <div className="head-grid">
        <label className="stmt-field">Dönem borcu<AmountInput value={st.statementDebt} onCommit={(v) => setHead({ statementDebt: v ?? 0 })} label="Dönem borcu" /></label>
        <label className="stmt-field">Asgari ödeme<AmountInput value={st.minPayment} allowEmpty onCommit={(v) => setHead({ minPayment: v })} label="Asgari ödeme" /></label>
        <label className="stmt-field">Önceki bakiye<AmountInput value={st.previousBalance} allowEmpty onCommit={(v) => setHead({ previousBalance: v })} label="Önceki bakiye" /></label>
        <label className="stmt-field">Hesap kesim tarihi<input type="date" value={st.cutDate} onChange={(e) => e.target.value && setHead({ cutDate: e.target.value })} /></label>
        <label className="stmt-field">Son ödeme tarihi<input type="date" value={st.dueDate ?? ''} onChange={(e) => setHead({ dueDate: e.target.value || null })} /></label>
        <label className="stmt-field">Dönem başlangıcı<input type="date" value={st.periodStart ?? ''} onChange={(e) => setHead({ periodStart: e.target.value || null })} /></label>
        <label className="stmt-field">Limit<AmountInput value={st.limit} allowEmpty onCommit={(v) => setHead({ limit: v })} label="Limit" /></label>
        <label className="stmt-field">Kullanılabilir limit<AmountInput value={st.availableLimit} allowEmpty onCommit={(v) => setHead({ availableLimit: v })} label="Kullanılabilir limit" /></label>
        <label className="stmt-field">Kart son 4 hane<input maxLength={4} inputMode="numeric" value={st.cardLast4 ?? ''} onChange={(e) => setHead({ cardLast4: e.target.value.replace(/\D/g, '') || null })} /></label>
      </div>

      <div className="stmt-row">
        <label className="stmt-field">Sistemdeki kart
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">Yeni kart oluştur…</option>
            {cards.map((c) => <option key={c.id} value={c.id}>{c.name}{c.iban_last4 ? ` ···${c.iban_last4}` : ''}</option>)}
          </select>
        </label>
        {auto && accountId === auto.id && <span className="tag tag-risk-normal">son 4 hane ({st.cardLast4}) ile otomatik eşleşti</span>}
        {!accountId && cards.length > 0 && <span className="tag tag-risk-warn">{st.cardLast4 ? `···${st.cardLast4} kayıtlı kartlarda yok` : 'Kart numarası okunamadı'}</span>}
      </div>

      <ul className="checks">
        {checks.map((c) => <li key={c.id} className={c.ok ? 'ok' : 'bad'}>{c.ok ? '✓' : '✗'} {c.label}{c.detail && <span className="muted small"> — {c.detail}</span>}</li>)}
        {notes.map((w) => <li key={w} className="note">ⓘ {w}</li>)}
      </ul>
      {failedChecks.length > 0 && <p className="error">Kalemler ekstre toplamıyla tutmuyor. Satırları ekstre PDF’iyle karşılaştırın; eksik kalemi ekleyin ya da yanlış rakamı düzeltin.</p>}

      {!accountId ? <NewCardForm st={st} onCreated={setAccountId} /> : ledger.isLoading || !match ? <p className="muted" aria-busy="true">Defterle karşılaştırılıyor…</p> : (
        <>
          {newer.length > 0 && <p className="note-box">Bu kartın daha yeni bir ekstresi ({fmtDate(newer[0].cut_date)}) zaten yüklü. Eski dönem ekstresini sonradan eklemek defterde fark yaratabilir; ekstreleri eskiden yeniye yükleyin.</p>}
          <div className="recon">
            <h3><Lbl k="statement_diff">Defter ile karşılaştırma</Lbl></h3>
            <dl>
              <div><dt>Bankanın ekstre borcu</dt><dd>{money(st.statementDebt, 'TRY')}</dd></div>
              <div><dt>Defterin bu kesimde hesapladığı</dt><dd>{recon.data ? money(recon.data.derived, 'TRY') : '…'}</dd></div>
              <div><dt>Seçtiğiniz kalemler eklenince fark (≈)</dt><dd className={expected !== null && Math.abs(expected - st.statementDebt) > 1 ? 'tone-out' : 'tone-in'}>{expected === null ? '…' : money(expected - st.statementDebt, 'TRY', true)}</dd></div>
              {st.previousBalance !== null && (
                <div><dt>Önceki bakiye: ekstre ↔ defter</dt>
                  <dd className={prevRecon.data && Math.abs(prevRecon.data.derived - st.previousBalance) > 1 ? 'tone-out' : 'tone-in'}>
                    {prevRecon.data ? `${money(st.previousBalance, 'TRY')} ↔ ${money(prevRecon.data.derived, 'TRY')}` : '…'}</dd></div>
              )}
            </dl>
            <p className="muted small">Önceki bakiye tutmuyorsa, bir önceki ekstre eksik ya da onun ödemeleri işlenmemiş olabilir. Seçtiğiniz kalemler eklenince fark 0’a yaklaşmalıdır.</p>
          </div>

          <div className="table-wrap">
            <table className="sum-table stmt-lines">
              <thead><tr><th>Ekle</th><th>Tarih</th><th>Açıklama / tür</th><th className="num">Tutar</th><th>Durum</th><th>Kategori / kaynak</th><th /></tr></thead>
              <tbody>
                {match.lines.map((m: LineMatch) => {
                  const l = m.line;
                  const d = decide(m);
                  const on = d.action === 'add';
                  const inst = l.installment;
                  return (
                    <tr key={l.idx} className={`stmt-${m.status} ${on ? 'is-add' : ''}`}>
                      <td><input type="checkbox" checked={on} aria-label="Bu kalemi ekle" onChange={(e) => setDec(l.idx, { action: e.target.checked ? 'add' : 'skip' })} /></td>
                      <td className="nowrap"><input type="date" aria-label="Tarih" value={l.date} onChange={(e) => e.target.value && setLine(l.idx, { date: e.target.value, dateGuessed: false })} /></td>
                      <td>
                        <input className="desc-input" aria-label="Açıklama" value={l.description} placeholder="Açıklama" onChange={(e) => setLine(l.idx, { description: e.target.value })} />
                        <div className="kind-row">
                          <select aria-label="Tür" value={l.kind} onChange={(e) => setKind(l, e.target.value as LineKind)}>
                            {KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                          </select>
                          {l.kind === 'installment' && inst && (
                            <span className="inst-edit">
                              <IntInput value={inst.no} label="Kaçıncı taksit" max={inst.count} onCommit={(no) => setLine(l.idx, { installment: { ...inst, no } })} />
                              <span>/</span>
                              <IntInput value={inst.count} label="Toplam taksit" min={2} onCommit={(count) => setLine(l.idx, { installment: { ...inst, count, no: Math.min(inst.no, count) } })} />
                              <span className="muted small">taksit</span>
                            </span>
                          )}
                          {l.dateGuessed && <span className="muted small" title="Ekstrede tarih yok, kesim tarihi kullanıldı">tarih tahmini</span>}
                        </div>
                      </td>
                      <td className="num">
                        <AmountInput value={Math.abs(l.amount)} label="Tutar" onCommit={(v) => setLine(l.idx, { amount: v ?? 0 })} />
                        <div className="muted small">{isCredit(l.kind) ? 'borcu azaltır' : 'borcu artırır'}</div>
                      </td>
                      <td><span className={`tag tag-st-${m.status}`}>{STATUS_LABEL[m.status]}</span>
                        {m.status !== 'new' && <div className="muted small">{m.ledgerDate && fmtDate(m.ledgerDate)} · {m.ledgerDesc}</div>}
                        {on && l.kind === 'installment' && inst && inst.count > 1 && (
                          <div className="muted small">{inst.count - inst.no + 1} taksit kalan × {money(Math.abs(l.amount), 'TRY')} = {money(Math.abs(l.amount) * (inst.count - inst.no + 1), 'TRY')} plan olarak yazılır</div>
                        )}</td>
                      <td>
                        {on && l.kind === 'payment' && (
                          <select value={d.sourceAccountId ?? ''} onChange={(e) => setDec(l.idx, { sourceAccountId: e.target.value || null })} aria-label="Ödeme kaynağı">
                            <option value="">Kaynak belirsiz</option>
                            {banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                          </select>
                        )}
                        {on && !isCredit(l.kind) && <CategorySelect categories={categories} value={d.categoryId ?? null} onChange={(v) => setDec(l.idx, { categoryId: v })} />}
                      </td>
                      <td><button className="btn btn-quiet" aria-label="Satırı sil" title="Satırı sil" onClick={() => delLine(l.idx)}>✕</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <button className="btn" onClick={addLine}>+ Satır ekle</button>

          {match.ledgerOnly.length > 0 && (
            <div className="ledger-only">
              <h3>Defterde var, ekstrede görünmüyor <span className="muted small">({match.ledgerOnly.length})</span></h3>
              <p className="muted small">Aynı dönemde defterde kayıtlı ama ekstrede karşılığı bulunamadı. Tahmini kayıtları ekstredeki gerçek tutarla değiştirmek için işaretleyip iptal edebilirsiniz.</p>
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
              {bad.length > 0 && <div className="error small">{bad.length} eklenecek satırda tutar veya tarih eksik.</div>}
            </div>
            {dupErr && <label className="check small"><input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> Aynı ekstrenin kaydının üzerine yaz</label>}
            <button className="btn btn-primary" disabled={mut.isPending || bad.length > 0} onClick={submit}>{mut.isPending ? 'İşleniyor…' : 'Ekstreyi işle'}</button>
          </div>
          <p className="muted small">İşledikten sonra da her şey düzeltilebilir: aşağıdaki “Yüklenen ekstreler” bölümünden rakamı, satırı, kategoriyi değiştirebilir, satır ekleyip çıkarabilirsiniz.</p>
          {mut.error && <ErrorText error={mut.error} />}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
//  Yüklenmiş ekstreyi sonradan düzeltme
// ---------------------------------------------------------------------------
function ImportedLineRow({ imp, l, banks, categories, onResult }: {
  imp: StatementImport; l: ImportedLine; banks: AccountBalance[]; categories: Category[]; onResult: (r: AmendResult) => void;
}) {
  const [date, setDate] = useState(l.date);
  const [desc, setDesc] = useState(l.description);
  const [kind, setKind] = useState<LineKind>(l.kind);
  const [amount, setAmount] = useState<number | null>(Math.abs(l.amount));
  const [cat, setCat] = useState<string | null>(l.category_id ?? null);
  const [src, setSrc] = useState<string | null>(l.source_account_id ?? null);
  useEffect(() => {
    setDate(l.date); setDesc(l.description); setKind(l.kind); setAmount(Math.abs(l.amount));
    setCat(l.category_id ?? null); setSrc(l.source_account_id ?? null);
  }, [l]);
  const added = l.action === 'add';
  const dirty = date !== l.date || desc !== l.description || kind !== l.kind || amount !== Math.abs(l.amount)
    || cat !== (l.category_id ?? null) || src !== (l.source_account_id ?? null);
  const fields = () => ({ date, description: desc, kind, amount: amount ?? 0, category_id: isCredit(kind) ? null : cat,
    source_account_id: kind === 'payment' ? src : null, installments: l.installments ?? 1, purchase_amount: l.purchase_amount ?? null });
  const amend = useLedgerMutation((p: Record<string, unknown>) => amendStatementLine(imp.id, l.idx, p));
  const run = (p: Record<string, unknown>) => amend.mutate(p, { onSuccess: (r) => onResult(r as AmendResult) });
  const bad = !(amount && amount > 0) || !date;
  return (
    <tr className={added ? 'is-add' : 'stmt-matched'}>
      <td className="nowrap"><input type="date" aria-label="Tarih" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} /></td>
      <td>
        <input className="desc-input" aria-label="Açıklama" value={desc} onChange={(e) => setDesc(e.target.value)} />
        <div className="kind-row">
          <select aria-label="Tür" value={kind} onChange={(e) => setKind(e.target.value as LineKind)}>
            {KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
          {(l.installments ?? 1) > 1 && <span className="muted small">{l.installments} taksitlik plan</span>}
          {!added && <span className="muted small">defterde yok (atlanmış)</span>}
        </div>
      </td>
      <td className="num"><AmountInput value={amount} label="Tutar" onCommit={setAmount} /></td>
      <td>
        {!isCredit(kind) && <CategorySelect categories={categories} value={cat} onChange={setCat} />}
        {kind === 'payment' && (
          <select value={src ?? ''} onChange={(e) => setSrc(e.target.value || null)} aria-label="Ödeme kaynağı">
            <option value="">Kaynak belirsiz</option>
            {banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        )}
      </td>
      <td className="row-actions">
        {added ? (
          <>
            <button className="btn" disabled={!dirty || bad || amend.isPending} onClick={() => run({ op: 'edit', ...fields() })}>Kaydet</button>
            <button className="btn btn-quiet" disabled={amend.isPending} onClick={() => run({ op: 'edit', include: false })}>Defterden çıkar</button>
          </>
        ) : (
          <button className="btn" disabled={bad || amend.isPending} onClick={() => run({ op: 'edit', include: true, ...fields() })}>Deftere ekle</button>
        )}
        <button className="btn btn-quiet" aria-label="Satırı sil" disabled={amend.isPending}
          onClick={() => { if (window.confirm('Bu satır ekstreden çıkarılsın mı? Deftere eklenmişse kaydı iptal edilir.')) run({ op: 'remove' }); }}>Sil</button>
        {amend.error && <ErrorText error={amend.error} />}
      </td>
    </tr>
  );
}

function AddLineForm({ imp, banks, categories, onResult }: { imp: StatementImport; banks: AccountBalance[]; categories: Category[]; onResult: (r: AmendResult) => void }) {
  const [date, setDate] = useState(imp.cut_date);
  const [desc, setDesc] = useState('');
  const [kind, setKind] = useState<LineKind>('purchase');
  const [amount, setAmount] = useState<number | null>(null);
  const [cat, setCat] = useState<string | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const add = useLedgerMutation((p: Record<string, unknown>) => amendStatementLine(imp.id, null, p));
  const ok = !!amount && amount > 0 && !!date;
  return (
    <tr className="add-row">
      <td><input type="date" aria-label="Yeni satır tarihi" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} /></td>
      <td>
        <input className="desc-input" aria-label="Yeni satır açıklaması" placeholder="Yeni satır açıklaması" value={desc} onChange={(e) => setDesc(e.target.value)} />
        <div className="kind-row">
          <select aria-label="Yeni satır türü" value={kind} onChange={(e) => setKind(e.target.value as LineKind)}>
            {KINDS.filter((k) => k !== 'installment').map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
        </div>
      </td>
      <td className="num"><AmountInput value={amount} allowEmpty label="Yeni satır tutarı" onCommit={setAmount} /></td>
      <td>
        {!isCredit(kind) && <CategorySelect categories={categories} value={cat} onChange={setCat} />}
        {kind === 'payment' && (
          <select value={src ?? ''} onChange={(e) => setSrc(e.target.value || null)} aria-label="Yeni ödeme kaynağı">
            <option value="">Kaynak belirsiz</option>
            {banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        )}
      </td>
      <td className="row-actions">
        <button className="btn btn-primary" disabled={!ok || add.isPending}
          onClick={() => add.mutate({ op: 'add', date, description: desc, kind, amount, category_id: isCredit(kind) ? null : cat, source_account_id: kind === 'payment' ? src : null },
            { onSuccess: (r) => { onResult(r as AmendResult); setDesc(''); setAmount(null); } })}>+ Ekle</button>
        {add.error && <ErrorText error={add.error} />}
      </td>
    </tr>
  );
}

function ImportedEditor({ imp, banks, categories }: { imp: StatementImport; banks: AccountBalance[]; categories: Category[] }) {
  const [head, setHead] = useState({ cut: imp.cut_date, due: imp.due_date ?? '', start: imp.period_start ?? '',
    debt: imp.statement_debt as number | null, min: imp.min_payment, prev: imp.previous_balance, limit: imp.credit_limit });
  useEffect(() => setHead({ cut: imp.cut_date, due: imp.due_date ?? '', start: imp.period_start ?? '',
    debt: imp.statement_debt, min: imp.min_payment, prev: imp.previous_balance, limit: imp.credit_limit }), [imp]);
  const [profile, setProfile] = useState(false);
  const [result, setResult] = useState<AmendResult | null>(null);
  const [reverse, setReverse] = useState(true);
  const save = useLedgerMutation((p: Record<string, unknown>) => updateStatement(imp.id, p));
  const del = useLedgerMutation((r: boolean) => deleteStatement(imp.id, r));
  const diff = result ? result.difference : imp.ledger_debt_after !== null ? Math.round((imp.ledger_debt_after - imp.statement_debt) * 100) / 100 : null;
  const headDirty = head.cut !== imp.cut_date || head.due !== (imp.due_date ?? '') || head.start !== (imp.period_start ?? '') || head.debt !== imp.statement_debt
    || head.min !== imp.min_payment || head.prev !== imp.previous_balance || head.limit !== imp.credit_limit;
  const lines = [...imp.lines].sort((a, b) => a.date.localeCompare(b.date) || a.idx - b.idx);

  return (
    <div className="imp-editor">
      <div className="head-grid">
        <label className="stmt-field">Dönem borcu<AmountInput value={head.debt} onCommit={(v) => setHead((h) => ({ ...h, debt: v ?? 0 }))} label="Dönem borcu" /></label>
        <label className="stmt-field">Asgari ödeme<AmountInput value={head.min} allowEmpty onCommit={(v) => setHead((h) => ({ ...h, min: v }))} label="Asgari ödeme" /></label>
        <label className="stmt-field">Önceki bakiye<AmountInput value={head.prev} allowEmpty onCommit={(v) => setHead((h) => ({ ...h, prev: v }))} label="Önceki bakiye" /></label>
        <label className="stmt-field">Hesap kesim tarihi<input type="date" value={head.cut} onChange={(e) => e.target.value && setHead((h) => ({ ...h, cut: e.target.value }))} /></label>
        <label className="stmt-field">Son ödeme tarihi<input type="date" value={head.due} onChange={(e) => setHead((h) => ({ ...h, due: e.target.value }))} /></label>
        <label className="stmt-field">Dönem başlangıcı<input type="date" value={head.start} onChange={(e) => setHead((h) => ({ ...h, start: e.target.value }))} /></label>
        <label className="stmt-field">Limit<AmountInput value={head.limit} allowEmpty onCommit={(v) => setHead((h) => ({ ...h, limit: v }))} label="Limit" /></label>
      </div>
      <div className="stmt-actions">
        <label className="check small"><input type="checkbox" checked={profile} onChange={(e) => setProfile(e.target.checked)} /> Kartın limit, kesim günü ve son ödeme gününü de güncelle</label>
        <button className="btn btn-primary" disabled={!headDirty || save.isPending}
          onClick={() => save.mutate({ cut_date: head.cut, due_date: head.due || null, period_start: head.start || null, statement_debt: head.debt ?? 0,
            min_payment: head.min, previous_balance: head.prev, limit: head.limit, update_profile: profile }, { onSuccess: (r) => setResult(r as AmendResult) })}>
          {save.isPending ? 'Kaydediliyor…' : 'Bilgileri kaydet'}</button>
      </div>
      {save.error && <ErrorText error={save.error} />}

      <p className="recon-line">Defter ↔ ekstre farkı: <strong className={diff !== null && Math.abs(diff) > 1 ? 'tone-out' : 'tone-in'}>{diff === null ? '—' : money(diff, 'TRY', true)}</strong>
        <span className="muted small"> · {diff !== null && Math.abs(diff) <= 1 ? 'ekstre ile defter tutuyor' : 'eksik/fazla satır ya da yanlış rakam olabilir: satırları ekstre PDF’iyle karşılaştırın'}</span></p>

      <div className="table-wrap">
        <table className="sum-table stmt-lines">
          <thead><tr><th>Tarih</th><th>Açıklama / tür</th><th className="num">Tutar</th><th>Kategori / kaynak</th><th /></tr></thead>
          <tbody>
            {lines.map((l) => <ImportedLineRow key={l.idx} imp={imp} l={l} banks={banks} categories={categories} onResult={setResult} />)}
            <AddLineForm imp={imp} banks={banks} categories={categories} onResult={setResult} />
          </tbody>
        </table>
      </div>

      <div className="stmt-actions danger-zone">
        <label className="check small"><input type="checkbox" checked={reverse} onChange={(e) => setReverse(e.target.checked)} /> Bu ekstrenin deftere eklediği kayıtları da iptal et</label>
        <button className="btn btn-danger" disabled={del.isPending}
          onClick={() => { if (window.confirm(reverse ? 'Ekstre silinecek ve deftere eklediği kayıtlar iptal edilecek. Emin misiniz?' : 'Ekstre kaydı silinecek (defter kayıtları kalacak). Emin misiniz?')) del.mutate(reverse); }}>Ekstreyi sil</button>
      </div>
      {del.error && <ErrorText error={del.error} />}
    </div>
  );
}

function ImportedStatements({ banks, categories, cards, open, setOpen }: { banks: AccountBalance[]; categories: Category[]; cards: AccountBalance[]; open: string | null; setOpen: (id: string | null) => void }) {
  const q = useStatementImports();
  if (q.isLoading) return null;
  const rows = q.data ?? [];
  return (
    <section className="panel" id="yuklenen-ekstreler">
      <h2>Yüklenen ekstreler</h2>
      <p className="chart-note small muted">İşlenmiş bir ekstreyi istediğiniz zaman düzeltebilirsiniz: rakamları değiştirin, satır ekleyin ya da çıkarın. Defter kayıtları silinmez; her düzeltme eski kaydı iptal edip yenisini yazar, iz kalır.</p>
      {rows.length === 0 ? <p className="muted empty-inline">Henüz işlenmiş ekstre yok.</p> : (
        <ul className="imp-list">
          {rows.map((r) => {
            const card = cards.find((c) => c.id === r.account_id);
            const diff = r.ledger_debt_after === null ? null : Math.round((r.ledger_debt_after - r.statement_debt) * 100) / 100;
            const isOpen = open === r.id;
            return (
              <li key={r.id} className={isOpen ? 'is-open' : ''}>
                <button className="imp-head" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : r.id)}>
                  <span><strong>{card?.name ?? 'Kart'}</strong> <span className="muted small">· kesim {fmtDate(r.cut_date)} · {BANK_LABEL[r.bank as keyof typeof BANK_LABEL] ?? r.bank}</span></span>
                  <span className="imp-sum">{money(r.statement_debt, 'TRY')}
                    {diff !== null && <span className={`tag ${Math.abs(diff) <= 1 ? 'tag-risk-normal' : 'tag-risk-warn'}`}>{Math.abs(diff) <= 1 ? 'tutuyor' : `fark ${money(diff, 'TRY', true)}`}</span>}
                    <span aria-hidden="true">{isOpen ? '▲' : '▼'}</span></span>
                </button>
                {isOpen && <ImportedEditor imp={r} banks={banks} categories={categories} />}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
export default function Statements() {
  const accountsQ = useAccounts();
  const cats = useCategories().data ?? [];
  const status = useStatementStatus();
  const importsQ = useStatementImports();
  const accounts = useMemo(() => (accountsQ.data ?? []).filter((a) => !a.archived_at), [accountsQ.data]);
  const cards = useMemo(() => accounts.filter((a) => a.kind === 'credit_card'), [accounts]);
  const banks = useMemo(() => accounts.filter((a) => a.class === 'asset' && (a.kind === 'bank' || a.kind === 'cash') && a.currency === 'TRY'), [accounts]);

  const [items, setItems] = useState<Item[]>([]);
  const [results, setResults] = useState<Record<string, ImportResult>>({});
  const [pw, setPw] = useState<Record<string, string>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const fix = (hash?: string) => {
    const imp = (importsQ.data ?? []).find((i) => i.file_hash === hash);
    if (imp) setOpenId(imp.id);
    setTimeout(() => document.getElementById('yuklenen-ekstreler')?.scrollIntoView({ behavior: 'smooth' }), 50);
  };
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
      <p className="muted">Bankadan indirdiğiniz kredi kartı ekstresini (PDF) yükleyin. Kart bilgileri, kesim ve son ödeme tarihi ile tüm kalemler ekstreden okunur; okunamayanı elle girersiniz. Dosya yalnızca tarayıcınızda okunur, başka yere gönderilmez; adres ve kimlik bilgileri kaydedilmez. Hiçbir şey siz onaylamadan işlenmez. <strong>Birden çok ekstre yüklüyorsanız eskiden yeniye doğru yükleyin.</strong></p>

      <section className="panel dropzone" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); onFiles(e.dataTransfer.files); }}>
        <p><strong>PDF ekstreleri buraya sürükleyin</strong> ya da seçin</p>
        <label className="btn btn-primary">Dosya seç<input type="file" accept="application/pdf,.pdf" multiple hidden onChange={(e) => { onFiles(e.target.files); e.target.value = ''; }} /></label>
        <p className="muted small">Desteklenen bankalar: Akbank, Enpara, Garanti BBVA, İş Bankası, QNB, VakıfBank, Yapı Kredi, Ziraat.</p>
      </section>

      {items.map((it) => {
        if (results[it.id]) {
          const r = results[it.id];
          return (
            <section key={it.id} className="panel stmt-done">
              <h2>✓ {it.file.name} işlendi</h2>
              <p>{r.added} kalem eklendi, {r.payments} ödeme/iade işlendi{r.reversed ? `, ${r.reversed} kayıt iptal edildi` : ''}, {r.skipped} kalem atlandı.</p>
              <p className="muted">Ekstre borcu {money(r.statement_debt, 'TRY')} · defterin hesapladığı {money(r.ledger_after, 'TRY')} · kalan fark <strong className={Math.abs(r.difference_after) > 1 ? 'tone-out' : 'tone-in'}>{money(r.difference_after, 'TRY', true)}</strong></p>
              <p className="muted small">{Math.abs(r.difference_after) > 1 ? 'Fark kaldı: eksik satırı ekleyin ya da yanlış rakamı düzeltin.' : 'Yanlış okunan bir rakam ya da satır varsa istediğiniz zaman düzeltebilirsiniz.'}</p>
              <button className="btn" onClick={() => fix(it.hash)}>Bu ekstreyi düzelt</button>
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
            <p className="muted small">Bu ekstre otomatik okunamadı. Kartı Hesaplar sayfasından açıp kalemleri İşlem ekle ile girebilirsiniz.</p>
            <button className="btn btn-quiet" onClick={() => setItems((xs) => xs.filter((x) => x.id !== it.id))}>Kaldır</button>
          </section>
        );
        return <Preview key={it.id} item={it} cards={cards} banks={banks} categories={cats} imports={importsQ.data ?? []}
          onDone={(r) => setResults((x) => ({ ...x, [it.id]: r }))} onRemove={() => setItems((xs) => xs.filter((x) => x.id !== it.id))} />;
      })}

      <ImportedStatements banks={banks} categories={cats} cards={cards} open={openId} setOpen={setOpenId} />

      {status.data ? <StatusTable rows={status.data} /> : status.isLoading ? <p className="muted" aria-busy="true">Yükleniyor…</p> : (
        <Empty title="Durum alınamadı">{status.error instanceof Error ? status.error.message : 'Bilinmeyen hata'} <Link to="/">Özet’e dön</Link></Empty>
      )}
    </div>
  );
}

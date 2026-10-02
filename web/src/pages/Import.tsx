import { useEffect, useMemo, useRef, useState } from 'react';
import { importTransactions, useAccounts, useCategories, useLedgerMutation } from '../lib/api';
import { supabase } from '../lib/supabase';
import { money, parseAmount, todayISO } from '../lib/format';
import {
  KIND_LABEL, buildMapping, catKey, emptyRow, parsePasted, parseSheets, problemsOf, resolveRow, toPayload,
  type ImportRow, type Mapping, type RowKind,
} from '../lib/importer/parse';
import { downloadTemplate, readWorkbook } from '../lib/importer/xlsx';
import type { AccountBalance, Category } from '../lib/types';
import { ErrorText } from '../components/ui';

const PAGE = 100;
const KINDS: RowKind[] = ['expense', 'income', 'transfer', 'payment', 'refund', 'carry'];
const CHUNK = 150;

function AccountPick({ accounts, value, onChange, empty = 'Seçin…', label }: {
  accounts: AccountBalance[]; value: string; onChange: (v: string) => void; empty?: string; label: string;
}) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{empty}</option>
      {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
    </select>
  );
}

function CatPick({ categories, kind, value, onChange, label }: {
  categories: Category[]; kind: 'income' | 'expense'; value: string; onChange: (v: string) => void; label: string;
}) {
  const act = categories.filter((c) => c.kind === kind && (!c.archived_at || c.id === value));
  const roots = act.filter((c) => !c.parent_id);
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Seçin…</option>
      {roots.map((r) => {
        const subs = act.filter((c) => c.parent_id === r.id);
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

/** Tutar kutusu: blur'da ayrıştırılır */
function Amt({ value, onCommit, label }: { value: number; onCommit: (v: number) => void; label: string }) {
  const [t, setT] = useState(value ? String(value).replace('.', ',') : '');
  useEffect(() => setT(value ? String(value).replace('.', ',') : ''), [value]);
  const commit = () => { const n = parseAmount(t); if (n === null) setT(value ? String(value).replace('.', ',') : ''); else onCommit(Math.abs(n)); };
  return <input className="amt-input" inputMode="decimal" aria-label={label} value={t} onChange={(e) => setT(e.target.value)} onBlur={commit}
    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />;
}

export default function ImportPage() {
  const accounts = (useAccounts().data ?? []).filter((a) => !a.archived_at);
  const categories = useCategories().data ?? [];
  const today = todayISO();

  const [rows, setRows] = useState<ImportRow[]>([]);
  const [mapping, setMapping] = useState<Mapping | null>(null);
  const [info, setInfo] = useState<{ formats: string[]; ignored: string[]; warnings: string[]; source: string } | null>(null);
  const [pasteText, setPasteText] = useState('');
  const [showPaste, setShowPaste] = useState(false);
  const [page, setPage] = useState(0);
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<{ added: number; existing: number; failed: { id: number; error: string }[] } | null>(null);
  const nextId = useRef(100000);
  const fileRef = useRef<HTMLInputElement>(null);

  // Hesaplar/kategoriler sonradan yüklenirse eşleşmeyenleri yeniden dene
  useEffect(() => {
    if (rows.length && accounts.length) setMapping((m) => buildMapping(rows, accounts, categories, m ?? undefined));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts.length, categories.length]);

  const load = (parsed: ReturnType<typeof parseSheets>, source: string) => {
    setRows(parsed.rows);
    setMapping(buildMapping(parsed.rows, accounts, categories));
    setInfo({ formats: parsed.formats, ignored: parsed.ignoredSheets, warnings: parsed.warnings, source });
    setPage(0); setResult(null); setOnlyProblems(false);
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null); setBusy(`${file.name} okunuyor…`);
    try {
      if (/\.(csv|txt|tsv)$/i.test(file.name)) load(parsePasted(await file.text()), file.name);
      else load(parseSheets(await readWorkbook(file)), file.name);
    } catch (e) { setError(e); } finally { setBusy(null); if (fileRef.current) fileRef.current.value = ''; }
  };

  const startBlank = () => {
    const base = Array.from({ length: 8 }, () => emptyRow(nextId.current++, today));
    setRows(base); setMapping(buildMapping(base, accounts, categories));
    setInfo({ formats: [], ignored: [], warnings: [], source: 'Hızlı giriş' }); setPage(0); setResult(null);
  };

  const update = (id: number, patch: Partial<ImportRow>) => setRows((xs) => xs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const addRow = () => setRows((xs) => {
    const last = xs[xs.length - 1];
    const r = emptyRow(nextId.current++, last?.date || today);
    if (last) { r.kind = last.kind; r.accountId = last.accountId ?? (last.account && mapping ? mapping.accounts[last.account] : undefined); }
    return [...xs, r];
  });

  const m = mapping;
  const checked = useMemo(() => rows.map((r) => {
    const res = m ? resolveRow(r, m) : { accountId: '', toAccountId: '', categoryId: '', sourceId: '' };
    return { r, res, problems: r.include && m ? problemsOf(r, res, accounts, today) : [] };
  }), [rows, m, accounts, today]);

  const ready = checked.filter((c) => c.r.include && c.problems.length === 0);
  const bad = checked.filter((c) => c.r.include && c.problems.length > 0);
  const skipped = checked.filter((c) => !c.r.include);
  const shown = (onlyProblems ? checked.filter((c) => c.problems.length) : checked);
  const pages = Math.max(1, Math.ceil(shown.length / PAGE));
  const slice = shown.slice(page * PAGE, page * PAGE + PAGE);

  const accNames = m ? Object.keys(m.accounts) : [];
  const countBy = (pick: (r: ImportRow) => string) => rows.reduce<Record<string, number>>((a, r) => { const k = pick(r); a[k] = (a[k] ?? 0) + 1; return a; }, {});
  const accCount = countBy((r) => r.account);
  const toCount = countBy((r) => r.toAccount);
  const catNames = m ? Object.keys(m.categories) : [];
  const catCount = countBy((r) => (r.kind === 'income' || r.kind === 'expense' ? catKey(r.kind, r.category) : ''));
  const needsDefaultAccount = rows.some((r) => r.include && !r.account && ['income', 'expense', 'payment', 'carry', 'refund'].includes(r.kind) && r.accountId === undefined);
  const hasPayments = rows.some((r) => r.kind === 'payment' && r.include);
  const banks = accounts.filter((a) => ['bank', 'cash', 'savings'].includes(a.kind));

  const exactCat = (key: string) => {
    const [k, ...rest] = key.split(':'); const name = rest.join(':');
    const kind = k === 'i' ? 'income' : 'expense';
    return categories.some((c) => c.kind === kind && !c.archived_at && c.name.toLocaleLowerCase('tr') === name.toLocaleLowerCase('tr')) || name === '';
  };
  const missingCats = catNames.filter((k) => !exactCat(k));

  const createMissing = useLedgerMutation(async () => {
    if (!m) return;
    const next = { ...m, categories: { ...m.categories } };
    for (const key of missingCats) {
      const [k, ...rest] = key.split(':'); const name = rest.join(':').trim();
      const { data, error: err } = await supabase.from('categories').insert({ kind: k === 'i' ? 'income' : 'expense', parent_id: null, name }).select('id').single();
      if (err) throw new Error(`“${name}” oluşturulamadı: ${err.message}`);
      next.categories[key] = data!.id as string;
    }
    setMapping(next);
  });

  const runImport = async () => {
    if (!m || ready.length === 0) return;
    setError(null); setResult(null);
    const out = { added: 0, existing: 0, failed: [] as { id: number; error: string }[] };
    try {
      for (let i = 0; i < ready.length; i += CHUNK) {
        setBusy(`İçe aktarılıyor… ${Math.min(i + CHUNK, ready.length)} / ${ready.length}`);
        const part = ready.slice(i, i + CHUNK);
        const res = await importTransactions(await toPayload(part.map((c) => c.r), m));
        out.added += res.added; out.existing += res.existing;
        const failedIds = new Set<number>();
        for (const f of res.failed) { const row = part[f.row - 1]; if (row) { failedIds.add(row.r.id); out.failed.push({ id: row.r.id, error: f.error }); } }
        setRows((xs) => xs.map((r) => (part.some((c) => c.r.id === r.id) && !failedIds.has(r.id) ? { ...r, include: false, note: 'Aktarıldı' } : r)));
      }
      setResult(out);
    } catch (e) { setError(e); } finally { setBusy(null); }
  };

  const failedMap = new Map((result?.failed ?? []).map((f) => [f.id, f.error]));

  return (
    <div className="page import-page">
      <header className="page-head"><h1>Excel / toplu giriş</h1></header>
      <p className="muted">Excel dosyasından, kopyala-yapıştırla ya da boş bir tabloya elle çok sayıda işlemi tek seferde girin. Dosya yalnızca tarayıcınızda okunur. Hiçbir şey siz onaylamadan kaydedilmez; aynı dosyayı tekrar yüklemek <strong>çift kayıt oluşturmaz</strong>.</p>

      <section className="panel">
        <div className="import-sources">
          <label className="btn btn-primary">Excel / CSV seç
            <input ref={fileRef} type="file" hidden accept=".xlsx,.csv,.tsv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => void onFile(e.target.files?.[0])} />
          </label>
          <button className="btn" onClick={() => setShowPaste((v) => !v)}>Excel’den yapıştır</button>
          <button className="btn" onClick={startBlank}>Boş tablo (hızlı giriş)</button>
          <button className="btn btn-quiet" onClick={() => void downloadTemplate()}>Şablonu indir</button>
        </div>
        <p className="muted small">Eski “KART YÖNETİMİ” Excel’iniz (İşlemler, Ödemeler, Gelir sayfaları) otomatik tanınır; diğer sayfalar yok sayılır. “DEVREDEN” satırları gider sayılmaz, tarihli devreden borç olarak eklenir.</p>
        {showPaste && (
          <div className="paste-box">
            <textarea rows={6} placeholder={'Excel’de satırları seçip kopyalayın, buraya yapıştırın.\nBaşlık satırı yoksa sütun sırası: Tarih · Tür · Hesap · Kategori · Tutar · Açıklama'}
              value={pasteText} onChange={(e) => setPasteText(e.target.value)} />
            <button className="btn btn-primary" disabled={!pasteText.trim()} onClick={() => { load(parsePasted(pasteText), 'Yapıştırılan'); setShowPaste(false); }}>Tabloya aktar</button>
          </div>
        )}
        {busy && <p aria-busy="true">{busy}</p>}
        <ErrorText error={error} />
      </section>

      {info && (
        <section className="panel">
          <h2>{info.source}</h2>
          {info.formats.map((f) => <p key={f} className="small">✓ {f}</p>)}
          {info.ignored.length > 0 && <p className="muted small">Yok sayılan sayfalar: {info.ignored.join(', ')}</p>}
          {info.warnings.map((w) => <p key={w} className="error">{w}</p>)}
        </section>
      )}

      {m && rows.length > 0 && (
        <>
          <section className="panel">
            <h2>1 · Eşleştirme</h2>
            <p className="muted small">Dosyadaki adlar sistemdeki hesap ve kategorilerle eşleştirildi. Yanlış olanı değiştirin; değişiklik o adı kullanan tüm satırlara uygulanır.</p>

            <div className="map-grid">
              {accNames.length > 0 && (
                <div>
                  <h3>Hesaplar / kartlar</h3>
                  <table className="sum-table">
                    <thead><tr><th>Dosyadaki ad</th><th className="num">Satır</th><th>Sistemdeki hesap</th></tr></thead>
                    <tbody>
                      {accNames.map((n) => (
                        <tr key={n}>
                          <td>{n}</td><td className="num">{(accCount[n] ?? 0) + (toCount[n] ?? 0)}</td>
                          <td><AccountPick accounts={accounts} label={`${n} eşleşmesi`} value={m.accounts[n] ?? ''} empty="Eşleşmedi — seçin"
                            onChange={(v) => setMapping({ ...m, accounts: { ...m.accounts, [n]: v } })} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {catNames.length > 0 && (
                <div>
                  <h3>Kategoriler {missingCats.length > 0 && <span className="tag tag-risk-warn">{missingCats.length} eşleşmedi</span>}</h3>
                  <table className="sum-table">
                    <thead><tr><th>Dosyadaki ad</th><th className="num">Satır</th><th>Sistemdeki kategori</th></tr></thead>
                    <tbody>
                      {catNames.map((k) => (
                        <tr key={k}>
                          <td>{k.slice(2) || '(boş)'} <span className="muted small">{k[0] === 'i' ? 'gelir' : 'gider'}</span></td>
                          <td className="num">{catCount[k] ?? 0}</td>
                          <td><CatPick categories={categories} kind={k[0] === 'i' ? 'income' : 'expense'} label={`${k.slice(2)} kategorisi`} value={m.categories[k] ?? ''}
                            onChange={(v) => setMapping({ ...m, categories: { ...m.categories, [k]: v } })} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {missingCats.length > 0 && (
                    <div className="stmt-actions">
                      <span className="muted small">Sistemde olmayan adlar şimdilik “Diğer”e atanır.</span>
                      <button className="btn" disabled={createMissing.isPending} onClick={() => createMissing.mutate(undefined)}>
                        {createMissing.isPending ? 'Oluşturuluyor…' : `Eksik ${missingCats.length} kategoriyi oluştur`}</button>
                    </div>
                  )}
                  <ErrorText error={createMissing.error} />
                </div>
              )}
            </div>

            {(needsDefaultAccount || hasPayments) && (
              <div className="head-grid">
                {needsDefaultAccount && (
                  <label className="stmt-field">Hesabı olmayan satırlar (ör. gelirler) hangi hesaba?
                    <AccountPick accounts={accounts.filter((a) => ['bank', 'cash', 'savings'].includes(a.kind))} label="Varsayılan hesap" value={m.defaultAccountId}
                      onChange={(v) => setMapping({ ...m, defaultAccountId: v })} /></label>
                )}
                {hasPayments && (
                  <label className="stmt-field">Kart ödemeleri hangi hesaptan çıksın?
                    <AccountPick accounts={banks} label="Ödeme kaynağı" value={m.defaultSourceId} empty="Kaynak belirsiz (banka bakiyesi değişmez)"
                      onChange={(v) => setMapping({ ...m, defaultSourceId: v })} /></label>
                )}
              </div>
            )}
          </section>

          <section className="panel">
            <h2>2 · Satırlar</h2>
            <div className="import-summary">
              <span><strong>{ready.length}</strong> aktarılacak</span>
              {bad.length > 0 && <span className="tone-out"><strong>{bad.length}</strong> sorunlu (aktarılmaz)</span>}
              {skipped.length > 0 && <span className="muted"><strong>{skipped.length}</strong> atlanacak/aktarıldı</span>}
              {ready.length > 0 && <span className="muted small">Gider {money(ready.filter((c) => c.r.kind === 'expense').reduce((a, c) => a + c.r.amount, 0), 'TRY')} · Gelir {money(ready.filter((c) => c.r.kind === 'income').reduce((a, c) => a + c.r.amount, 0), 'TRY')}</span>}
            </div>
            <div className="import-tools">
              <label className="check small"><input type="checkbox" checked={onlyProblems} onChange={(e) => { setOnlyProblems(e.target.checked); setPage(0); }} /> Yalnızca sorunlu satırları göster</label>
              {bad.length > 0 && <button className="btn btn-quiet" onClick={() => setRows((xs) => xs.map((r) => (bad.some((b) => b.r.id === r.id) ? { ...r, include: false } : r)))}>Sorunlu satırları çıkar</button>}
              <button className="btn" onClick={addRow}>+ Satır ekle</button>
            </div>

            <div className="table-wrap">
              <table className="sum-table stmt-lines import-lines">
                <thead><tr><th>Al</th><th>Tarih</th><th>Tür</th><th>Hesap</th><th>Kategori / hedef / kaynak</th><th className="num">Tutar</th><th>Taksit</th><th>Açıklama</th><th>Durum</th><th /></tr></thead>
                <tbody>
                  {slice.map(({ r, res, problems }) => {
                    const acc = accounts.find((a) => a.id === res.accountId);
                    const fail = failedMap.get(r.id);
                    return (
                      <tr key={r.id} className={problems.length || fail ? 'stmt-maybe' : r.include ? 'is-add' : 'stmt-matched'}>
                        <td><input type="checkbox" aria-label="Satırı al" checked={r.include} onChange={(e) => update(r.id, { include: e.target.checked })} /></td>
                        <td className="nowrap"><input type="date" aria-label="Tarih" value={r.date} onChange={(e) => update(r.id, { date: e.target.value })} /></td>
                        <td><select aria-label="Tür" value={r.kind} onChange={(e) => update(r.id, { kind: e.target.value as RowKind, categoryId: undefined, installments: 1 })}>
                          {KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select></td>
                        <td><AccountPick accounts={accounts} label="Hesap" value={res.accountId} empty={r.account ? `“${r.account}” — seçin` : 'Seçin…'} onChange={(v) => update(r.id, { accountId: v })} /></td>
                        <td>
                          {(r.kind === 'expense' || r.kind === 'income') && <CatPick categories={categories} kind={r.kind} label="Kategori" value={res.categoryId} onChange={(v) => update(r.id, { categoryId: v })} />}
                          {r.kind === 'transfer' && <AccountPick accounts={accounts} label="Hedef hesap" value={res.toAccountId} empty="Hedef hesap" onChange={(v) => update(r.id, { toAccountId: v })} />}
                          {r.kind === 'payment' && <AccountPick accounts={banks} label="Kaynak hesap" value={res.sourceId} empty="Kaynak belirsiz" onChange={(v) => update(r.id, { sourceId: v })} />}
                        </td>
                        <td className="num"><Amt value={r.amount} label="Tutar" onCommit={(v) => update(r.id, { amount: v })} /></td>
                        <td>{r.kind === 'expense' && acc?.kind === 'credit_card'
                          ? <input className="int-input" type="number" min={1} max={36} aria-label="Taksit" value={r.installments} onChange={(e) => update(r.id, { installments: Math.min(36, Math.max(1, Math.round(Number(e.target.value)) || 1)) })} /> : null}</td>
                        <td><input className="desc-input" aria-label="Açıklama" value={r.description} onChange={(e) => update(r.id, { description: e.target.value })} /></td>
                        <td className="small">
                          {problems.map((p) => <div key={p} className="tone-out">{p}</div>)}
                          {fail && <div className="tone-out">{fail}</div>}
                          {r.note && !problems.length && <div className="muted">{r.note}</div>}
                          {r.installments > 1 && r.include && !problems.length && <div className="muted">{r.installments} taksit × {money(r.amount / r.installments, 'TRY')}</div>}
                        </td>
                        <td><button className="btn btn-quiet" aria-label="Satırı sil" onClick={() => setRows((xs) => xs.filter((x) => x.id !== r.id))}>✕</button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {pages > 1 && (
              <div className="pager">
                <button className="btn" disabled={page === 0} onClick={() => setPage(page - 1)}>‹ Önceki</button>
                <span className="muted small">Sayfa {page + 1} / {pages} · {shown.length} satır</span>
                <button className="btn" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>Sonraki ›</button>
              </div>
            )}
          </section>

          <section className="panel">
            <h2>3 · İçe aktar</h2>
            <div className="stmt-actions">
              <div>
                <strong>{ready.length}</strong> satır kaydedilecek
                {bad.length > 0 && <div className="small tone-out">{bad.length} sorunlu satır atlanacak; düzeltince tekrar aktarın.</div>}
              </div>
              <button className="btn btn-primary" disabled={ready.length === 0 || !!busy} onClick={() => void runImport()}>{busy ? 'İşleniyor…' : `${ready.length} satırı içe aktar`}</button>
            </div>
            {result && (
              <div className="stmt-done">
                <p>✓ <strong>{result.added}</strong> işlem eklendi{result.existing > 0 && <>, <strong>{result.existing}</strong> zaten kayıtlıydı (atlandı)</>}{result.failed.length > 0 && <>, <strong className="tone-out">{result.failed.length}</strong> satır reddedildi</>}.</p>
                {result.failed.length > 0 && <p className="small muted">Reddedilen satırlar tabloda nedeniyle işaretli kaldı; düzeltip yeniden aktarabilirsiniz.</p>}
                <p className="muted small">Yanlış giren olursa İşlemler ekranından düzeltebilir ya da iptal edebilirsiniz.</p>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

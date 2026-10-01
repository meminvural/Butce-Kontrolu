import { Link } from 'react-router-dom';
import { useFinancialHealth, type HealthCheck, type HealthSeverity } from '../lib/api';
import { fmtDate, money } from '../lib/format';
import { Lbl } from '../components/Info';
import { Empty, ErrorText } from '../components/ui';

const SEV_LABEL: Record<HealthSeverity, string> = { ok: 'Sorun yok', info: 'Bilgi', warn: 'Uyarı', crit: 'Kritik' };
const SEV_RANK: Record<HealthSeverity, number> = { crit: 0, warn: 1, info: 2, ok: 3 };

/** Her kontrolün ilgili olduğu sayfa */
const GO: Record<string, [string, string]> = {
  over_limit: ['/kartlar', 'Kredi kartlarına git'],
  card_credit: ['/kartlar', 'Kredi kartlarına git'],
  statement_diff: ['/kartlar', 'Kredi kartlarına git'],
  statement_stale: ['/ekstre', 'Ekstre yükle'],
  loan_mismatch: ['/krediler', 'Kredilere git'],
  loan_overdue: ['/krediler', 'Kredilere git'],
  scheduled_overdue: ['/planli', 'Planlı ödemelere git'],
  negative_cash: ['/hesaplar', 'Hesaplara git'],
  archived_balance: ['/hesaplar', 'Hesaplara git'],
  uncategorized: ['/islemler', 'İşlemlere git'],
  possible_duplicates: ['/islemler', 'İşlemlere git'],
  future_dated: ['/islemler', 'İşlemlere git'],
};

const HIDDEN = new Set(['rn', 'entry_id']);
/** Tutar olmayan sayısal alanlar */
const PLAIN_NUMBER = new Set(['taksit_no', 'adet']);
const NAME: Record<string, string> = {
  limit_tutari: 'Limit', plan_toplami: 'Plan toplamı', kalan_ana_para: 'Kalan ana para', hesap_bakiyesi: 'Hesap bakiyesi',
  ekstre_borcu: 'Ekstre borcu', defter_borcu: 'Defter borcu', son_ekstre: 'Son ekstre', satir_para: 'Satır para birimi',
  hesap_para: 'Hesap para birimi', ana_para: 'Ana para', taksit_no: 'Taksit no', aciklama: 'Açıklama', kaynak: 'Kaynak',
};
const label = (k: string) => NAME[k] ?? k.replace(/_/g, ' ');

function cell(key: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'number') return PLAIN_NUMBER.has(key) ? String(v) : money(v, 'TRY');
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return fmtDate(v.slice(0, 10));
  return String(v);
}

function Sample({ rows }: { rows: Record<string, unknown>[] }) {
  if (!rows.length) return null;
  const cols = Object.keys(rows[0]).filter((k) => !HIDDEN.has(k));
  return (
    <div className="table-wrap">
      <table className="health-sample">
        <thead><tr>{cols.map((c) => <th key={c}>{label(c)}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{cols.map((c) => <td key={c} className={typeof r[c] === 'number' ? 'num' : undefined}>{cell(c, r[c])}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Card({ c }: { c: HealthCheck }) {
  const go = GO[c.check_key];
  return (
    <section className={`panel health-card sev-${c.severity}`}>
      <div className="health-head">
        <h3>{c.title}</h3>
        <span className={`tag tag-sev-${c.severity}`}>{SEV_LABEL[c.severity]} · {c.issue_count}</span>
      </div>
      <p className="health-hint">{c.hint}</p>
      <Sample rows={c.detail} />
      {c.issue_count > c.detail.length && <p className="muted small">İlk {c.detail.length} örnek gösteriliyor, toplam {c.issue_count} kayıt.</p>}
      {go && <p><Link to={go[0]}>{go[1]} →</Link></p>}
    </section>
  );
}

export default function Health() {
  const q = useFinancialHealth();

  if (q.isLoading) return <div className="page"><header className="page-head"><h1>Sistem sağlığı</h1></header><p className="muted" aria-busy="true">Denetim çalışıyor…</p></div>;
  if (q.error || !q.data) return <div className="page"><header className="page-head"><h1>Sistem sağlığı</h1></header><ErrorText error={q.error ?? new Error('Veri alınamadı')} /></div>;

  const checks = [...q.data].sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);
  const problems = checks.filter((c) => c.severity !== 'ok');
  const ok = checks.filter((c) => c.severity === 'ok');
  const worst: HealthSeverity = problems[0]?.severity ?? 'ok';
  const attention = problems.filter((c) => c.severity === 'crit' || c.severity === 'warn').length;

  const headline = worst === 'crit' ? 'Kritik sorun var' : worst === 'warn' ? 'İncelenmesi gerekenler var' : worst === 'info' ? 'Sorun yok, bilgilendirmeler var' : 'Her şey yolunda';
  const sub = worst === 'crit' ? 'Defterin temel kuralı bozulmuş görünüyor. Aşağıdaki kırmızı kaydı önce inceleyin.'
    : attention > 0 ? `${attention} kontrol dikkat istiyor; ${ok.length} kontrol temiz.`
    : `${checks.length} kontrolün hepsi tamam.`;

  return (
    <div className="page">
      <header className="page-head"><h1><Lbl k="health">Sistem sağlığı</Lbl></h1></header>

      <section className={`panel health-summary is-${worst}`} aria-live="polite">
        <div>
          <h2>{headline}</h2>
          <p className="muted">{sub}</p>
          <p className="muted small">Son denetim: {new Date(q.dataUpdatedAt).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })} · Bu ekran hiçbir veriyi değiştirmez.</p>
        </div>
        <button className="btn" onClick={() => void q.refetch()} disabled={q.isFetching}>{q.isFetching ? 'Denetleniyor…' : 'Yeniden denetle'}</button>
      </section>

      {problems.map((c) => <Card key={c.check_key} c={c} />)}

      <section className="panel">
        <h3>Sorunsuz kontroller ({ok.length}/{checks.length})</h3>
        {ok.length === 0 ? <p className="muted">Hepsinde bulgu var.</p> : <ul className="health-ok">{ok.map((c) => <li key={c.check_key}>{c.title}</li>)}</ul>}
      </section>

      {checks.length === 0 && <Empty title="Denetim sonucu yok" />}
    </div>
  );
}

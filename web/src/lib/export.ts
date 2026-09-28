/** Türkçe Excel uyumlu CSV: ';' ayraç, ',' ondalık, UTF-8 BOM */
export type Col<T> = { header: string; value: (row: T) => string | number | null | undefined };

const cell = (v: string | number | null | undefined) => {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'number' ? v.toLocaleString('tr-TR', { useGrouping: false, maximumFractionDigits: 8 }) : v;
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function downloadCSV<T>(fileName: string, rows: T[], cols: Col<T>[]) {
  const lines = [cols.map((c) => cell(c.header)).join(';'), ...rows.map((r) => cols.map((c) => cell(c.value(r))).join(';'))];
  const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

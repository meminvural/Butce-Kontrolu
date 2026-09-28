import { StatementError } from './types';
import type { RawItem } from './text';
import { parseStatement } from './parsers';
import { sha256Hex } from './import';
import type { ParsedStatement } from './types';

/** PDF'i tarayıcıda okur; dosya hiçbir yere gönderilmez. */
export async function readPdfPages(buf: ArrayBuffer, password?: string): Promise<RawItem[][]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const worker = (await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = worker;
  let doc;
  try {
    doc = await pdfjs.getDocument({ data: new Uint8Array(buf.slice(0)), password, useSystemFonts: true, verbosity: 0 }).promise;
  } catch (e) {
    const name = (e as { name?: string })?.name;
    if (name === 'PasswordException') throw new StatementError('PASSWORD', (e as { code?: number }).code === 2 ? 'Şifre yanlış' : 'Bu PDF şifreli');
    throw new StatementError('PARSE', 'PDF açılamadı: ' + (e instanceof Error ? e.message : String(e)));
  }
  const pages: RawItem[][] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    pages.push((tc.items as { str?: string; transform: number[]; width: number }[])
      .filter((i) => typeof i.str === 'string')
      .map((i) => ({ str: i.str as string, x: i.transform[4], y: i.transform[5], w: i.width })));
  }
  return pages;
}

export async function readStatementFile(file: File, password?: string): Promise<{ hash: string; statement: ParsedStatement }> {
  const buf = await file.arrayBuffer();
  const hash = await sha256Hex(buf);
  const pages = await readPdfPages(buf, password);
  return { hash, statement: parseStatement(pages) };
}

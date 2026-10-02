import readXlsxFile, { readSheetNames } from 'read-excel-file';
import writeXlsxFile from 'write-excel-file';
import type { SheetData } from './parse';

/** Excel dosyasının tüm sayfalarını okur (tarayıcıda; dosya hiçbir yere gönderilmez) */
export async function readWorkbook(file: File): Promise<SheetData[]> {
  const names = await readSheetNames(file);
  const out: SheetData[] = [];
  for (const name of names) out.push({ name, rows: (await readXlsxFile(file, { sheet: name })) as unknown[][] });
  return out;
}

/** Boş içe aktarma şablonu */
export async function downloadTemplate() {
  const head = ['Tarih', 'Tür', 'Hesap', 'Hedef Hesap', 'Kategori', 'Tutar', 'Açıklama', 'Taksit'].map((v) => ({ value: v, fontWeight: 'bold' as const }));
  const sample = [
    [{ value: new Date(Date.UTC(2026, 8, 1)), type: Date, format: 'dd.mm.yyyy' }, { value: 'Gider' }, { value: 'Ziraat' }, { value: '' }, { value: 'Market' }, { value: 450.5, type: Number }, { value: 'Haftalık market' }, { value: 1, type: Number }],
    [{ value: new Date(Date.UTC(2026, 8, 2)), type: Date, format: 'dd.mm.yyyy' }, { value: 'Gelir' }, { value: 'Ziraat' }, { value: '' }, { value: 'Maaş' }, { value: 30000, type: Number }, { value: 'Eylül maaşı' }, { value: 1, type: Number }],
    [{ value: new Date(Date.UTC(2026, 8, 3)), type: Date, format: 'dd.mm.yyyy' }, { value: 'Transfer' }, { value: 'Ziraat' }, { value: 'Nakit TL' }, { value: '' }, { value: 500, type: Number }, { value: 'ATM' }, { value: 1, type: Number }],
    [{ value: new Date(Date.UTC(2026, 8, 4)), type: Date, format: 'dd.mm.yyyy' }, { value: 'Gider' }, { value: 'AK_Axess' }, { value: '' }, { value: 'Elektronik' }, { value: 12000, type: Number }, { value: 'Telefon (taksitli)' }, { value: 6, type: Number }],
    [{ value: new Date(Date.UTC(2026, 8, 5)), type: Date, format: 'dd.mm.yyyy' }, { value: 'Kart ödemesi' }, { value: 'AK_Axess' }, { value: '' }, { value: '' }, { value: 3000, type: Number }, { value: 'Ekstre ödemesi' }, { value: 1, type: Number }],
  ];
  const help = [
    ['Sütun', 'Açıklama'], ['Tarih', 'gg.aa.yyyy veya yyyy-aa-gg'],
    ['Tür', 'Gider · Gelir · Transfer · Kart ödemesi · Kart iadesi'],
    ['Hesap', 'Paranın çıktığı/girdiği hesap ya da kart adı (sistemdeki adla aynı olursa otomatik eşleşir)'],
    ['Hedef Hesap', 'Yalnızca Transfer için'], ['Kategori', 'Gider ve Gelir için'],
    ['Tutar', 'Her zaman pozitif yazın; yönü Tür belirler. Taksitli alışverişte TOPLAM tutar'],
    ['Taksit', 'Yalnızca kredi kartı gideri için taksit sayısı (1–36)'],
  ].map((r, i) => r.map((v) => ({ value: v, fontWeight: i === 0 ? ('bold' as const) : undefined })));
  await writeXlsxFile([[head, ...sample] as never, help as never], { sheets: ['İşlemler', 'Açıklama'], fileName: 'butce-islem-sablonu.xlsx' } as never);
}

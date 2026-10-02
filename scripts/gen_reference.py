#!/usr/bin/env python3
"""
docs/SYSTEM_REFERENCE.md üreticisi.

Tablolar, sütunlar, görünümler, fonksiyon imzaları, yetkiler, politikalar, tetikleyiciler, rotalar, sayfalar,
migration'lar ve test sayıları KODDAN/ŞEMADAN okunur (elle yazılmaz). Yalnızca fonksiyon açıklamaları aşağıdaki
sözlüktedir; sözlükte olmayan bir fonksiyon belgede "(açıklama eklenmemiş)" diye işaretlenir.

Kullanım:
  psql -X -q -d <migration'ları uygulanmış veritabanı> -f scripts/schema_dump.sql > /tmp/schema.out
  python3 scripts/gen_reference.py --dump /tmp/schema.out > docs/SYSTEM_REFERENCE.md
"""
import argparse, datetime, glob, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# --------------------------------------------------------------------------------------------
#  Fonksiyon açıklamaları (kaynak kod ve testlerden doğrulanmış davranışlar)
# --------------------------------------------------------------------------------------------
API_DESC = {
    'create_account': 'Hesap açar. Kredi kartı için kesim ve son ödeme günü, borç/alacak hesabı için kişi/kurum adı zorunlu; sistem hesabı elle açılamaz. Açılış bakiyesi özkaynak hesabı karşısında kaydedilir.',
    'record_income': 'Gelir kaydı (hesap + gelir kategorisi). Aynı `p_idempotency_key` tekrar gelirse mevcut kaydı döndürür.',
    'record_expense': 'Gider kaydı (banka, nakit, kart, ek hesap). Kartla harcama GİDER yazılır, kart ödemesi transferdir. `p_installments > 1` ise gider alışveriş gününde TAM tutarla yazılır, kart ekstrelerine dilimler halinde yansır.',
    'record_transfer': 'Hesaplar arası transfer (gelir/gider değildir). Kayıt türü hesap türlerinden otomatik belirlenir (kart ödemesi, borç ödeme, döviz bozdurma vb.). Farklı para biriminde `p_to_amount` girilir.',
    'record_split_expense': 'Tek harcamayı birden çok kategoriye böler (`p_lines` jsonb).',
    'adjust_balance': 'Bakiye düzeltme (mutabakat): bankadaki gerçek bakiye ile sistem uyuşmuyorsa farkı kayıt altına alır.',
    'reverse_entry': 'Kaydı iptal eder: ters kayıt oluşturur (kayıtlar silinemez). İlgili kredi taksiti ve planlı kalemleri de geri açar.',
    'update_entry_description': 'Yalnızca kaydın açıklamasını günceller; tutar ve satırlar değişmez.',
    'card_statements': 'Kartın ekstreleri; ilk satır içinde bulunulan (henüz kesilmemiş) dönemdir. Geçmiş dönem için yüklenmiş gerçek ekstre varsa onun tutarını/asgarisini/son ödemesini, yoksa defterden hesaplananı kullanır.',
    'card_overview': 'Her kart için borç, kullanılabilir limit, son ekstre durumu, sonraki kesim ve faturalanmamış taksitler.',
    'card_installment_slices': 'Kartın taksitli alışverişlerinin dilimleri (kaçıncı taksit, faturalama tarihi, tutar).',
    'create_installment_plan': 'Karta toplam tutar, taksit sayısı ve ilk faturalama tarihiyle taksit planı ekler.',
    'create_loan': 'Kredi hesabını ve taksit planını (anapara/faiz/vergi) oluşturur. `p_paid_installments` kadar taksit "dışarıda ödenmiş" sayılır; `p_disburse_to_account_id` verilirse kullandırılan tutar o hesaba geçer.',
    'pay_loan_installment': 'Kredi taksidini seçilen hesaptan öder; anapara, faiz ve vergi ayrı satırlara yazılır. İdempotency anahtarı destekler.',
    'realize_scheduled_item': 'Planlı kalemi gerçekleştirir (hesap, tutar ve tarih değiştirilebilir). Zaten işlenmiş kalem, hesapsız veya kategorisiz gerçekleştirme hata verir.',
    'materialize_recurring': 'Düzenli kurallardan önümüzdeki `p_days` gün için planlı kalem üretir. Tekrar çalıştırmak güvenlidir.',
    'upcoming_items': 'Yaklaşan ödeme ve tahsilatlar (kart ekstresi, kredi taksidi, planlı kalemler…) vade sırasıyla; `overdue` bayrağıyla.',
    'notifications': 'Bildirim listesi: vadesi geçmiş → `critical`, 2 gün içinde → `warning`.',
    'budget_status': 'Ay için kategori bütçesi, gerçekleşen, kalan, yüzde ve seviye (`level`).',
    'copy_budgets': 'Bir ayın bütçelerini başka aya kopyalar; kopyalanan satır sayısını döner.',
    'net_worth_history': 'Her ay sonu için varlık, alacak, borç ve net varlık. Defter olduğu için her tarih yeniden kurulur.',
    'net_position_in_base': 'Para birimi bazında net pozisyon ve baz para birimine çevrilmiş net değer.',
    'fx_rate': 'İki para birimi arası kur: doğrudan, ters veya USD üzerinden çapraz.',
    'debt_service_outlook': 'Önümüzdeki aylar için kaynak bazında (kredi taksidi, kart…) borç servisi tahmini.',
    'import_card_statement': 'Ekstre içe aktarma (ATOMİK: hepsi ya da hiçbiri). `action=add` kalemleri `_statement_entry` ile deftere yazar: harcama/taksit/faiz/ücret gider olur, ödeme kaynak hesaptan transfer (kaynak yoksa "kaynak belirsiz"), iade kart kredisi olur. Taksitli kalem "kalan taksitler" planı olarak yazılır (geçmiş dilimler ekstrenin önceki bakiyesindedir). `reverse_entries` tahmini kayıtları iptal eder, istenirse kart profilini günceller, ekstre özetini ve satırları `card_statement_imports`a kaydeder. Aynı dosya ikinci kez yüklenemez; `replace=true` üzerine yazar.',
    'amend_statement_line': 'Yüklenmiş ekstrede satır düzeltir. `op=edit` alanları değiştirir (eski defter kaydı iptal edilir, yenisi yazılır; `include` true/false ile atlanmış satır deftere alınır ya da defterden çıkarılır), `op=add` manuel satır ekler ve deftere yazar, `op=remove` satırı çıkarır (kaydı iptal eder). Satır numaraları asla yeniden kullanılmaz. Dönüş: defterin yeni tutarı ve ekstreyle farkı.',
    'update_statement': 'Yüklenmiş ekstrenin başlığını düzeltir: kesim/son ödeme/dönem başı tarihi, dönem borcu, asgari ödeme, önceki bakiye, limit. İstenirse kartın limit, kesim günü ve son ödeme gününü de günceller. Dönüş: defter ↔ ekstre farkı.',
    'delete_statement': 'Ekstre kaydını siler; `p_reverse=true` ise ekstrenin deftere eklediği kayıtlar da iptal edilir (kart borcu ekstre öncesine döner). Defter kaydı hiçbir zaman silinmez.',
    'amend_entry': 'İşlemi düzeltir (tarih, tutar, açıklama; gelir/gider/kart harcamasında hesap ve kategori; transfer/kart ödemesinde çıkan-giren hesap). Eski kayıt İPTAL edilir, doğrusu yazılır; ekler yeni kayda taşınır. Ekstreden gelen, taksitli, bölünmüş, kredi taksidine/planlı kaleme bağlı kayıtlar reddedilir (ilgili ekrandan düzeltilir ya da iptal edilir).',
    'update_account': 'Hesap adı, kurum, son 4 hane, limit (kart/ek hesap), kesim günü, son ödeme günü ve asgari ödeme oranını günceller. Tür ve para birimi değişmez.',
    'set_opening_balance': 'Açılış / devreden bakiyeyi düzeltir: eski açılış kaydı iptal edilir, yenisi yazılır (borç hesaplarında tutar borçtur). 0 verilirse açılış kaldırılır.',
    'card_debt_plan': 'Otomatik borç hesabı: her kredi kartı için son kesilmiş ekstre, asgari, ödenen, kalan, vade, faiz kademesi ve tahmini aylık faiz (sadece asgari ödenirse / hiç ödenmezse). Tahmindir; bankanın ekstresi esastır.',
    'autopay_pending': 'Otomatik ödemesi açık kartlarda bekleyen ödemeler: tutar (asgari / ekstre tamamı / sabit), kaynak hesap, ödeme günü (son ödeme − N gün), zamanı gelip gelmediği. Aynı ekstre için yapılmış ödeme listelenmez.',
    'apply_autopay': 'Bekleyen otomatik ödemeyi kaydeder (kaynak hesaptan karta transfer). Aynı ekstre için ikinci kez kayıt oluşmaz (`autopay:<kart>:<kesim>:<tür>` anahtarı).',
    'process_autopay': '"Otomatik kaydet" seçili kartlarda zamanı gelen ödemeleri kaydeder; hatalı olanı atlayıp rapora yazar. Uygulama açılışında çağrılır; zamanlanmış görev de kullanabilir.',
    'set_card_automation': 'Kartın asgari ödeme (elle oran ya da limite göre otomatik) ve otomatik ödeme (kapalı/asgari/tamamı/sabit, kaynak hesap, kaç gün önce, onaylı/otomatik) ayarlarını yazar; kaynak hesap ve para birimini doğrular.',
    'apply_min_payment_rule': 'Asgari ödeme kuralı (limit eşiği ve oranlar) değişince "limite göre otomatik" seçili kartların oranını yeniden hesaplar.',
    'rate_tier_for': 'Çağıranın kendi faiz kademesinden, verilen ekstre borcu için aylık akdi ve gecikme faizi oranı. Kademe girilmemişse varsayılanlar kullanılır.',
    'import_transactions': 'Toplu içe aktarma (Excel / yapıştırma / hızlı giriş). Satır başına ayrı denenir: hatalı satır diğerlerini engellemez, rapora yazılır. Türler: gider (taksitli dahil), gelir, transfer, kart ödemesi, kart iadesi, devreden borç (gider sayılmayan tarihli açılış kaydı). Aynı `key` ikinci kez eklenmez, böylece aynı dosya tekrar yüklenince çift kayıt oluşmaz.',
    'statement_status': 'Her kart için son ekstre durumu: kesim, borç, asgari, güncellik (`is_stale`), defterin hesapladığı borç ve fark.',
    'statement_reconcile': 'Önizleme için defterin verilen kesimdeki durumu: kart borcu (`owed`), faturalanmamış taksit (`unbilled`), ekstreye karşılık gelen tutar (`derived`).',
    'financial_health': 'Defter bütünlüğü ve kart/kredi/ekstre tutarlılığı denetimi (16 kontrol). Salt okunur; her kontrol için ciddiyet (`ok/info/warn/crit`), sorun sayısı, ilk 5 örnek ve öneri döner.',
    'account_class_of': 'Hesap türünden sınıfı (`asset/liability/system`) döndürür.',
    'seed_default_categories': 'Kullanıcıya varsayılan kategori ağacını ekler (sistem içi; kullanıcıya açık değil).',
    'handle_new_user': 'Yeni kullanıcı kaydında profil ve varsayılan kategorileri oluşturur (tetikleyici).',
}
INTERNAL_DESC = {
    '_rate_tier': 'Kullanıcının faiz kademesinden (yoksa varsayılandan) verilen tutar için akdi ve gecikme faizi oranı.',
    '_min_pct_rule': 'Kart limitine göre otomatik asgari ödeme oranı: eşik ve altı düşük oran, üstü yüksek oran (profil ayarları).',
    'run_autopay_all': 'Zamanlanmış görev için (API\'ye kapalı): "otomatik kaydet" seçili kartı olan her kullanıcı adına `process_autopay` çalıştırır.',
    '_statement_entry': 'Tek ekstre satırından defter kaydı üretir (içe aktarma ve satır düzeltme aynı kodu kullanır). Yönü `kind` belirler: ödeme/iade borcu azaltır, diğerleri artırır.',
    '_entry_open': 'Kaydın iptal edilebilir durumda (yayınlanmış, ters kayıt değil) olup olmadığı.',
    '_statement_line_json': 'Ekstre satırını saklanacak biçime getirir (tutar işareti türden gelir: ödeme/iade eksi).',
    '_uid': 'Giriş yapmış kullanıcının kimliği.',
    '_today': "Kullanıcının saat dilimine göre bugün (profil yoksa Europe/Istanbul).",
    '_check_amount': 'Tutar doğrulaması.',
    '_check_date': 'Tarihi doğrular; gelecek tarihli işlemi reddeder ("planlı işlem olarak ekleyin").',
    '_owned_account': 'Hesabın bu kullanıcıya ait olduğunu doğrular.',
    '_owned_category': 'Kategorinin bu kullanıcıya ait ve beklenen türde olduğunu doğrular.',
    '_existing_entry': 'İdempotency anahtarıyla daha önce yazılmış kaydı bulur.',
    '_system_account': 'Özkaynak / kur çevrim gibi sistem hesabını bulur, yoksa oluşturur.',
    '_new_entry': 'Yeni defter kaydı başlığı açar.',
    '_post': 'Kayda bir satır (posting) ekler.',
    '_transfer_kind': 'Transferin kayıt türünü hesap türlerinden belirler.',
    '_card_owed_at': 'Verilen tarihe kadar kart borcu.',
    '_card_unbilled_after': 'Verilen kesimden sonra faturalanacak taksit dilimleri toplamı.',
    '_card_derived_statement': 'Ekstreye karşılık gelen defter tutarı = kart borcu − kesim sonrası faturalanacak taksitler.',
    '_card_dues': 'Karttaki ekstre vadeleri ve tutarları (yaklaşan ödemeler için).',
    '_day_in_month': 'Ayın son gününü aşmadan gün hesabı.',
    '_add_months': 'Ay ekler; kesim günü sabit kalır.',
    '_next_cut': 'Sonraki hesap kesim tarihi.',
    '_due_after': 'Kesimden sonraki son ödeme tarihi.',
    '_fx_direct': 'İki para birimi arasında doğrudan kayıtlı kur.',
}
TRIGGER_DESC = {
    '_acc_limit_changed': 'Tetikleyici işlevi: kart limiti değişince otomatik asgari ödeme oranını yeniden hesaplatır.',
    '_ccd_min_auto': 'Tetikleyici işlevi: "limite göre otomatik" seçili kartın asgari ödeme oranını kuraldan yazar.',
    'ccd_min_auto': 'Otomatik asgari ödeme seçili kartta oranı limit kuralından yazar.',
    'accounts_limit_min_auto': 'Limit değişince otomatik asgari ödeme oranını yeniden hesaplatır.',
    '_validate_posting': 'Satırın kayda/hesaba/kullanıcıya uygunluğunu, para birimi uyumunu ve arşivli hesap kullanılmamasını doğrular.',
    '_check_entry_balanced': 'Her kayıt, her para biriminde 0\'a kapanmalı. İşlem sonunda (DEFERRED) kontrol edilir; yarım kayıt reddedilir.',
    '_check_account_limits': 'Nakit bakiyesi eksiye düşemez; kart/ek hesap limiti aşılamaz.',
    '_forbid_posting_change': 'Satırlar güncellenemez ve silinemez.',
    '_guard_entry_change': 'Kayıtlar silinemez (iptal için `reverse_entry`); tarih ve tür değiştirilemez; durum geçişlerini denetler.',
    '_guard_account_change': 'Hareket görmüş hesabın türü veya para birimi değiştirilemez.',
    '_validate_category': 'Kategoriler en fazla iki seviyeli; alt kategori ana kategoriyle aynı türde olmalı.',
    '_audit': 'Değişiklikleri `audit_log` tablosuna yazar.',
    '_recurring_changed': 'Düzenli kural değişince/silinince ilgili planlanmış (`planned`) kalemleri temizler.',
    '_validate_recurring': 'Düzenli kural tutarlılığı: gelir/gider için kategori, transfer için hedef hesap zorunlu.',
    'handle_new_user': 'Yeni kullanıcı için profil ve varsayılan kategoriler.',
}


def section(dump, name):
    m = re.search(r'^##%s\n(.*?)(?=^##|\Z)' % name, dump, re.S | re.M)
    return [l for l in m.group(1).split('\n') if l.strip()] if m else []


def split_args(a):
    out, depth, cur = [], 0, ''
    for ch in a:
        if ch in '([': depth += 1
        if ch in ')]': depth -= 1
        if ch == ',' and depth == 0: out.append(cur.strip()); cur = ''
        else: cur += ch
    if cur.strip(): out.append(cur.strip())
    return out


def short_sig(args):
    names = []
    for p in split_args(args):
        p = re.sub(r'\s+DEFAULT\s+.*$', '', p).replace('IN ', '').replace('OUT ', '')
        names.append(p.split(' ')[0])
    return ', '.join(names)


def count_tests(path):
    return len(re.findall(r'^select pg_temp\.(?:eq|eqt|must_fail)\(', open(path).read(), re.M))


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--dump', required=True); a = ap.parse_args()
    dump = open(a.dump).read()
    out = []
    w = out.append

    enums = section(dump, 'ENUMS'); tables = section(dump, 'TABLES'); views = section(dump, 'VIEWS')
    funcs = section(dump, 'FUNCS'); pols = section(dump, 'POLICIES'); trgs = section(dump, 'TRIGGERS')

    # --- rotalar ve sayfalar (koddan)
    app = open(f'{ROOT}/web/src/App.tsx').read()
    layout = open(f'{ROOT}/web/src/components/Layout.tsx').read()
    labels = dict(re.findall(r"\{ to: '(/[^']*)', label: '([^']+)'", layout))
    routes = re.findall(r'<Route path="([^"*]+)" element=\{page\(<(\w+) />\)\}', app)
    routes = [('/' + p, c) for p, c in routes]
    if re.search(r'<Route index element=\{page\(<(\w+) />\)\}', app):
        routes.insert(0, ('/', re.search(r'<Route index element=\{page\(<(\w+) />\)\}', app).group(1)))

    migs = sorted(glob.glob(f'{ROOT}/supabase/migrations/*.sql'))
    tests = {os.path.basename(t): count_tests(t) for t in sorted(glob.glob(f'{ROOT}/supabase/tests/*_tests.sql'))}

    w('# Bütçe Defteri — Sistem Referansı\n')
    w(f'> **Bu belge otomatik üretilir** (`scripts/gen_reference.py`) — tablolar, fonksiyonlar, yetkiler, rotalar, migration ve test sayıları koddan okunur; elle düzenlemeyin.  ')
    w(f'> Üretim tarihi: {datetime.date.today().isoformat()} · Migration: **{len(migs)}** · Test: **{sum(tests.values())}** · Sayfa: **{len(routes)}**\n')
    w('Üretmek için: `psql -X -q -d <db> -f scripts/schema_dump.sql > /tmp/schema.out && python3 scripts/gen_reference.py --dump /tmp/schema.out > docs/SYSTEM_REFERENCE.md`\n')

    w('## 1. Mimari özet\n')
    w('```\nTarayıcı (React + TypeScript, Vite)\n  ├─ GitHub Pages  ← .github/workflows/pages.yml (main\'e her push)\n  └─ Supabase (PostgreSQL + Auth + Storage)\n       ├─ Defter: journal_entries + postings (çift kayıt)\n       ├─ Yazma: yalnızca RPC fonksiyonları (security definer); tablolara doğrudan yazma yok\n       └─ Okuma: görünümler (security_invoker) + RLS\n```')
    w('- **Bakiyeler saklanmaz, hesaplanır** (`v_account_balances`).')
    w('- **Her kayıt dengeli olmalı** (her para biriminde Σ = 0) — veritabanı tetikleyicisi zorlar.')
    w('- **Kayıt silinmez, iptal edilir** (`reverse_entry`); satırlar değiştirilemez.')
    w('- **Gelecek tarihli işlem deftere yazılamaz**; gelecek ödemeler `scheduled_items`/`recurring_rules`ta tutulur.')
    w('- **İdempotency:** yazan fonksiyonlar `p_idempotency_key` alır; `(user_id, idempotency_key)` tekil indeksi çift kaydı engeller.')
    w('- **Herkese açık değerler:** Supabase adresi ve `publishable` anahtar tarayıcıya zaten gider; veri güvenliği RLS ile sağlanır. Depo herkese açık olduğundan gizli anahtar asla depoya konmaz.\n')

    w('## 2. Enum türleri\n')
    for l in enums:
        n, v = l.split(': ', 1); w(f'- `{n}`: {v.replace(" | ", " · ")}')
    w('')

    w(f'## 3. Tablolar ({len(tables)})\n')
    w('| Tablo | RLS | Sütunlar |\n|---|---|---|')
    for l in tables:
        m = re.match(r'(\w+) \((RLS|RLS YOK)\): (.*)', l)
        cols = ', '.join(f'`{c.split(" ")[0]}`' for c in m.group(3).split(', '))
        w(f'| `{m.group(1)}` | {"✓" if m.group(2) == "RLS" else "**YOK**"} | {cols} |')
    w('')

    w(f'## 4. Görünümler ({len(views)})\n\nHepsi `security_invoker`; RLS çağıran kullanıcıya uygulanır.\n')
    for l in views:
        n, c = l.split(': ', 1); w(f'- **`{n}`** — {c}')
    w('')

    parsed = []
    for l in funcs:
        m = re.match(r'(\w+)\((.*)\) -> (.*) \| (definer|invoker) \| auth=(\w+) anon=(\w+) \| (fn|trigger)$', l)
        if m: parsed.append(m.groups())
    api = [f for f in parsed if f[6] == 'fn' and not f[0].startswith('_') and f[4] == 'true']
    system_fns = [f for f in parsed if f[6] == 'fn' and not f[0].startswith('_') and f[4] != 'true']
    internal = [f for f in parsed if f[6] == 'fn' and f[0].startswith('_')]
    trig = [f for f in parsed if f[6] == 'trigger']

    w(f'## 5. Fonksiyonlar\n')
    w(f'### 5.1 Uygulama API\'si ({len(api)}) — çağıran: giriş yapmış kullanıcı (`authenticated`)\n')
    w('| Fonksiyon | Parametreler | Döner | Çalışma | Açıklama |\n|---|---|---|---|---|')
    for n, args, res, sec, au, an, _ in api:
        d = API_DESC.get(n, '*(açıklama eklenmemiş)*')
        res = res.replace('|', '\\|')
        w(f'| `{n}` | `{short_sig(args)}` | `{res[:70]}{"…" if len(res) > 70 else ""}` | {sec} | {d} |')
    w('')
    bad = [n for n, _, _, _, au, an, _ in api if an == 'true']
    w(f'**Anonim erişim:** {"yok — hiçbir API fonksiyonu `anon` role açık değil." if not bad else "UYARI: şu fonksiyonlar anonim role açık: " + ", ".join(bad)}\n')

    if system_fns:
        w('Kullanıcıya açık olmayan sistem fonksiyonları: ' + ', '.join(f'`{f[0]}`' for f in system_fns) + '.\n')
    w(f'### 5.2 İç yardımcılar ({len(internal)})\n')
    w('| Fonksiyon | Açıklama |\n|---|---|')
    for n, *_ in internal: w(f'| `{n}` | {INTERNAL_DESC.get(n, "*(açıklama eklenmemiş)*")} |')
    w('')
    w(f'### 5.3 Tetikleyici fonksiyonları ({len(trig)})\n')
    w('| Fonksiyon | Görev |\n|---|---|')
    for n, *_ in trig: w(f'| `{n}` | {TRIGGER_DESC.get(n, "*(açıklama eklenmemiş)*")} |')
    w('')
    w(f'### 5.4 Tetikleyiciler ({len(trgs)})\n')
    for l in trgs: t, nme, ev, tm = l.split(' / '); w(f'- `{t}` · `{nme}` · {tm} {ev}')
    w('')

    w(f'## 6. Satır güvenliği (RLS) politikaları ({len(pols)})\n')
    for l in pols: t, p, c = l.split(' / '); w(f'- `{t}` · `{p}` · {c}')
    w('\nDepolama (Storage) politikaları `0007_storage_attachments` ile ayrıca kurulur (Supabase panelinde çalıştırılır).\n')

    w(f'## 7. Uygulama sayfaları ({len(routes)})\n')
    w('| Rota | Bileşen | Menü adı |\n|---|---|---|')
    for r, c in routes: w(f'| `{r}` | `{c}.tsx` | {labels.get(r, "—")} |')
    w('')

    w('## 8. Ekstre okuyucu (`web/src/lib/statements/`)\n')
    w('Tarayıcıda çalışır; PDF dışarı gönderilmez.\n')
    w('| Dosya | Görev |\n|---|---|')
    for f, d in [('types.ts', 'Tipler: banka, satır türü, ayrıştırılmış ekstre, hata sınıfı'),
                 ('text.ts', 'PDF metin öğelerinden satır/hücre kurma, EBCDIC çözme (Akbank), tutar ve tarih ayrıştırma'),
                 ('parsers.ts', 'Sekiz banka ayrıştırıcısı (Akbank, Enpara, Garanti, İş Bankası, QNB, VakıfBank, Yapı Kredi, Ziraat), banka tespiti, ortak doğrulamalar (`checks`)'),
                 ('match.ts', 'Ekstre satırlarını defter kayıtlarıyla eşleştirir (tutar + tarih + açıklama puanı; ≥5 eşleşti, ≥3,5 olası, altı yeni); kategori önerisi'),
                 ('import.ts', 'Varsayılan kararlar, dosya SHA-256, `import_card_statement` yükü'),
                 ('pdf.ts', 'pdf.js ile tarayıcıda okuma (şifreli PDF desteği)')]:
        ok = os.path.exists(f'{ROOT}/web/src/lib/statements/{f}')
        w(f'| `{f}` | {d}{"" if ok else " **(DOSYA YOK)**"} |')
    w('')

    w(f'## 9. Migration\'lar ({len(migs)})\n')
    w('| Dosya | Başlık |\n|---|---|')
    for m in migs:
        head = open(m).read().split('\n')[:6]
        title = next((re.sub(r'^--\s*', '', l).strip() for l in head if re.search(r'\d{4}\s*·', l)), os.path.basename(m))
        w(f'| `{os.path.basename(m)}` | {title} |')
    w('\nSıra önemlidir. `0005` (enum) ayrı işlem olarak uygulanmadan `0006` çalışmaz. `0007` Supabase Storage\'a özeldir (yerel testte atlanır).\n')

    w(f'## 10. Testler (toplam {sum(tests.values())})\n')
    w('| Dosya | Test |\n|---|---|')
    for t, n in tests.items(): w(f'| `{t}` | {n} |')
    w('\n```bash\ncreatedb butce\npsql -d butce -f supabase/tests/_supabase_shim.sql\nfor f in supabase/migrations/*.sql; do case $f in *0007*) continue;; esac; psql -v ON_ERROR_STOP=1 -d butce -f $f; done\nfor t in ledger_tests phases_tests health_tests; do psql -d butce -v ON_ERROR_STOP=1 -f supabase/tests/$t.sql; done\n```\n')

    w('## 11. Yayın\n')
    w('1. Değişiklikler GitHub `main` dalına gönderilir.')
    w('2. `.github/workflows/pages.yml` derler (`VITE_BASE=/Butce-Kontrolu/`) ve GitHub Pages\'e yayınlar; `404.html`, `index.html`in kopyasıdır (sayfa yenileme için).')
    w('3. Veritabanı değişiklikleri Supabase\'e migration olarak uygulanır; dosya ayrıca depoda tutulur.')
    w('4. `netlify.toml` eski Netlify yayını içindir; Pages kullanılırken devre dışı bırakılabilir.\n')
    sys.stdout.write('\n'.join(out) + '\n')


if __name__ == '__main__':
    main()

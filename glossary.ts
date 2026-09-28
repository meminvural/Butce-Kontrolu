/**
 * Tanım sözlüğü — bilgi (ⓘ) balonları ve Raporlar > Sözlük sekmesi bu tek listeyi kullanır.
 * Bir tanım değişince her yerde birlikte güncellenir.
 */
export interface Term {
  title: string;
  /** Ne demek? */
  what: string;
  /** Nasıl hesaplanır? */
  formula?: string;
  /** Nasıl okunmalı / neye dikkat edilmeli? */
  read?: string;
  group: 'Genel durum' | 'Gelir ve gider' | 'Borç ve kartlar' | 'Analiz';
}

export const GLOSSARY = {
  net_worth: {
    group: 'Genel durum', title: 'Net varlık',
    what: 'Sahip olduklarınız ile borçlarınız arasındaki fark; bugün her şeyi kapatsanız elinizde kalacak tutar.',
    formula: 'Varlık + Alacak − Borç',
    read: 'Eksi ise borçlarınız varlığınızdan büyüktür. Zaman içinde yükselmesi hedeftir.',
  },
  assets: {
    group: 'Genel durum', title: 'Toplam varlık',
    what: 'Banka, nakit, birikim, yatırım hesapları ile araç, altın gibi varlıkların bugünkü değeri. Alacaklar ayrı gösterilir.',
    formula: 'Banka + Nakit + Birikim + Yatırım + Fiziksel varlık',
  },
  receivables: {
    group: 'Genel durum', title: 'Alacak',
    what: 'Başkalarından geri almayı beklediğiniz tutarlar (örn. borç verdiğiniz kişiler).',
    read: 'Tahsil edilene kadar net varlığa dahildir; tahsil edilince banka hesabına geçer.',
  },
  liabilities: {
    group: 'Borç ve kartlar', title: 'Toplam borç',
    what: 'Kredi kartı, ek hesap (avans), banka kredisi ve kişisel borçlarınızın bugünkü toplamı.',
    formula: 'Kart borcu + Ek hesap + Kredi kalan anapara + Kişisel borç',
    read: 'Kredi için yalnızca kalan anapara sayılır; ileride ödeyeceğiniz faiz dahil değildir.',
  },
  liquid: {
    group: 'Genel durum', title: 'Nakit ve banka',
    what: 'Hemen kullanabileceğiniz para: vadesiz banka hesapları, nakit ve birikim hesapları.',
  },
  income: {
    group: 'Gelir ve gider', title: 'Gelir',
    what: 'Seçili dönemde gerçekleşen gelirler (maaş, prim, kira geliri vb.).',
    read: 'Transferler, kart ödemeleri ve alacak tahsilatları gelir sayılmaz; yalnızca gelir kategorisine yazılan kayıtlar toplanır.',
  },
  expense: {
    group: 'Gelir ve gider', title: 'Gider',
    what: 'Seçili dönemde yapılan tüm harcamalar; faiz ve masraflar dahil.',
    read: 'Kartla yapılan alışveriş, alışveriş gününde gider olur. Kart borcunu ödemek ikinci kez gider yazılmaz.',
  },
  operating_expense: {
    group: 'Gelir ve gider', title: 'Harcama (faiz hariç)',
    what: 'Faiz ve masraflar çıkarıldıktan sonra kalan, yaşam ve tüketim harcamalarınız.',
    formula: 'Gider − Finansal maliyet',
    read: 'Harcama alışkanlığınızı faizden bağımsız görmek için kullanılır.',
  },
  net_flow: {
    group: 'Gelir ve gider', title: 'Net nakit akışı',
    what: 'Dönemde kazandığınız ile harcadığınız arasındaki fark.',
    formula: 'Gelir − Gider',
    read: 'Eksi ise bu dönemde kazandığınızdan fazla harcadınız (farkı borçla veya birikimle karşıladınız).',
  },
  savings_rate: {
    group: 'Gelir ve gider', title: 'Tasarruf oranı',
    what: 'Gelirin ne kadarının harcanmayıp kaldığı.',
    formula: '(Gelir − Gider) ÷ Gelir × 100',
    read: 'Gelir kaydı yoksa hesaplanamaz. %20 ve üzeri genelde sağlıklı kabul edilir.',
  },
  financial_cost: {
    group: 'Borç ve kartlar', title: 'Finansal maliyet',
    what: 'Borcun size maliyeti: kart ve ek hesap faizleri, KKDF/BSMV vergileri, gecikme faizi, kredi faizi, kart üyelik ve EFT ücretleri.',
    formula: '“Finansal Giderler” kategorisindeki tüm giderlerin toplamı',
    read: 'Karşılığında mal veya hizmet almadığınız paradır. Azaltmanın en hızlı yolu yüksek faizli borcu önce kapatmaktır.',
  },
  interest_share: {
    group: 'Borç ve kartlar', title: 'Faizin gider içindeki payı',
    what: 'Toplam giderinizin yüzde kaçının faiz ve masrafa gittiği.',
    formula: 'Finansal maliyet ÷ Gider × 100',
    read: '%10’un üstü dikkat, %20’nin üstü borç yükünün harcamayı ciddi biçimde ezdiğini gösterir.',
  },
  interest_vs_payment: {
    group: 'Borç ve kartlar', title: 'Ödemenin faize giden kısmı',
    what: 'Kartlara yaptığınız ödemelerin ne kadarı borcu azaltmak yerine faiz ve masrafı karşıladı.',
    formula: 'Finansal maliyet ÷ Kart ve borç ödemeleri × 100',
    read: 'Yüksekse ödeme yapsanız da borç yeterince azalmıyor demektir.',
  },
  card_utilization: {
    group: 'Borç ve kartlar', title: 'Limit kullanım oranı',
    what: 'Kart ve ek hesap limitinizin ne kadarının borçla dolu olduğu.',
    formula: 'Kullanılan borç ÷ Toplam limit × 100',
    read: '%70’e kadar normal, %70–90 dikkat, %90 ve üzeri kritiktir. Yüksek oran hem risk hem yeni harcama için yer kalmadığı anlamına gelir.',
  },
  available_limit: {
    group: 'Borç ve kartlar', title: 'Kullanılabilir limit',
    what: 'Kartta veya ek hesapta hâlâ harcayabileceğiniz tutar.',
    formula: 'Limit − Güncel borç',
    read: 'Taksitli alışverişte tutarın tamamı limitten hemen düşer.',
  },
  debt_ratio: {
    group: 'Borç ve kartlar', title: 'Borç / varlık oranı',
    what: 'Borcunuzun sahip olduklarınıza oranı.',
    formula: 'Toplam borç ÷ (Varlık + Alacak) × 100',
    read: '%100’ün üstünde borcunuz varlığınızdan fazladır. Varlık yoksa oran anlamsızdır.',
  },
  statement: {
    group: 'Borç ve kartlar', title: 'Kart ekstresi',
    what: 'Hesap kesim gününde kapanan dönemin borcu. Son ödeme gününe kadar ödenmelidir.',
    read: 'Ödenmeyen kısım faize girer ve bir sonraki ekstreye devreder.',
  },
  statement_fresh: {
    group: 'Borç ve kartlar', title: 'Ekstre güncelliği',
    what: 'Her kart için bankadan yüklediğiniz son ekstrenin durumu.',
    formula: 'Bir sonraki hesap kesim tarihi geçtiyse “Yeni ekstre bekleniyor” görünür.',
    read: 'Güncel ekstre, son ödeme ve asgari tutarın bankanın söylediğiyle aynı olmasını sağlar. Eski ekstrede bu tutarlar tahmindir.',
  },
  statement_diff: {
    group: 'Borç ve kartlar', title: 'Defter–ekstre farkı',
    what: 'Defterin o hesap kesiminde hesapladığı kart borcu ile bankanın ekstresindeki dönem borcu arasındaki fark.',
    formula: 'Defterdeki kart borcu − o kesimden sonra faturalanacak taksitler − ekstre dönem borcu',
    read: 'Sıfıra yakın olmalı. Eksi ise defterde eksik kalem ya da ödeme fazla, artı ise defterde fazla kalem var demektir. Birkaç lira fark yuvarlanmış tutarlardan olabilir.',
  },
  min_payment: {
    group: 'Borç ve kartlar', title: 'Asgari ödeme',
    what: 'Kartı gecikmeye düşürmemek için ödenmesi gereken en düşük tutar (varsayılan ekstrenin %20’si).',
    read: 'Yalnızca asgariyi ödemek kalan borca yüksek faiz işletir.',
  },
  overdraft: {
    group: 'Borç ve kartlar', title: 'Ek hesap (Avans)',
    what: 'Bankanın tanıdığı, kullandıkça faiz işleyen borçlanma limiti.',
    read: 'Bu sistemde Avans hesapları ek hesap olarak izlenir; faiz her ay elle “Ek Hesap Faizi” olarak girilir.',
  },
  installment_load: {
    group: 'Borç ve kartlar', title: 'Taksit yükü',
    what: 'Önümüzdeki aylarda ödemeniz gereken kart taksitleri ile kredi taksitlerinin toplamı.',
    read: 'Yeni harcama yapmasanız bile kesinleşmiş ödemelerdir.',
  },
  opening_balance: {
    group: 'Genel durum', title: 'Devreden / açılış bakiyesi',
    what: 'Sisteme girmeden önce mevcut olan borç veya bakiye. Gider sayılmaz.',
    read: 'Excel’den aktarılan “Devreden” satırları bu şekilde işlendi; harcama raporlarını şişirmez.',
  },
  upcoming: {
    group: 'Borç ve kartlar', title: 'Yaklaşan ödemeler',
    what: 'Önümüzdeki günlerde vadesi gelecek kart ekstreleri, kredi taksitleri ve planladığınız ödemeler.',
    read: 'Vadesi geçmiş olanlar “gecikmiş” olarak ayrıca sayılır.',
  },
  period_change: {
    group: 'Analiz', title: 'Önceki dönemle karşılaştırma',
    what: 'Seçili dönemin, hemen öncesindeki aynı uzunluktaki dönemle farkı.',
    read: 'Ay içindeyken “geçen ayın aynı gününe kadar” ile kıyaslanır; böylece yarım ay tam ayla karşılaştırılmaz.',
  },
  avg_daily: {
    group: 'Analiz', title: 'Günlük ortalama harcama',
    what: 'Dönemdeki harcamanın gün sayısına bölünmüş hali (faiz hariç).',
    formula: 'Harcama (faiz hariç) ÷ Dönemdeki gün sayısı',
  },
  avg_ticket: {
    group: 'Analiz', title: 'Ortalama işlem tutarı',
    what: 'Tek bir harcama kaydının ortalama büyüklüğü (faiz hariç).',
    formula: 'Harcama (faiz hariç) ÷ Harcama sayısı',
  },
  category_share: {
    group: 'Analiz', title: 'Kategori payı',
    what: 'Bir kategorinin toplam giderin yüzde kaçını oluşturduğu.',
    formula: 'Kategori toplamı ÷ Toplam gider × 100',
    read: 'Halkaya veya satıra tıklayarak o kategorideki tüm işlemleri görebilirsiniz.',
  },
  weekday_pattern: {
    group: 'Analiz', title: 'Haftanın günlerine göre harcama',
    what: 'Harcamanın hangi günlere yoğunlaştığı; her günün dönem toplamı ve o günün ortalaması.',
    read: 'Hafta sonu veya maaş sonrası yoğunlaşmaları fark etmeye yarar.',
  },
  heatmap: {
    group: 'Analiz', title: 'Harcama ısı haritası',
    what: 'Her gün bir kutudur; rengi koyulaştıkça o gün daha çok harcanmıştır. Sütunlar haftaları gösterir.',
    read: 'Kutuya tıklayınca o günün işlemleri açılır.',
  },
  top_items: {
    group: 'Analiz', title: 'En çok harcanan kalemler',
    what: 'Aynı açıklamayla yapılan harcamaların toplamı (örn. tüm “MARKET BIM” alışverişleri).',
    read: 'Faiz ve masrafları hariç tutarak yalnızca gerçek harcamalarınıza odaklanabilirsiniz.',
  },
  cumulative: {
    group: 'Analiz', title: 'Birikimli gider',
    what: 'Dönem başından itibaren yapılan harcamaların günlük olarak toplanmış hali.',
    read: 'Eğimi dikleştiği dönemler harcamanın hızlandığı zamanlardır.',
  },
} satisfies Record<string, Term>;

export type TermKey = keyof typeof GLOSSARY;

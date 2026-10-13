import { readFileSync } from 'fs';
import { join } from 'path';

const PLACES_PATH = join(process.cwd(), 'src/application/services/agent/localFiles/place_names.json');

/**
 * کلید آوایی: حروف هم‌صدا یکی می‌شن (س/ص/ث، ز/ذ/ض/ظ، ت/ط، ه/ح، ق/غ، ا/ع/آ)
 * و فاصله/نیم‌فاصله حذف می‌شه -- whisper بیشتر همین‌ها رو اشتباه می‌نویسه.
 */
function phoneticKey(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[ثص]/g, 'س')
    .replace(/[ذضظ]/g, 'ز')
    .replace(/ط/g, 'ت')
    .replace(/[حة]/g, 'ه')
    .replace(/غ/g, 'ق')
    .replace(/[عآأإءئ]/g, 'ا')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    let rowMin = row[0];
    for (let j = 1; j <= b.length; j++) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
      rowMin = Math.min(rowMin, row[j]);
    }
    if (rowMin > max) return max + 1;
  }
  return row[b.length];
}

// کلمه‌های رایج آگهی بار که به اسم یک شهر کوچک نزدیکن («انبار»/«انار») -- هیچ‌وقت اصلاح نمی‌شن.
const COMMON_WORDS = new Set(
  [
    'انبار', 'کارخانه', 'گمرک', 'پایانه', 'ترمینال', 'بندر', 'شهرک', 'صنعتی', 'مرز', 'کشور', 'داخل', 'خارج',
    'بار', 'بارگیری', 'تخلیه', 'مقصد', 'مبدا', 'شهر', 'استان', 'معدن', 'پالایشگاه', 'پتروشیمی', 'نیروگاه',
    'سیلو', 'اسکله', 'فرودگاه', 'کارگاه', 'سایت', 'دپو', 'محل', 'همه', 'سراسر', 'کل', 'جنوب', 'شمال', 'شرق', 'غرب',
  ].map(phoneticKey),
);

interface Place {
  name: string;
  key: string;
  major: boolean;
}

let places: Place[] | null = null;
let byKey: Map<string, Place> | null = null;

function load(): void {
  if (places) return;
  try {
    const data = JSON.parse(readFileSync(PLACES_PATH, 'utf8')) as { major: string[]; minor: string[] };
    places = [
      ...data.major.map((name) => ({ name, key: phoneticKey(name), major: true })),
      ...data.minor.map((name) => ({ name, key: phoneticKey(name), major: false })),
    ];
  } catch {
    places = [];
  }
  byKey = new Map();
  // شهر بزرگ اول ثبت می‌شه و هم‌نامِ کوچک جاش رو نمی‌گیره.
  for (const place of places) if (!byKey.has(place.key)) byKey.set(place.key, place);
}

/**
 * اسم مبدا/مقصدی که از متن ویس استخراج شده رو به نزدیک‌ترین شهر/مرز شناخته‌شده
 * اصلاح می‌کنه («تبیز» ← «تبریز»، «زایدان» ← «زاهدان»). اگه اسم (یا بخشی از
 * اون، مثل «تبریز شهرک سلیمی») از قبل شناخته‌شده باشه، یا نزدیک‌ترین گزینه
 * یکتا نباشه، دست نمی‌خوره -- اصلاح اشتباه بدتر از اصلاح نکردنه.
 */
export function snapPlaceName(value: string | null): string | null {
  if (!value) return value;
  load();
  const words = value.trim().split(/\s+/);

  for (let size = Math.min(3, words.length); size >= 1; size--) {
    for (let start = 0; start + size <= words.length; start++) {
      const place = byKey!.get(phoneticKey(words.slice(start, start + size).join(' ')));
      if (!place) continue;
      // کل مقدار یک اسم بود (شاید با املای آوایی دیگه) -- شکل درستش برمی‌گرده.
      return size === words.length ? place.name : value;
    }
  }

  // فقط اسم کوتاه (یک یا دو کلمه) -- عبارت بلندتر معمولاً توضیحه، نه اسم شهر.
  if (words.length > 2) return value;
  const key = phoneticKey(value);
  if (COMMON_WORDS.has(key)) return value;
  const max = key.length <= 3 ? 0 : key.length <= 7 ? 1 : 2;
  if (max === 0) return value;

  let best: Place[] = [];
  let bestDistance = max + 1;
  for (const place of places!) {
    const distance = editDistance(key, place.key, max);
    if (distance < bestDistance) {
      best = [place];
      bestDistance = distance;
    } else if (distance === bestDistance && distance <= max) {
      best.push(place);
    }
  }
  if (best.length === 0) return value;

  const majors = best.filter((place) => place.major);
  const candidates = majors.length > 0 ? majors : best;
  return candidates.length === 1 ? candidates[0].name : value;
}

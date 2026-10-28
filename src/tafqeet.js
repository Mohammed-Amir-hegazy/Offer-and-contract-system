// Convert an integer amount to Arabic words (تفقيط) for contracts, e.g. 1250000 → "مليون ومائتان وخمسون ألف".

const ONES = ['', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة', 'عشرة',
  'أحد عشر', 'اثنا عشر', 'ثلاثة عشر', 'أربعة عشر', 'خمسة عشر', 'ستة عشر', 'سبعة عشر', 'ثمانية عشر', 'تسعة عشر'];
const TENS = ['', '', 'عشرون', 'ثلاثون', 'أربعون', 'خمسون', 'ستون', 'سبعون', 'ثمانون', 'تسعون'];
const HUNDREDS = ['', 'مائة', 'مائتان', 'ثلاثمائة', 'أربعمائة', 'خمسمائة', 'ستمائة', 'سبعمائة', 'ثمانمائة', 'تسعمائة'];

// [singular, dual, plural (3-10), accusative singular (11+)]
const SCALES = [
  null,
  ['ألف', 'ألفان', 'آلاف', 'ألف'],
  ['مليون', 'مليونان', 'ملايين', 'مليون'],
  ['مليار', 'ملياران', 'مليارات', 'مليار'],
];

function below1000(n) {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  const parts = [];
  if (h) parts.push(HUNDREDS[h]);
  if (rest) {
    if (rest < 20) parts.push(ONES[rest]);
    else {
      const t = Math.floor(rest / 10);
      const o = rest % 10;
      parts.push(o ? `${ONES[o]} و${TENS[t]}` : TENS[t]);
    }
  }
  return parts.join(' و');
}

function scaleWords(n, scale) {
  const [one, two, plural, acc] = SCALES[scale];
  if (n === 1) return one;
  if (n === 2) return two;
  if (n >= 3 && n <= 10) return `${below1000(n)} ${plural}`;
  return `${below1000(n)} ${acc}`;
}

function tafqeet(value) {
  let n = Math.floor(Math.abs(Number(value) || 0));
  if (n === 0) return 'صفر';
  const groups = [];
  let scale = 0;
  while (n > 0 && scale < SCALES.length) {
    const g = n % 1000;
    if (g) groups.unshift(scale === 0 ? below1000(g) : scaleWords(g, scale));
    n = Math.floor(n / 1000);
    scale++;
  }
  return groups.join(' و');
}

function amountInWords(value, currency = 'جنيهاً مصرياً') {
  return `فقط ${tafqeet(value)} ${currency} لا غير`;
}

module.exports = { tafqeet, amountInWords };

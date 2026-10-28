const FLOOR_LABELS = {
  GROUND: 'الدور الأرضي',
  FIRST: 'الدور الأول',
  SECOND: 'الدور الثاني',
  THIRD: 'الدور الثالث',
  FOURTH: 'الدور الرابع',
};

const STATUS_LABELS = { available: 'متاحة', reserved: 'محجوزة', sold: 'مباعة' };

const CONTRACT_STATUS_LABELS = {
  draft: 'مسودة',
  pending: 'بانتظار التوقيع',
  signed: 'موقّع من الطرفين',
  cancelled: 'ملغي',
};

// Fonts a company can choose for its printed documents: common system fonts (as in Word documents)
// and Arabic Google Fonts (all with 400 and 700 weights).
const SYSTEM_FONTS = ['Arial', 'Times New Roman', 'Tahoma'];
const COMPANY_FONTS = [...SYSTEM_FONTS, 'Cairo', 'Tajawal', 'Almarai', 'IBM Plex Sans Arabic', 'Noto Kufi Arabic', 'Noto Naskh Arabic',
  'Amiri', 'El Messiri', 'Changa', 'Readex Pro', 'Markazi Text', 'Harmattan'];

const FREQUENCY_LABELS = { 1: 'شهري', 3: 'ربع سنوي (كل 3 شهور)', 6: 'نصف سنوي (كل 6 شهور)', 12: 'سنوي' };

function money(n) {
  if (n == null || n === '') return '—';
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function area(n) {
  if (n == null || n === '') return '—';
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function date(iso) {
  if (!iso) return '—';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

function datetime(iso) {
  if (!iso) return '—';
  const s = String(iso).replace('T', ' ').slice(0, 16);
  return `${date(s.slice(0, 10))} ${s.slice(11, 16)}`;
}

function floorLabel(f) {
  return FLOOR_LABELS[f] || f;
}

function frequencyLabel(m) {
  return FREQUENCY_LABELS[m] || `كل ${m} شهور`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Dates and signing times follow the company's time zone, not the server's.
const TIME_ZONE = process.env.APP_TZ || 'Africa/Cairo';

// "yyyy-mm-dd hh:mm:ss" in the company's time zone.
function nowLocal() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(new Date());
}

// Uploaded files are stored either as a full (Vercel Blob) URL or as a local file name.
function upload(stored) {
  if (!stored) return null;
  return /^https:\/\//.test(stored) ? stored : `/uploads/${String(stored).split('/').pop()}`;
}

function todayIso() {
  return nowLocal().slice(0, 10);
}

module.exports = {
  FLOOR_LABELS, STATUS_LABELS, CONTRACT_STATUS_LABELS, FREQUENCY_LABELS, COMPANY_FONTS, SYSTEM_FONTS,
  money, area, date, datetime, floorLabel, frequencyLabel, escapeHtml, todayIso, nowLocal, upload,
};

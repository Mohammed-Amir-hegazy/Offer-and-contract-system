// Downloadable copies: the contract as a Word document and the quote as an Excel workbook.
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell, WidthType, AlignmentType,
  Header, Footer, PageNumber, BorderStyle, ShadingType, VerticalAlign,
} = require('docx');
const { parse } = require('node-html-parser');
const { imageSize } = require('image-size');
const ExcelJS = require('exceljs');
const f = require('./format');
const { UPLOAD_DIR } = require('./storage');

// ---------- Images (data URLs, local uploads, Vercel Blob URLs)
async function loadImage(src) {
  try {
    let data;
    if (src.startsWith('data:image/')) data = Buffer.from(src.split(',')[1], 'base64');
    else if (src.startsWith('/uploads/')) data = await fs.readFile(path.join(UPLOAD_DIR, path.basename(src)));
    else if (/^https:\/\/[a-z0-9.-]+\.public\.blob\.vercel-storage\.com\//.test(src)) {
      const res = await fetch(src);
      if (!res.ok) return null;
      data = Buffer.from(await res.arrayBuffer());
    } else return null;
    const size = imageSize(data);
    const type = { png: 'png', jpg: 'jpg', jpeg: 'jpg', gif: 'gif', bmp: 'bmp' }[size.type];
    return type ? { data, width: size.width, height: size.height, type } : null;
  } catch {
    return null;
  }
}

async function loadImages(srcs) {
  const map = new Map();
  await Promise.all([...new Set(srcs.filter(Boolean))].map(async (src) => map.set(src, await loadImage(src))));
  return map;
}

const fit = (img, maxW, maxH) => {
  const k = Math.min(1, maxW / img.width, maxH / img.height);
  return { width: Math.round(img.width * k), height: Math.round(img.height * k) };
};

// ---------- Contract → Word
const NONE = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
const NO_BORDERS = { top: NONE, bottom: NONE, left: NONE, right: NONE, insideHorizontal: NONE, insideVertical: NONE };
const PT = (n) => n * 2; // docx sizes are half-points
const SIZES = { h1: 16, h2: 13, h3: 12, p: 11, small: 8 };

function parseColor(style) {
  const m = /color:\s*#([0-9a-f]{6})/i.exec(style || '');
  return m ? m[1] : undefined;
}

function alignment(el) {
  const style = el.getAttribute?.('style') || '';
  const cls = el.getAttribute?.('class') || '';
  if (/text-align:\s*center/.test(style) || /\b(clause|clause-title|annex)\b/.test(cls) || el.tagName === 'H1') return AlignmentType.CENTER;
  if (/text-align:\s*left/.test(style)) return AlignmentType.LEFT;
  return AlignmentType.RIGHT;
}

function makeConverter({ images, font }) {
  const fontSpec = { ascii: font, hAnsi: font, cs: font, eastAsia: font };
  const run = (text, s) => new TextRun({
    text,
    rightToLeft: true,
    font: fontSpec,
    size: PT(s.size), sizeComplexScript: PT(s.size),
    bold: s.bold, boldComplexScript: s.bold,
    italics: s.italics, italicsComplexScript: s.italics,
    underline: s.underline ? {} : undefined,
    color: s.color,
  });
  const imageRun = (src, maxW, maxH) => {
    const img = images.get(src);
    if (!img) return null;
    return new ImageRun({ type: img.type, data: img.data, transformation: fit(img, maxW, maxH) });
  };

  // Inline content of an element → runs.
  function inline(node, s, out = []) {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        const text = child.text.replace(/\s+/g, ' ');
        if (text.trim() || (text === ' ' && out.length)) out.push(run(text, s));
        continue;
      }
      if (child.nodeType !== 1) continue;
      const tag = child.tagName;
      const cls = child.getAttribute('class') || '';
      const next = { ...s, color: parseColor(child.getAttribute('style')) || s.color };
      if (tag === 'BR') out.push(new TextRun({ break: 1 }));
      else if (tag === 'STRONG' || tag === 'B') inline(child, { ...next, bold: true }, out);
      else if (tag === 'U') inline(child, { ...next, underline: true }, out);
      else if (tag === 'EM' || tag === 'I') inline(child, { ...next, italics: true }, out);
      else if (tag === 'SMALL') inline(child, { ...next, size: SIZES.small }, out);
      else if (tag === 'IMG') {
        const src = child.getAttribute('src') || '';
        const isSig = /sig-slot|sig-stamp/.test(child.parentNode?.getAttribute?.('class') || '');
        const r = isSig ? imageRun(src, 170, 80) : imageRun(src, 600, 820);
        if (r) out.push(r);
      } else if (cls.includes('sig-slot') && cls.includes('signed')) {
        const img = child.querySelector('img');
        const r = img && imageRun(img.getAttribute('src'), 170, 80);
        if (r) out.push(r);
        const note = child.querySelector('small');
        if (note) out.push(new TextRun({ break: 1 }), run(note.text, { ...s, size: SIZES.small, color: '666666' }));
      } else inline(child, next, out);
    }
    return out;
  }

  const paragraph = (el, s, extra = {}, prefix = []) => new Paragraph({
    bidirectional: true,
    alignment: alignment(el),
    spacing: { after: 80, line: 300 },
    children: [...prefix, ...inline(el, s)],
    ...extra,
  });

  function table(el, s) {
    const rows = el.querySelectorAll('tr');
    if (!rows.length) return [];
    const isSignatures = (el.getAttribute('class') || '').includes('signatures');
    const border = isSignatures ? NONE : { style: BorderStyle.SINGLE, size: 4, color: 'A6A6A6' };
    return [new Table({
      visuallyRightToLeft: true,
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
      rows: rows.map((tr) => new TableRow({
        children: tr.querySelectorAll('td, th').map((cell) => new TableCell({
          columnSpan: Number(cell.getAttribute('colspan')) || 1,
          verticalAlign: VerticalAlign.CENTER,
          shading: cell.tagName === 'TH' ? { type: ShadingType.CLEAR, fill: 'EEF2F7', color: 'auto' } : undefined,
          children: [new Paragraph({
            bidirectional: true,
            alignment: isSignatures ? AlignmentType.RIGHT : AlignmentType.CENTER,
            spacing: { after: 40 },
            children: inline(cell, { ...s, size: isSignatures ? SIZES.p : 9, bold: s.bold || cell.tagName === 'TH' }),
          })],
        })),
      })),
    })];
  }

  // Block content → paragraphs and tables.
  function blocks(node, s) {
    const out = [];
    let loose = []; // inline nodes sitting directly in a block container
    const flushLoose = () => {
      if (!loose.length) return;
      const holder = parse('<p></p>').firstChild;
      loose.forEach((n) => holder.appendChild(n.clone()));
      if (holder.text.trim() || holder.querySelector('img')) out.push(paragraph(holder, s));
      loose = [];
    };
    for (const child of node.childNodes) {
      if (child.nodeType === 3) { if (child.text.trim()) loose.push(child); continue; }
      if (child.nodeType !== 1) continue;
      const tag = child.tagName;
      const cls = child.getAttribute('class') || '';
      if (/\b(page-top|page-sign)\b/.test(cls) || cls === 'page-break') { flushLoose(); continue; }
      if (['H1', 'H2', 'H3', 'H4'].includes(tag)) {
        flushLoose();
        const size = SIZES[tag.toLowerCase()] || SIZES.h3;
        out.push(paragraph(child, { ...s, size, bold: true, color: parseColor(child.getAttribute('style')) || s.color, underline: /\b(clause|annex)\b/.test(cls) }, { keepNext: true }));
      } else if (tag === 'P') {
        flushLoose();
        out.push(paragraph(child, { ...s, color: parseColor(child.getAttribute('style')) || s.color }));
      } else if (tag === 'UL' || tag === 'OL') {
        flushLoose();
        const color = parseColor(child.getAttribute('style'));
        child.querySelectorAll('li').forEach((li, i) => {
          out.push(paragraph(li, { ...s, color: color || s.color }, { indent: { right: 360 } }, [run(tag === 'OL' ? `${i + 1}. ` : '• ', s)]));
        });
      } else if (tag === 'TABLE') {
        flushLoose();
        out.push(...table(child, s), new Paragraph({ children: [], spacing: { after: 80 } }));
      } else if (tag === 'IMG') {
        flushLoose();
        const img = images.get(child.getAttribute('src'));
        if (img) out.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new ImageRun({ type: img.type, data: img.data, transformation: fit(img, 600, 820) })] }));
      } else if (['DIV', 'SECTION', 'FOOTER', 'HEADER', 'ARTICLE'].includes(tag)) {
        flushLoose();
        out.push(...blocks(child, s));
      } else loose.push(child);
    }
    flushLoose();
    return out;
  }

  return { blocks, run, imageRun, fontSpec };
}

/**
 * @param {object} p
 * @param {string} p.html     contract body with signatures applied (applySignatures)
 * @param {object} p.contract
 * @param {object} p.company  print identity snapshot
 * @param {boolean} p.signEveryPage
 */
async function contractDocx({ html, contract, company, signEveryPage }) {
  const root = parse(html);
  const logoSrc = f.upload(company.logo);
  const srcs = root.querySelectorAll('img').map((i) => i.getAttribute('src'));
  if (logoSrc) srcs.push(logoSrc);
  const images = await loadImages(srcs);
  const font = f.SYSTEM_FONTS.includes(company.font_family) ? company.font_family : 'Arial';
  const conv = makeConverter({ images, font });
  const base = { size: SIZES.p, bold: false, italics: false, underline: false, color: undefined };

  // One page of the contract per <section class="contract-page">; each starts on a new Word page.
  const pages = root.querySelectorAll('section.contract-page');
  const children = [];
  (pages.length ? pages : [root]).forEach((page, i) => {
    const body = page.querySelector?.('.page-body') || page;
    const items = conv.blocks(body, base);
    if (i > 0 && items.length) items.unshift(new Paragraph({ pageBreakBefore: true, children: [] }));
    children.push(...items);
  });

  const logo = logoSrc && images.get(logoSrc);
  const header = new Header({
    children: [new Paragraph({
      bidirectional: true,
      alignment: AlignmentType.RIGHT,
      children: [
        ...(logo ? [new ImageRun({ type: logo.type, data: logo.data, transformation: fit(logo, 120, 40) }), new TextRun({ text: '    ' })] : []),
        conv.run(`${company.name || ''} — عقد ${contract.number} — صفحة `, { ...base, size: 8, color: '666666' }),
        new TextRun({ children: [PageNumber.CURRENT], size: 16 }),
        conv.run(' من ', { ...base, size: 8, color: '666666' }),
        new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16 }),
      ],
    })],
  });

  // Both signatures at the foot of every page, as in the printed contract.
  const sigCell = (label, party) => {
    const img = contract[`${party}_signature`] && images.get(contract[`${party}_signature`]);
    return new TableCell({
      borders: { top: { style: BorderStyle.SINGLE, size: 4, color: 'BFBFBF' }, bottom: NONE, left: NONE, right: NONE },
      children: [new Paragraph({
        bidirectional: true,
        alignment: AlignmentType.RIGHT,
        children: [
          conv.run(`${label}: `, { ...base, size: 9, color: '444444' }),
          img ? new ImageRun({ type: img.type, data: img.data, transformation: fit(img, 110, 36) }) : conv.run('..........................', { ...base, size: 9 }),
        ],
      })],
    });
  };
  const footer = signEveryPage ? new Footer({
    children: [new Table({
      visuallyRightToLeft: true,
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: NO_BORDERS,
      rows: [new TableRow({ children: [sigCell('توقيع الطرف الأول (البائع)', 'company'), sigCell('توقيع الطرف الثاني (المشتري)', 'client')] })],
    })],
  }) : undefined;

  const doc = new Document({
    creator: company.name || 'Ebtikar',
    title: `عقد ${contract.number}`,
    styles: { default: { document: { run: { font: conv.fontSpec, rightToLeft: true } } } },
    sections: [{
      properties: {
        page: { size: { width: 11906, height: 16838 }, margin: { top: 1300, bottom: 1300, left: 1000, right: 1000, header: 500, footer: 450 } },
      },
      headers: { default: header },
      footers: footer ? { default: footer } : undefined,
      children,
    }],
  });
  return Packer.toBuffer(doc);
}

// ---------- Quote → Excel
async function quoteXlsx({ quote, unit, plan, company, terms }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = company.name || 'Ebtikar';
  const ws = wb.addWorksheet('عرض السعر', {
    views: [{ rightToLeft: true, showGridLines: false }],
    pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 1, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } },
  });
  const brand = `FF${(company.primary_color || '#1f2937').slice(1).toUpperCase()}`;
  ws.columns = [{ width: 15 }, { width: 16 }, { width: 15 }, { width: 19 }, { width: 15 }, { width: 17 }];
  const font = { name: 'Arial' };
  const money = '#,##0';
  const border = { top: { style: 'thin', color: { argb: 'FFBFBFBF' } }, bottom: { style: 'thin', color: { argb: 'FFBFBFBF' } }, left: { style: 'thin', color: { argb: 'FFBFBFBF' } }, right: { style: 'thin', color: { argb: 'FFBFBFBF' } } };
  const label = { font: { ...font, bold: true }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F4F8' } }, border };
  const value = { font, border, alignment: { horizontal: 'right' } };
  const showGarage = plan.garagePrice > 0;

  // Logo + company header
  const logo = await loadImage(f.upload(company.logo) || '');
  if (logo) {
    const id = wb.addImage({ buffer: logo.data, extension: logo.type === 'jpg' ? 'jpeg' : logo.type });
    const size = fit(logo, 150, 55);
    ws.addImage(id, { tl: { col: 4.2, row: 0.1 }, ext: size });
  }
  ws.mergeCells('A1:D1');
  ws.getCell('A1').value = company.name || '';
  ws.getCell('A1').font = { ...font, bold: true, size: 15, color: { argb: brand } };
  ws.mergeCells('A2:D2');
  ws.getCell('A2').value = [company.project_name, company.address, company.phone].filter(Boolean).join(' — ');
  ws.getCell('A2').font = { ...font, color: { argb: 'FF666666' } };
  ws.mergeCells('A3:D3');
  ws.getCell('A3').value = `عرض سعر رقم ${quote.number} — بتاريخ ${f.date(quote.offer_date)}`;
  ws.getCell('A3').font = { ...font, bold: true, size: 12 };
  ws.getRow(1).height = 26;

  let r = 5;
  const pair = (a, b, c, d) => {
    const row = ws.getRow(r++);
    [[1, a, label], [2, b, value], [4, c, label], [5, d, value]].forEach(([col, v, st]) => {
      if (v === undefined) return;
      const cell = row.getCell(col);
      cell.value = v;
      Object.assign(cell, { font: st.font, fill: st.fill, border: st.border, alignment: st.alignment });
    });
    ws.mergeCells(row.number, 2, row.number, 3);
    ws.mergeCells(row.number, 5, row.number, 6);
    return row;
  };
  const section = (title) => {
    const row = ws.getRow(r++);
    ws.mergeCells(row.number, 1, row.number, 6);
    row.getCell(1).value = title;
    row.getCell(1).font = { ...font, bold: true, size: 12, color: { argb: brand } };
  };

  section('بيانات العميل');
  pair('العميل', quote.client_name, 'الموبايل', quote.client_phone || '—');
  pair('تاريخ العرض', f.date(quote.offer_date), 'صالح حتى', quote.valid_until ? f.date(quote.valid_until) : '—');
  r++;
  section('بيانات الوحدة');
  pair('كود الوحدة', unit.code, 'العمارة / المدخل', `${unit.building} / ${unit.entrance}`);
  pair('الدور', f.floorLabel(unit.floor), 'النموذج', unit.model_no || '—');
  pair('المساحة م²', Number(unit.area) || 0, 'الحديقة م²', Number(unit.garden_area) || 0);
  pair('عدد الغرف', unit.rooms ?? '—', 'الحمامات', unit.bathrooms ?? '—');
  r++;
  section('السعر');
  const moneyRow = (a, av, b, bv) => {
    const row = pair(a, av, b, bv);
    [2, 5].forEach((c) => { if (typeof row.getCell(c).value === 'number') row.getCell(c).numFmt = money; });
  };
  moneyRow('سعر الوحدة', plan.unitPrice, `الخصم (${plan.discountPct}%)`, plan.discountAmount);
  moneyRow('السعر بعد الخصم', plan.netPrice, `المقدم (${plan.downPaymentPct}%)`, plan.downPayment);
  moneyRow('الجراج', plan.garagePrice, `وديعة الصيانة (${plan.maintenancePct}%)`, plan.maintenanceAmount);
  moneyRow('نظام السداد', `${plan.count} قسط — ${f.frequencyLabel(plan.frequencyMonths)}`, 'الإجمالي شامل الصيانة', plan.grandTotal);
  r++;
  section('جدول السداد');

  const headers = ['القسط', 'تاريخ الاستحقاق', 'قيمة القسط', ...(showGarage ? ['الجراج'] : []), 'وديعة الصيانة', 'الإجمالي'];
  const head = ws.getRow(r++);
  headers.forEach((h, i) => {
    const c = head.getCell(i + 1);
    c.value = h;
    c.font = { ...font, bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: brand } };
    c.alignment = { horizontal: 'center' };
    c.border = border;
  });
  const first = r;
  const lines = [{ no: 'المقدم', date: plan.startDate, unit: plan.downPayment, garage: 0, maintenance: 0 }, ...plan.installments];
  for (const i of lines) {
    const row = ws.getRow(r);
    const [y, m, d] = i.date.split('-').map(Number);
    const vals = [i.no, new Date(Date.UTC(y, m - 1, d)), i.unit, ...(showGarage ? [i.garage] : []), i.maintenance];
    vals.forEach((v, k) => { row.getCell(k + 1).value = v; });
    const totalCol = vals.length + 1;
    const from = ws.getColumn(3).letter;
    const to = ws.getColumn(totalCol - 1).letter;
    row.getCell(totalCol).value = { formula: `SUM(${from}${r}:${to}${r})`, result: i.unit + (showGarage ? i.garage : 0) + i.maintenance };
    for (let k = 1; k <= totalCol; k++) {
      const c = row.getCell(k);
      c.font = { ...font, bold: k === totalCol || i.no === 'المقدم' };
      c.border = border;
      c.alignment = { horizontal: 'center' };
      if (k === 2) c.numFmt = 'dd/mm/yyyy';
      if (k >= 3) c.numFmt = money;
      if (i.maintenance) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF8E6' } };
    }
    r++;
  }
  const total = ws.getRow(r++);
  total.getCell(1).value = 'الإجمالي';
  for (let k = 3; k <= headers.length; k++) {
    const col = ws.getColumn(k).letter;
    total.getCell(k).value = { formula: `SUM(${col}${first}:${col}${r - 2})` };
    total.getCell(k).numFmt = money;
  }
  for (let k = 1; k <= headers.length; k++) {
    const c = total.getCell(k);
    c.font = { ...font, bold: true };
    c.border = border;
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F4F8' } };
    c.alignment = { horizontal: 'center' };
  }
  if (terms) {
    r++;
    ws.mergeCells(r, 1, r, 6);
    const c = ws.getCell(r, 1);
    c.value = terms;
    c.font = { ...font, size: 9, color: { argb: 'FF666666' } };
    c.alignment = { wrapText: true, horizontal: 'right' };
    ws.getRow(r).height = 30;
  }
  return wb.xlsx.writeBuffer();
}

module.exports = { contractDocx, quoteXlsx };

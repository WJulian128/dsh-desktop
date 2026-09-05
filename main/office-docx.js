'use strict';

/**
 * Office 文件级读写（纯 Node，不依赖 Office/WPS 安装；与 office-com.js 的
 * COM 通道互补）。
 *
 * 能力：
 *  - readDocxText(filePath)          ：.docx → 纯文本（mammoth，段落/表格内容）
 *  - markdownToDocx(text, outPath)   ：markdown → .docx（docx 包；标题/列表/引用/
 *                                      代码块/表格/粗体/斜体/行内代码）
 *  - readXlsx(filePath, sheetName?)  ：.xlsx → { sheetNames, sheetName, rows }
 *  - writeXlsx(filePath, {sheets})   ：{ name, rows }[] → .xlsx（新建/覆盖）
 * 所有函数失败抛 Error（含路径与上下文），由 RPC 层统一转 { ok:false, error }。
 * 测试：scripts/test-office-docx.js（临时文件自建自清）。
 */

const fs = require('node:fs');
const path = require('node:path');
const mammoth = require('mammoth');
const docx = require('docx');
const ExcelJS = require('exceljs');

/** 校验并绝对化输入路径（必须存在）。 */
function resolveExisting(filePath) {
  const abs = path.resolve(String(filePath));
  if (!fs.existsSync(abs)) throw new Error('文件不存在：' + abs);
  return abs;
}

/* ---------------- docx 读取 ---------------- */

/** .docx → 纯文本（含表格文字，顺序为文档流）。 */
async function readDocxText(filePath) {
  const abs = resolveExisting(filePath);
  const result = await mammoth.extractRawText({ path: abs });
  const text = (result.value || '').replace(/\r\n/g, '\n');
  if (!text && result.messages && result.messages.length) {
    throw new Error('docx 解析无内容：' + result.messages.map((m) => m.message).join('；'));
  }
  return text;
}

/* ---------------- markdown → docx ---------------- */

/** 行内样式解析：**粗体** / *斜体* / `行内码` → docx.TextRun 配置数组。 */
function parseInline(text) {
  const runs = [];
  // 简单三态扫描器：依次找 **、`、* 的开始与结束（嵌套不做，够用）。
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/;
  let rest = text;
  while (rest) {
    const m = rest.match(pattern);
    if (!m) { runs.push({ text: rest }); break; }
    if (m.index > 0) runs.push({ text: rest.slice(0, m.index) });
    const token = m[0];
    if (token.startsWith('**')) runs.push({ text: token.slice(2, -2), bold: true });
    else if (token.startsWith('`')) runs.push({ text: token.slice(1, -1), code: true });
    else runs.push({ text: token.slice(1, -1), italics: true });
    rest = rest.slice(m.index + token.length);
  }
  return runs.map((r) => {
    const opts = { text: r.text };
    if (r.bold) opts.bold = true;
    if (r.italics) opts.italics = true;
    if (r.code) { opts.font = 'Consolas'; opts.size = 20; }
    return new docx.TextRun(opts);
  });
}

/** markdown 行 → 块列表（段落/标题/列表/引用/代码/表格）。 */
function parseMarkdown(text) {
  const blocks = [];
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  const isTableSep = (l) => /^\s*\|?[\s:|-]+\|?\s*$/.test(l) && l.includes('-');
  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trimEnd();
    if (!line.trim()) { i += 1; continue; }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] });
      i += 1;
      continue;
    }
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const code = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { code.push(lines[i]); i += 1; }
      i += 1; // 跳过收尾 ```
      blocks.push({ type: 'code', text: code.join('\n') });
      continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      const q = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { q.push(lines[i].replace(/^>\s?/, '')); i += 1; }
      blocks.push({ type: 'quote', text: q.join('\n') });
      continue;
    }
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*[-*+]\s+(.*)$/);
        if (!m) break;
        items.push(m[1]); i += 1;
      }
      blocks.push({ type: 'list', ordered: false, items });
      continue;
    }
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) {
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*\d+[.)]\s+(.*)$/);
        if (!m) break;
        items.push(m[1]); i += 1;
      }
      blocks.push({ type: 'list', ordered: true, items });
      continue;
    }
    // 表格：连续行含 | 分隔且其后是分隔行 |---|
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const parseRow = (l) => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
      const head = parseRow(line);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && !isTableSep(lines[i])) {
        rows.push(parseRow(lines[i]));
        i += 1;
      }
      blocks.push({ type: 'table', head, rows });
      continue;
    }
    blocks.push({ type: 'paragraph', text: line });
    i += 1;
  }
  return blocks;
}

/** 块列表 → docx 文档元素。 */
function blocksToDocxChildren(blocks, { title } = {}) {
  const children = [];
  if (title) {
    children.push(new docx.Paragraph({
      heading: docx.HeadingLevel.TITLE,
      spacing: { after: 200 },
      children: [new docx.TextRun({ text: title })],
    }));
  }
  for (const b of blocks) {
    if (b.type === 'heading') {
      const levelMap = [docx.HeadingLevel.HEADING_1, docx.HeadingLevel.HEADING_2, docx.HeadingLevel.HEADING_3,
        docx.HeadingLevel.HEADING_4, docx.HeadingLevel.HEADING_5, docx.HeadingLevel.HEADING_6];
      children.push(new docx.Paragraph({
        heading: levelMap[Math.min(Math.max(b.level, 1), 6) - 1],
        spacing: { before: 160, after: 80 },
        children: parseInline(b.text),
      }));
    } else if (b.type === 'code') {
      children.push(new docx.Paragraph({
        shading: { type: docx.ShadingType.CLEAR, fill: 'F0F0F0' },
        spacing: { before: 80, after: 80 },
        children: [new docx.TextRun({ text: b.text, font: 'Consolas', size: 18 })],
      }));
    } else if (b.type === 'quote') {
      children.push(new docx.Paragraph({
        indent: { left: 360 },
        border: { left: { style: docx.BorderStyle.SINGLE, size: 12, color: '999999' } },
        spacing: { before: 80, after: 80 },
        children: parseInline(b.text),
      }));
    } else if (b.type === 'list') {
      for (const item of b.items) {
        children.push(new docx.Paragraph({
          numbering: { reference: 'office-md-list', level: 0 },
          children: parseInline(item),
        }));
      }
    } else if (b.type === 'table') {
      const mkCell = (text) => new docx.TableCell({
        margins: { top: 60, bottom: 60, left: 100, right: 100 },
        children: [new docx.Paragraph({ children: parseInline(text) })],
      });
      const mkRow = (cells, isHead) => new docx.TableRow({
        tableHeader: isHead,
        children: cells.map((c) => mkCell(c)),
      });
      children.push(new docx.Table({
        width: { size: 100, type: docx.WidthType.PERCENTAGE },
        rows: [mkRow(b.head, true), ...b.rows.map((r) => mkRow(r, false))],
      }));
    } else {
      children.push(new docx.Paragraph({ spacing: { after: 60 }, children: parseInline(b.text) }));
    }
  }
  return children;
}

/** markdown 文本 → .docx 文件。title 可选（文档标题段落）。 */
async function markdownToDocx(text, outPath, { title } = {}) {
  const abs = path.resolve(String(outPath));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const blocks = parseMarkdown(text);
  const doc = new docx.Document({
    numbering: { config: [{ reference: 'office-md-list', levels: [{ level: 0, format: 'bullet', text: '•', alignment: 'left' }] }] },
    sections: [{
      properties: {},
      children: blocksToDocxChildren(blocks, { title }),
    }],
  });
  const buffer = await docx.Packer.toBuffer(doc);
  fs.writeFileSync(abs, buffer);
  return abs;
}

/* ---------------- xlsx 读写 ---------------- */

/** exceljs cell 值 → 可 JSON 的基础值。 */
function normalizeCellValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value.richText === 'object' && value.richText) {
    return value.richText.map((r) => (r && r.text) || '').join('');
  }
  if (value.result !== undefined) return normalizeCellValue(value.result);
  if (value.text !== undefined) return value.text;
  if (value.hyperlink !== undefined) return value.text || value.hyperlink;
  return JSON.stringify(value);
}

/** .xlsx → { sheetNames, sheetName, rows }（rows 为二维基础值数组，空串补 null）。 */
async function readXlsx(filePath, sheetName) {
  const abs = resolveExisting(filePath);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(abs);
  const sheetNames = wb.worksheets.map((w) => w.name);
  const target = sheetName ? wb.getWorksheet(sheetName) : wb.worksheets[0];
  if (!target) throw new Error('工作表不存在：' + (sheetName || '(默认)') + '（可用：' + sheetNames.join(', ') + '）');
  const rows = [];
  let maxCols = 0;
  target.eachRow({ includeEmpty: false }, (row) => {
    const values = [];
    row.eachCell({ includeEmpty: false }, (cell) => {
      values[cell.col - 1] = normalizeCellValue(cell.value);
    });
    if (values.length > maxCols) maxCols = values.length;
    rows.push(values);
  });
  for (const r of rows) {
    for (let c = 0; c < maxCols; c += 1) if (r[c] === undefined) r[c] = null;
  }
  return { sheetNames, sheetName: target.name, rows };
}

/**
 * 写 .xlsx（覆盖）。sheets: [{ name?, rows: 二维基础值数组 }]。
 * rows 首行通常作为表头（写入原样，不做样式处理）。
 */
async function writeXlsx(filePath, { sheets }) {
  const abs = path.resolve(String(filePath));
  if (!Array.isArray(sheets) || !sheets.length) throw new Error('sheets 不能为空');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const rows = Array.isArray(s.rows) ? s.rows : [];
    const ws = wb.addWorksheet(s.name || 'Sheet1');
    rows.forEach((row, ri) => {
      if (!Array.isArray(row)) throw new Error('第 ' + (ri + 1) + ' 行不是数组');
      ws.addRow(row.map((v) => (v === null || v === undefined ? null : v)));
    });
  }
  await wb.xlsx.writeFile(abs);
  return abs;
}

module.exports = {
  readDocxText,
  markdownToDocx,
  readXlsx,
  writeXlsx,
  parseMarkdown,     // 供单测
  parseInline,       // 供单测
};

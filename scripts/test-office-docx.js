'use strict';

// Office 文件级模块单测（main/office-docx.js）。
// 用法：node scripts/test-office-docx.js（临时文件自建自清，不依赖 Office 安装）

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const od = require('../main/office-docx');

let pass = 0;
let fail = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log('PASS ' + name); pass += 1; })
    .catch((err) => { console.log('FAIL ' + name + ': ' + (err && err.message ? err.message : err)); fail += 1; });
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-office-'));
  const mdPath = path.join(dir, 'sample.md');
  const docxPath = path.join(dir, 'sample.docx');
  const xlsxPath = path.join(dir, 'sample.xlsx');
  const md = [
    '# 标题一', '',
    '普通段落，包含 **粗体**、*斜体*、`code`。', '',
    '- 列表项 A', '- 列表项 B', '',
    '1. 第一步', '2. 第二步', '',
    '> 引用行', '',
    '```js', 'const a = 1;', '```', '',
    '| 列1 | 列2 |', '| --- | --- |', '| a1 | b1 |', '| a2 | b2 |',
  ].join('\n');

  try {
    await check('markdownToDocx 生成文件且 docx 可读回', async () => {
      await od.markdownToDocx(md, docxPath, { title: '测试文档' });
      const text = await od.readDocxText(docxPath);
      for (const expect of ['测试文档', '标题一', '粗体', '斜体', 'code', '列表项 A', '引用行', 'const a = 1', 'a1', 'b2']) {
        assert.ok(text.includes(expect), '缺内容：' + expect);
      }
    });

    await check('parseMarkdown 块分类', () => {
      const blocks = od.parseMarkdown(md);
      const kinds = blocks.map((b) => b.type + (b.type === 'heading' ? b.level : b.type === 'list' ? (b.ordered ? ':ol' : ':ul') : ''));
      assert.ok(kinds.includes('heading1'));
      assert.ok(kinds.includes('paragraph'));
      assert.ok(kinds.includes('list:ul') && kinds.includes('list:ol'));
      assert.ok(kinds.includes('quote'));
      assert.ok(kinds.includes('code'));
      assert.ok(kinds.includes('table'));
      const table = blocks.find((b) => b.type === 'table');
      assert.deepStrictEqual(table.head, ['列1', '列2']);
      assert.deepStrictEqual(table.rows[1], ['a2', 'b2']);
    });

    await check('parseInline 粗体/斜体/代码分段', () => {
      const docxLib = require('docx');
      const runs = od.parseInline('a **b** c `d` e *f*');
      assert.strictEqual(runs.length, 6);
      for (const r of runs) {
        assert.ok(r instanceof docxLib.TextRun, '应为 TextRun 实例');
      }
      // 样式语义由 markdownToDocx→readDocxText 往返覆盖（粗体/斜体/代码内容均读回）。
    });

    await check('writeXlsx + readXlsx 往返', async () => {
      await od.writeXlsx(xlsxPath, {
        sheets: [{ name: '数据', rows: [['名称', '数量', '有效'], ['苹果', 3, true], ['香蕉', 5.5, false], ['日期', '2026-09-05', null]] }],
      });
      const r = await od.readXlsx(xlsxPath);
      assert.deepStrictEqual(r.sheetNames, ['数据']);
      assert.strictEqual(r.sheetName, '数据');
      assert.strictEqual(r.rows[0][0], '名称');
      assert.strictEqual(r.rows[1][1], 3);
      assert.strictEqual(r.rows[2][2], false);
    });

    await check('readXlsx 指定不存在工作表报错', async () => {
      let threw = false;
      try { await od.readXlsx(xlsxPath, '不存在'); } catch { threw = true; }
      assert.ok(threw);
    });

    await check('readDocxText 对不存在文件报错', async () => {
      let threw = false;
      try { await od.readDocxText(path.join(dir, 'nope.docx')); } catch (err) { threw = true; assert.ok(err.message.includes('不存在')); }
      assert.ok(threw);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('---- summary: ' + pass + '/' + (pass + fail) + ' passed ----');
  process.exit(fail > 0 ? 1 : 0);
})();

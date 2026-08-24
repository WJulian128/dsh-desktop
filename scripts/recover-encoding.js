// 当前 main.js 字节是 GBK 编码的近似原文（丢失字符变 '?'）。
// 解码为 UTF-8 写入，供后续逐处修复。
'use strict';
const fs = require('node:fs');
const iconv = require('iconv-lite');
const p = process.argv[2];
const buf = fs.readFileSync(p);
const text = iconv.decode(buf, 'gbk');
fs.writeFileSync(p, text, 'utf8');
console.log('decoded to utf8, chars:', text.length);

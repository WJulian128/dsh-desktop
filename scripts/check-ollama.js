const { execSync } = require('child_process');
const o = require('../main/ollama.js');
const bin = o.ollamaBin();
console.log('resolved bin:', bin);
if (!bin) { console.log('BIN NOT FOUND'); process.exit(1); }
try {
  const out = execSync(`"${bin}" --version`, { encoding: 'utf8', timeout: 20000, windowsHide: true });
  console.log('version ok:', out.trim());
} catch (e) {
  console.log('version ERR:', (e.message || String(e)).slice(0, 300));
  process.exit(2);
}

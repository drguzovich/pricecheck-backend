'use strict';

const fs = require('fs');
const path = require('path');

function parseCsvLine(line) {
  const values = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') { value += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) { values.push(value); value = ''; }
    else value += char;
  }
  values.push(value);
  return values;
}

const inputs = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['/home/ubuntu/research_sa_grocery_eans.csv'];
const output = path.join(__dirname, '..', 'data', 'seed-candidates.json');
const seen = new Set();
const candidates = [];

for (const input of inputs) {
  const lines = fs.readFileSync(input, 'utf8').trim().split(/\r?\n/);
  for (const line of lines.slice(1)) {
    const [, productName, barcode, sourceUrl, evidence, confidence] = parseCsvLine(line);
    if (!/^\d{8,14}$/.test(barcode || '') || confidence !== 'high' || seen.has(barcode)) continue;
    seen.add(barcode);
    candidates.push({ barcode, name: productName.trim(), sourceUrl: sourceUrl.trim(), evidence: evidence.trim() });
  }
}

fs.mkdirSync(path.dirname(output), { recursive: true });
if (candidates.length < 100) throw new Error(`Expected at least 100 verified exact EAN candidates; found ${candidates.length}.`);
const seedCandidates = candidates.slice(0, 100);
fs.writeFileSync(output, `${JSON.stringify(seedCandidates, null, 2)}\n`);
console.log(JSON.stringify({ candidates: seedCandidates.length, researchedCandidates: candidates.length, inputs, output }, null, 2));

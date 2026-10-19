'use strict';

function isValidGtin(barcode) {
  const value = String(barcode || '');
  if (!/^\d{8,14}$/.test(value)) return false;
  let sum = 0;
  for (let index = value.length - 2, weight = 3; index >= 0; index -= 1, weight = weight === 3 ? 1 : 3) {
    sum += Number(value[index]) * weight;
  }
  return (10 - (sum % 10)) % 10 === Number(value[value.length - 1]);
}

function validateSeedCandidates(candidates) {
  if (!Array.isArray(candidates)) throw new Error('Seed catalogue must be an array.');
  if (candidates.length !== 100) throw new Error(`Seed catalogue must contain exactly 100 candidates, found ${candidates.length}.`);
  const seen = new Set();
  const invalid = [];
  for (const [index, candidate] of candidates.entries()) {
    const barcode = String(candidate?.barcode || '');
    if (seen.has(barcode)) invalid.push(`#${index + 1} duplicate barcode ${barcode}`);
    seen.add(barcode);
    if (!isValidGtin(barcode)) invalid.push(`#${index + 1} invalid GS1 check digit ${barcode}`);
    if (!String(candidate?.name || '').trim()) invalid.push(`#${index + 1} missing product name`);
    if (!/^https:\/\//i.test(String(candidate?.sourceUrl || ''))) invalid.push(`#${index + 1} missing HTTPS source URL`);
  }
  if (invalid.length) throw new Error(`Seed catalogue validation failed: ${invalid.join('; ')}`);
  return { candidates: candidates.length, uniqueBarcodes: seen.size, checksumValid: true };
}

module.exports = { isValidGtin, validateSeedCandidates };

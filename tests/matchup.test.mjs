// 같은 라인의 모든 상대 조합에 문장을 만들어 보고, 비었거나 앞뒤가 안 맞는 문장을 찾아요.
//   node tests/matchup.test.mjs
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..') + path.sep;
const M = require(root + 'matchup.js');
const src = fs.readFileSync(root + 'index.html', 'utf8');
const D = Function('return {' + src.match(/const D=\{([\s\S]*?)\n\};/)[1] + '}')();
const R = Function('return {' + src.match(/const R=\{([\s\S]*?)\n\};/)[1] + '}')();
for (const k of Object.keys(R)) R[k] = R[k].split(',').filter(n => D[n]);
const notes = JSON.parse(fs.readFileSync(root + 'data/champ-notes.json', 'utf8'));
const mu = JSON.parse(fs.readFileSync(root + 'data/matchups.json', 'utf8'));
const idx = Object.fromEntries(notes.fields.map((f, i) => [f, i]));
const note = (c, f) => (notes.champions[c] || [])[idx[f]] || '';
const errs = [], cnt = { pairs: 0, hand: 0, v: { 1: 0, 0: 0, '-1': 0 } };
const seen = new Map();
function check(a, b, lane) {
  const pair = mu.pairs[a + '|' + b];
  const r = M.gen(a, b, { D, T: mu.traits, pair, note, role: lane.split('>')[0] });
  if (!r) { errs.push(`${lane} ${a}|${b}: 결과 없음`); return; }
  cnt.pairs++; if (pair) cnt.hand++; cnt.v[r.verdict]++;
  const all = r.lines.join(' ');
  if (pair ? (r.lines.length < 2 && pair.length < 100) : r.lines.length < 3) errs.push(`${lane} ${a}|${b}: 문장 ${r.lines.length}개뿐`);
  if (/undefined|null|NaN|\$\{/.test(all)) errs.push(`${lane} ${a}|${b}: 빈 값`);
  if (r.lines.some(l => !l.trim() || !/[.요)]$/.test(l.trim()))) errs.push(`${lane} ${a}|${b}: 끝맺음 이상`);
  if (r.verdict > 0 && /라인전은 [^.]*유리해요\([^)]*열세/.test(all)) errs.push(`${lane} ${a}|${b}: 판정 모순`);
  if ([a, b].some(n => new RegExp(n + '(이가|가이|은는|는은|을를|를을) ').test(all))) errs.push(`${lane} ${a}|${b}: 조사 이상`);
  if (/후반은 [^.]*더 강해요/.test(all) && /후반에 더 강해요/.test(all)) errs.push(`${lane} ${a}|${b}: 후반 모순`);
  for (const l of r.lines) seen.set(l, (seen.get(l) || 0) + 1);
}
for (const lane of ['TOP', 'JGL', 'MID', 'ADC', 'SUP'])
  for (const a of R[lane]) for (const b of R[lane]) if (a !== b) check(a, b, lane);
for (const a of R.SUP) for (const b of R.ADC) if (a !== b) { check(a, b, 'SUP>ADC'); check(b, a, 'ADC>SUP'); }
for (const k of Object.keys(mu.pairs)) { const [a, b] = k.split('|'); if (a === b) continue; }
console.log(`조합 ${cnt.pairs}개 · 직접 쓴 문장 ${cnt.hand}개 · 유리 ${cnt.v[1]} / 비슷 ${cnt.v[0]} / 불리 ${cnt.v[-1]}`);
const pc = new Map(); for (const v of Object.values(mu.pairs)) pc.set(v, (pc.get(v) || 0) + 1);
const handDup = [...pc].filter(([l, n]) => n > 1);
if (handDup.length) errs.push(`직접 쓴 문장이 그대로 겹침: ${handDup.slice(0, 5).map(x => x[0].slice(0, 30)).join(' / ')}`);
if (process.argv[2]) { const [a, b] = process.argv[2].split('|'); console.log(M.gen(a, b, { D, T: mu.traits, pair: mu.pairs[a + '|' + b], note, role: process.argv[3] }).lines.join('\n')); }
if (errs.length) { console.log(errs.slice(0, 40).join('\n'), `\n문제 ${errs.length}개`); process.exit(1); }
console.log('문제 없음');

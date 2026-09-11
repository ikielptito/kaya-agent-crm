// "The photos I sent were B6": reading the correction, and cutting a day's
// photos into the batches she sent them in.
import { parsePhotoCorrection, splitBatches, pickBatch } from '../lib/photo-correction.js';

let pass = 0, fail = 0;
const t = (name, got, expect) => {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(expect)}`); }
};
const B = ['tropicana-b2', 'tropicana-b3', 'tropicana-b5', 'tropicana-b6'];
const H = ['haus-1', 'haus-2', 'haus-4', 'haus-5'];
const HN = { 'haus-1': 'HAUS Canggu - Unit 1', 'haus-2': 'HAUS Canggu - Unit 2', 'haus-4': 'HAUS Canggu - Unit 4', 'haus-5': 'HAUS Canggu - Unit 5' };

t("Gede, 9 Sep: 'yang saya kirim ke dua itu foto di b6'", parsePhotoCorrection('yang saya kirim ke dua itu foto di b6', B), { slug: 'tropicana-b6', which: 'second' });
t('foto tadi salah, itu B3 → last batch to B3', parsePhotoCorrection('foto tadi salah, itu B3', B), { slug: 'tropicana-b3', which: 'last' });
t('foto pertama sebenarnya B2', parsePhotoCorrection('foto pertama sebenarnya B2', B), { slug: 'tropicana-b2', which: 'first' });
t('semua foto tadi B5', parsePhotoCorrection('semua foto tadi B5', B), { slug: 'tropicana-b5', which: 'all' });
t('Putu with a bare unit: foto tadi itu unit 2', parsePhotoCorrection('foto tadi itu unit 2', H, HN), { slug: 'haus-2', which: 'last' });
t('two villas named = not a correction', parsePhotoCorrection('foto b2 dan b6 sudah saya kirim', B), null);
t('no villa = not a correction', parsePhotoCorrection('foto tadi salah', B), null);
t('a caption is not a correction', parsePhotoCorrection('ini foto B3', B), null);
t('a question is not a correction', parsePhotoCorrection('foto tadi masuk ke B6?', B), null);
t('no word foto = nothing', parsePhotoCorrection('yang tadi itu B6', B), null);

const r = (min, i) => ({ path: `p${i}`, received_at: new Date(Date.UTC(2026, 8, 9, 6, min)).toISOString() });
const rows = [r(26, 1), r(26, 2), r(29, 3), r(29, 4), r(55, 5)];
t('a pair, a pair three minutes later, one half an hour on = three batches', splitBatches(rows).map(b => b.map(x => x.path)), [['p1', 'p2'], ['p3', 'p4'], ['p5']]);
t('a 2-minute gap cuts with a 2-minute rule', splitBatches(rows, 2 * 60e3).map(b => b.map(x => x.path)), [['p1', 'p2'], ['p3', 'p4'], ['p5']]);
const bs = splitBatches(rows, 2 * 60e3);
t('second batch', pickBatch(bs, 'second').map(x => x.path), ['p3', 'p4']);
t('last batch', pickBatch(bs, 'last').map(x => x.path), ['p5']);
t('all', pickBatch(bs, 'all').map(x => x.path), ['p1', 'p2', 'p3', 'p4', 'p5']);
t('a batch that does not exist', pickBatch(bs, 'third') && pickBatch([bs[0]], 'third'), null);
t('unsorted input is sorted first', splitBatches([r(29, 3), r(26, 1)], 60e3).map(b => b.map(x => x.path)), [['p1'], ['p3']]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

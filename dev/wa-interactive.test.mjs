// The native-control shapes: what Meta accepts, and what falls back.
import { buttonsPayload, listPayload, listAsText, parseTap, LIMITS } from '../lib/wa-interactive.js';

let pass = 0, fail = 0;
const t = (name, got, expect) => {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(expect)}`); }
};

// buttons
const b = buttonsPayload('62811', 'Applied #4', [{ id: 'mt:undo:4', title: 'Undo #4' }, 'Yes']);
t('three-or-fewer buttons become reply buttons with our ids', b.interactive.action.buttons.map(x => [x.reply.id, x.reply.title]), [['mt:undo:4', 'Undo #4'], ['Yes', 'Yes']]);
t('a fourth button is dropped', buttonsPayload('1', 'x', ['a', 'b', 'c', 'd']).interactive.action.buttons.length, 3);
t('a 21-char title is clipped', buttonsPayload('1', 'x', [{ id: 'a', title: 'Reassign to Gede Baglug' }]).interactive.action.buttons[0].reply.title.length, LIMITS.buttonTitle);
t('no buttons → null (caller sends text)', buttonsPayload('1', 'x', []), null);
t('body over 1024 → null', buttonsPayload('1', 'y'.repeat(1025), ['a']), null);

// lists
const rows = Array.from({ length: 10 }, (_, i) => ({ id: `villa:pick:v${i}`, title: `Villa ${i}`, description: 'd' }));
const l = listPayload('62811', { body: 'Which villa?', buttonLabel: 'Pick the villa', rows });
t('ten rows fit one list', l.interactive.action.sections[0].rows.length, 10);
t('the opener button is the label', l.interactive.action.button, 'Pick the villa');
t('eleven rows → null (caller numbers them)', listPayload('1', { body: 'x', rows: [...rows, { id: 'z', title: 'z' }] }), null);
t('row title clipped to 24', listPayload('1', { body: 'x', rows: [{ id: 'a', title: 'Tropicana Valley – Unit B5 (co-owned)' }] }).interactive.action.sections[0].rows[0].title.length, LIMITS.rowTitle);
t('sections keep their titles and drop empty ones', listPayload('1', { body: 'x', sections: [{ title: 'HAUS', rows: [{ id: 'a', title: 'A' }] }, { title: 'empty', rows: [] }] }).interactive.action.sections.map(s => s.title), ['HAUS']);
t('numbered fallback text', listAsText({ body: 'Which?', rows: [{ id: 'a', title: 'A', description: 'x' }, { id: 'b', title: 'B' }] }), 'Which?\n\n1. A — x\n2. B\n\nReply with the number.');

// taps
t('parseTap splits domain:verb:id', parseTap('villa:pick:tropicana-a5'), { domain: 'villa', verb: 'pick', id: 'tropicana-a5' });
t('template quick-reply labels are not taps', parseTap('Sudah selesai'), null);
t('legacy MAYA_QR ids are not taps', parseTap('MAYA_QR_0'), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

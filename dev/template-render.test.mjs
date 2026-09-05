// The inbox must show a template send the way the housekeeper saw it.
import { templateDef, renderTemplate, renderTemplateContent, parseButtonsMarker, buttonsMarker } from '../lib/template-render.js';

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got  ${g}\n       want ${w}`); }
};

// Meta's shape for samba_hk_task_v2, as the template list returns it.
const hkTaskV2 = {
  name: 'samba_hk_task_v2', status: 'APPROVED', language: 'id',
  components: [
    { type: 'BODY', text: 'Halo, ada jadwal untuk hari ini.\n\nVilla: {{1}}\nTugas: {{2}}\n\nKalau sudah selesai atau ada kendala, tekan tombol di bawah. Terima kasih.' },
    { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Sudah selesai' }, { type: 'QUICK_REPLY', text: 'Besok saja' }, { type: 'QUICK_REPLY', text: 'Tidak bisa' }] },
  ],
};
const tukangJob = {
  name: 'samba_tukang_job', language: 'id',
  components: [
    { type: 'BODY', text: 'Halo, ada pekerjaan di {{1}}: {{2}}. Biaya: {{3}}.' },
    { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Lihat detail', url: 'https://sambarentals.com/j/{{1}}' }] },
  ],
};

t('def: body + quick replies', templateDef(hkTaskV2).buttons.map(b => b.text), ['Sudah selesai', 'Besok saja', 'Tidak bisa']);
t('def: compact map entry accepted', templateDef({ name: 'x', body: 'Hi {{1}}', buttons: [] }).body, 'Hi {{1}}');

const r = renderTemplate(hkTaskV2, ['Tropicana Valley · Unit B3', 'bersih-bersih rutin']);
t('render: placeholders filled', r.text, 'Halo, ada jadwal untuk hari ini.\n\nVilla: Tropicana Valley · Unit B3\nTugas: bersih-bersih rutin\n\nKalau sudah selesai atau ada kendala, tekan tombol di bawah. Terima kasih.');
t('render: params flattened like the send', renderTemplate(hkTaskV2, ['A\nB', 'x    y']).text.includes('Villa: A B\nTugas: x   y'), true);
t('render: missing param is blank, not "undefined"', renderTemplate(hkTaskV2, ['Only one']).text.includes('Tugas: \n'), true);

const content = renderTemplateContent(hkTaskV2, ['Villa Saturno', 'siapkan villa']);
t('content: marker is the last line', content.endsWith('\n[buttons: Sudah selesai | Besok saja | Tidak bisa]'), true);
t('content: unknown template falls back to the label', renderTemplateContent(undefined, ['a'], { fallback: '[Housekeeping — X]' }), '[Housekeeping — X]');

const job = renderTemplateContent(tukangJob, ['Villa Rice', 'AC bocor', 'Rp 350.000'], { buttonSuffix: '12~abc' });
t('url button: suffix fills the link', job, 'Halo, ada pekerjaan di Villa Rice: AC bocor. Biaya: Rp 350.000.\n[button: Lihat detail → https://sambarentals.com/j/12~abc]');

t('parse: quick replies back out', parseButtonsMarker(content), { text: 'Halo, ada jadwal untuk hari ini.\n\nVilla: Villa Saturno\nTugas: siapkan villa\n\nKalau sudah selesai atau ada kendala, tekan tombol di bawah. Terima kasih.', buttons: [{ type: 'quick_reply', text: 'Sudah selesai' }, { type: 'quick_reply', text: 'Besok saja' }, { type: 'quick_reply', text: 'Tidak bisa' }] });
t('parse: url button back out', parseButtonsMarker(job).buttons, [{ type: 'url', text: 'Lihat detail', url: 'https://sambarentals.com/j/12~abc' }]);
t('parse: plain text untouched', parseButtonsMarker('Hi there'), { text: 'Hi there', buttons: [] });
t('parse: a legacy label is plain text', parseButtonsMarker('[Housekeeping — HAUS Canggu: Regular clean]').buttons, []);
t('marker: none without buttons', buttonsMarker([]), '');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

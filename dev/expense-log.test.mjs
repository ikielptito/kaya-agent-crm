// The expense gate and the amount reader, pinned.
import { looksLikeExpense, parseAmount } from '../lib/expense-log.js';
let pass = 0, fail = 0;
const t = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (ok) { pass++; console.log(`  ok  ${n}`); } else { fail++; console.log(`  FAIL ${n}\n       got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); } };
t('laundry with rb', looksLikeExpense('laundry HAUS 5 250rb'), true);
t('bought gallons', looksLikeExpense('beli galon 3x untuk Saturno 60.000'), true);
t('receipt line with idr', looksLikeExpense('paid PLN for A5 1,250,000'), true);
t('a ticket reply is not an expense', looksLikeExpense('#15 estimate 85,000'), false);
t('a statement change is not mine', looksLikeExpense('forgot to deduct the curtains 2,500,000 from A5 August'), false);
t('a question is not an expense', looksLikeExpense('siapa yang clean Saturno besok?'), false);
t('no amount, no expense', looksLikeExpense('bought soap for HAUS 2'), false);
t('250rb', parseAmount('250rb'), 250000);
t('1,2jt', parseAmount('1,2jt'), 1200000);
t('1.250.000', parseAmount('1.250.000'), 1250000);
t('60.000', parseAmount('60.000'), 60000);
t('85,000', parseAmount('85,000'), 85000);
t('no number', parseAmount('galon'), null);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);

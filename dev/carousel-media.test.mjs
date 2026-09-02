// The Monday digest lost 14 of 213 sends on 31 Aug 2026 to 131053: Meta
// fetching card images from our host, once per recipient, and hitting a cold
// cache or a Google hiccup somewhere in the ~1,200-fetch burst. Cards now go
// out as media ids uploaded once per run; a failed upload keeps the link so
// a send is never worse than before.
import { buildCarouselComponents, uploadCardMedia } from '../lib/wa-carousel.js';

let pass = 0, fail = 0;
const t = (name, got, expect) => {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(expect)}`); }
};
const card = (n, extra = {}) => ({ name: `Villa ${n}`, area: 'Canggu', detail: '30jt/mo', slug: `villa-${n}`, imageUrl: `https://sambarentals.com/api/media?source=img&id=${n}`, ...extra });

// 1. id wins over link; a card without an id still sends by link.
{
  const comps = buildCarouselComponents('Wayan', [card('a', { imageId: 'MEDIA_A' }), card('b')], 'hi');
  const headers = comps[1].cards.map(c => c.components[0].parameters[0].image);
  t('media id used when present', headers[0], { id: 'MEDIA_A' });
  t('link kept when no id', headers[1], { link: card('b').imageUrl });
}

// 2. uploader: one upload per unique url, id stamped on every card sharing it,
//    a failed upload leaves the link, nothing throws.
{
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/media?source=img')) {
      if (u.endsWith('id=bad')) return { ok: false, status: 500, headers: new Headers() };
      return { ok: true, headers: new Headers({ 'content-type': 'image/jpeg' }), arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    }
    if (u.endsWith('/PHONE/media')) {
      calls.push(opts.body.get('type'));
      return { ok: true, json: async () => ({ id: `MEDIA_${calls.length}` }) };
    }
    throw new Error('unexpected ' + u);
  };
  const cards = [card('x'), card('y'), card('x'), card('bad')];
  const up = await uploadCardMedia(cards, { token: 'T', phoneId: 'PHONE' });
  globalThis.fetch = realFetch;
  t('one upload per unique image', calls.length, 2);
  t('upload count', [up.uploaded, up.failed], [2, 1]);
  t('shared image shares the id', [cards[0].imageId, cards[2].imageId], ['MEDIA_1', 'MEDIA_1']);
  t('second image gets its own id', cards[1].imageId, 'MEDIA_2');
  t('failed upload keeps link', cards[3].imageId, undefined);
  t('mime forwarded', calls[0], 'image/jpeg');
}

// 3. no credentials → no-op, cards untouched.
{
  const cards = [card('z')];
  const up = await uploadCardMedia(cards, {});
  t('no creds is a no-op', [up.uploaded, up.failed, cards[0].imageId], [0, 0, undefined]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

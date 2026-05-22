// Shared knowledge base for Claude-generated replies (server-side)

export const PORTFOLIO_CONTEXT = `KAYA Developments portfolio (current):
- Clay House | Cepaka | 1BR apartment | $80K promo | 30yr leasehold | 75% complete | July 2026 delivery | 3 units available
- Tropicana Valley | Buduk | 1BR townhouse with private pool | from $125K | 27yr leasehold | move-in ready | 4 units available
- Palem Kembar | Ungasan | 3BR villa with private pool | from $299K | Freehold | 85% complete, finishing resumed | 2 units available
- Sabit House | Berawa | 1BR apartment | $150K | Freehold pre-construction | 9 units available
- LaneHAUS | Pererenan | 1BR townhouse | Unit 1: 1.5B IDR / Unit 3: 1.3B IDR | 27yr leasehold | Ikiel personal property, not a KAYA project
Standard agent commission: 5%

Samba Realty portfolio: 14 villas and apartments across Canggu, Pererenan and Seminyak.
Agent portal with live availability: https://sambarentals.vercel.app
Rental commission: 10% per booking.`;

// Project key -> brochure public URL (Supabase Storage). Fill in real URLs after upload.
export const BROCHURES = {
  clay_house:       { url: '', filename: 'KAYA-ClayHouse.pdf',       label: 'Clay House' },
  tropicana_valley: { url: '', filename: 'KAYA-TropicanaValley.pdf', label: 'Tropicana Valley' },
  palem_kembar:     { url: '', filename: 'KAYA-PalemKembar.pdf',     label: 'Palem Kembar' },
  sabit_house:      { url: '', filename: 'KAYA-SabitHouse.pdf',      label: 'Sabit House' },
};

export const REPLY_TONE = `Tone rules:
- Conversational and warm, never corporate or stiff
- Short sentences, natural rhythm
- No em dashes (use -- if needed)
- No emojis
- Concise and scannable
- Sound like a real person (you are replying on behalf of Ikiel from KAYA)
- Never mention that you are an AI`;

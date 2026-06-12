// Anonymous, RLS-protected Supabase access for the taste test. These values
// are public by design (publishable key + RLS policies allow only voting and
// reading tallies); env vars override for other deployments.
const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://nvdkhatenkjmbyudwbgm.supabase.co';
const SUPABASE_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? 'sb_publishable_oM34s0Y3Lxysr5oDF0fx7g_ODj-49o3';

const HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

export interface TasteVote {
  run_id: string;
  question_id: string;
  model_a: string;
  model_b: string;
  winner: 'a' | 'b' | 'tie';
}

export async function castTasteVote(vote: TasteVote): Promise<boolean> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/taste_votes`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify(vote),
      cache: 'no-store',
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface TasteWinrate {
  model_id: string;
  battles: number;
  win_rate: number;
}

export async function getTasteWinrates(): Promise<TasteWinrate[] | null> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/taste_winrates?select=*`, {
      headers: HEADERS,
      next: { revalidate: 300 },
    });
    if (!res.ok) return null;
    const rows = (await res.json()) as TasteWinrate[];
    return rows.length > 0 ? rows : null;
  } catch {
    return null;
  }
}

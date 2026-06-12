import { ImageResponse } from 'next/og';
import { computeTasteRatings } from '@cookingbench/core';
import { getLatestReport } from '@/lib/data';
import { getAllTasteVotes } from '@/lib/supabase';

export const alt = 'CookingBench Taste Board — AI chefs ranked by blind human votes';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const revalidate = 300;

const MEDALS = ['#c8401a', '#d98e2b', '#7a8b3f', '#4a6b8a', '#6b4660'];

export default async function OpenGraphImage() {
  // Top of the board, if enough votes exist; the card degrades gracefully.
  let rows: Array<{ name: string; rating: string }> = [];
  try {
    const votes = await getAllTasteVotes();
    if (votes && votes.length > 0) {
      const names = new Map(
        (getLatestReport()?.rows ?? []).map((r) => [r.modelId, r.displayName]),
      );
      rows = computeTasteRatings(votes)
        .filter((r) => r.battles >= 5)
        .slice(0, 5)
        .map((r) => ({
          name: names.get(r.modelId) ?? r.modelId,
          rating: String(Math.round(r.rating)),
        }));
    }
  } catch {
    // Plain card without standings.
  }

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          background: '#faf6ef',
          color: '#1c1917',
          padding: '64px 72px',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, paddingRight: 48 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
            <svg width="56" height="56" viewBox="0 0 64 64">
              <rect width="64" height="64" rx="14" fill="#c8401a" />
              <g fill="#faf6ef">
                <circle cx="21" cy="27" r="9.5" />
                <circle cx="32" cy="22.5" r="11" />
                <circle cx="43" cy="27" r="9.5" />
                <rect x="14.5" y="27" width="35" height="12" />
                <rect x="19" y="42.5" width="26" height="6.5" rx="2" />
              </g>
            </svg>
            <div style={{ display: 'flex', fontSize: 40, fontWeight: 700, letterSpacing: -1 }}>
              Cooking<span style={{ color: '#c8401a' }}>Bench</span>
            </div>
          </div>
          <div
            style={{
              marginTop: 56,
              fontSize: 76,
              fontWeight: 700,
              letterSpacing: -3,
              lineHeight: 1.05,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <span style={{ display: 'flex' }}>
              The&nbsp;
              <span
                style={{ color: '#c8401a', borderBottom: '6px solid #c8401a', paddingBottom: 4 }}
              >
                taste
              </span>
              &nbsp;board
            </span>
            <span style={{ fontSize: 40, fontWeight: 400, color: '#57534e', marginTop: 18, letterSpacing: -1 }}>
              AI chefs ranked by blind human votes
            </span>
          </div>
          <div style={{ marginTop: 'auto', fontSize: 26, color: '#57534e' }}>
            cookingbench.com/taste — Bradley-Terry ratings, never blended with precision
          </div>
        </div>
        {rows.length > 0 && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              gap: 18,
              width: 380,
              borderLeft: '2px solid #e4ddd0',
              paddingLeft: 48,
            }}
          >
            {rows.map((row, i) => (
              <div
                key={row.name}
                style={{ display: 'flex', alignItems: 'center', gap: 16, fontSize: 28 }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 40,
                    height: 40,
                    borderRadius: 20,
                    background: MEDALS[i],
                    color: '#faf6ef',
                    fontSize: 22,
                    fontWeight: 700,
                  }}
                >
                  {i + 1}
                </div>
                <div style={{ display: 'flex', flex: 1 }}>{row.name}</div>
                <div style={{ display: 'flex', fontWeight: 700 }}>{row.rating}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    ),
    size,
  );
}

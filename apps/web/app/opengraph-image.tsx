import { ImageResponse } from 'next/og';
import { getLatestReport } from '@/lib/data';
import { formatScore } from '@/lib/format';

export const alt = 'CookingBench — which AI model is the best chef?';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

const MEDALS = ['#c8401a', '#d98e2b', '#7a8b3f', '#4a6b8a', '#6b4660'];

export default function OpenGraphImage() {
  let rows: Array<{ name: string; score: string }> = [];
  try {
    rows = (getLatestReport()?.rows ?? [])
      .slice(0, 5)
      .map((r) => ({ name: r.displayName, score: formatScore(r.overall) }));
  } catch {
    // Fall back to the plain card if run data is unavailable at build time.
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
            <span>Which AI model</span>
            <span style={{ display: 'flex' }}>
              is the best&nbsp;
              <span
                style={{
                  color: '#c8401a',
                  borderBottom: '6px solid #c8401a',
                  paddingBottom: 4,
                }}
              >
                chef
              </span>
              ?
            </span>
          </div>
          <div style={{ marginTop: 'auto', fontSize: 26, color: '#57534e' }}>
            cookingbench.com — quantities · conversions · food safety · technique · flavour
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
                <div style={{ display: 'flex', fontWeight: 700 }}>{row.score}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    ),
    size,
  );
}

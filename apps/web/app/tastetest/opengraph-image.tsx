import { ImageResponse } from 'next/og';

// The card cannot promise more than the measurement claim does. A share image
// reading "two AI chefs" would be wrong twice over: the Tasting Flight runs on
// authored fixture proposals, and what it measures is which one a reader would
// rather cook — not which tastes better.
export const alt =
  'CookingBench Tasting Flight — five blind rounds, two proposals each, you pick the one you would rather cook';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

function Toque({ color, size: s }: { color: string; size: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 64 64">
      <g fill={color}>
        <circle cx="21" cy="27" r="9.5" />
        <circle cx="32" cy="22.5" r="11" />
        <circle cx="43" cy="27" r="9.5" />
        <rect x="14.5" y="27" width="35" height="12" />
        <rect x="19" y="42.5" width="26" height="6.5" rx="2" />
      </g>
    </svg>
  );
}

function DishCard({ label, color }: { label: string; color: string }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: 300,
        background: '#fffcf6',
        border: '3px solid #1c1917',
        padding: '28px 32px',
        gap: 18,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <Toque color={color} size={42} />
        <div style={{ display: 'flex', fontSize: 28, fontWeight: 700 }}>{label}</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {[210, 160, 185].map((w, i) => (
          <div key={i} style={{ display: 'flex', width: w, height: 10, background: '#e4ddd0' }} />
        ))}
      </div>
    </div>
  );
}

export default function OpenGraphImage() {
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
              fontSize: 72,
              fontWeight: 700,
              letterSpacing: -3,
              lineHeight: 1.08,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <span>Five rounds.</span>
            <span>No names.</span>
            <span
              style={{
                color: '#c8401a',
                borderBottom: '6px solid #c8401a',
                paddingBottom: 4,
                alignSelf: 'flex-start',
              }}
            >
              Which would you cook?
            </span>
          </div>
          <div style={{ marginTop: 'auto', fontSize: 26, color: '#57534e' }}>
            cookingbench.com/tastetest — blind, about three minutes
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
            position: 'relative',
          }}
        >
          <div style={{ display: 'flex', transform: 'rotate(-3deg)' }}>
            <DishCard label="Proposal A" color="#4a6b8a" />
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 84,
              height: 84,
              borderRadius: 42,
              background: '#c8401a',
              border: '5px solid #faf6ef',
              color: '#faf6ef',
              fontSize: 32,
              fontWeight: 700,
              marginTop: -26,
              marginBottom: -26,
              zIndex: 1,
            }}
          >
            VS
          </div>
          <div style={{ display: 'flex', transform: 'rotate(3deg)' }}>
            <DishCard label="Proposal B" color="#7a8b3f" />
          </div>
        </div>
      </div>
    ),
    size,
  );
}

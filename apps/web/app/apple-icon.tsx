import { ImageResponse } from 'next/og';

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

// Same toque mark as icon.svg, rendered to PNG for Apple devices (no rounded
// corners - iOS applies its own mask).
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#c8401a',
        }}
      >
        <svg width="148" height="148" viewBox="0 0 64 64">
          <g fill="#faf6ef">
            <circle cx="21" cy="27" r="9.5" />
            <circle cx="32" cy="22.5" r="11" />
            <circle cx="43" cy="27" r="9.5" />
            <rect x="14.5" y="27" width="35" height="12" />
            <rect x="19" y="42.5" width="26" height="6.5" rx="2" />
          </g>
        </svg>
      </div>
    ),
    size,
  );
}

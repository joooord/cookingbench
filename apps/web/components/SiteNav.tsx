'use client';

import { useState } from 'react';
import Link from 'next/link';

const NAV = [
  { href: '/', label: 'Leaderboard' },
  { href: '/tastetest', label: 'Taste Test' },
  { href: '/taste', label: 'Taste Board' },
  { href: '/questions', label: 'Questions' },
  { href: '/methodology', label: 'Methodology' },
] as const;

export function SiteNav() {
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* Desktop */}
      <nav className="hidden gap-8 text-sm sm:flex">
        {NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="text-ink-soft transition-colors hover:text-paprika"
          >
            {item.label}
          </Link>
        ))}
      </nav>

      {/* Mobile burger */}
      <button
        type="button"
        aria-label={open ? 'Close menu' : 'Open menu'}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex h-11 w-11 items-center justify-center sm:hidden"
      >
        <svg width="27" height="27" viewBox="0 0 22 22" aria-hidden="true">
          {open ? (
            <g stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
              <line x1="5" y1="5" x2="17" y2="17" />
              <line x1="17" y1="5" x2="5" y2="17" />
            </g>
          ) : (
            // A menu burger that is also, proudly, a burger.
            <g stroke="currentColor" strokeLinecap="round" fill="none">
              {/* bun top */}
              <path d="M4 8.5 A7 5.5 0 0 1 18 8.5" strokeWidth="1.7" />
              {/* sesame seeds */}
              <g stroke="none" fill="currentColor">
                <circle cx="8.6" cy="6.1" r="0.8" />
                <circle cx="13.4" cy="6.1" r="0.8" />
              </g>
              {/* patty */}
              <line x1="4" y1="12" x2="18" y2="12" strokeWidth="2.4" />
              {/* bun bottom */}
              <line x1="4.5" y1="16" x2="17.5" y2="16" strokeWidth="1.7" />
            </g>
          )}
        </svg>
      </button>

      {open && (
        <nav className="absolute inset-x-0 top-full z-10 border-b border-hairline bg-paper sm:hidden">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setOpen(false)}
              className="block border-t border-hairline px-6 py-4 text-sm text-ink-soft transition-colors hover:text-paprika"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      )}
    </>
  );
}

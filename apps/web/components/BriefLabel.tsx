'use client';

import { useEffect, useState } from 'react';

/**
 * "Tonight's brief" is only right in the evening. The visitor's clock lives
 * in the browser, so this hydrates to a time-of-day label after mount and
 * server-renders a safe default.
 */
export function BriefLabel() {
  const [label, setLabel] = useState('The brief');

  useEffect(() => {
    const hour = new Date().getHours();
    setLabel(
      hour < 5
        ? 'The late-shift brief'
        : hour < 12
          ? 'This morning’s brief'
          : hour < 17
            ? 'This afternoon’s brief'
            : 'Tonight’s brief',
    );
  }, []);

  return <>{label}</>;
}

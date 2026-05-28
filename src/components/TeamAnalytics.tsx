'use client';

import { Analytics } from '@vercel/analytics/next';

export function TeamAnalytics() {
  return (
    <Analytics
      beforeSend={(event) => {
        const url = new URL(event.url);
        const team = url.searchParams.get('team');
        if (team) {
          url.pathname = `${url.pathname}/${team}`;
          url.search = '';
          return { ...event, url: url.toString() };
        }
        return event;
      }}
    />
  );
}

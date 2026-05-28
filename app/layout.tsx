import { ClerkProvider } from '@clerk/nextjs';
import { SpeedInsights } from '@vercel/speed-insights/next';
import { TeamAnalytics } from '@/components/TeamAnalytics';
import type { Metadata } from 'next';
import '@/index.css';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Tiny Teams Analyzer',
  description: 'Analyze and optimize your Tiny Teams Baseball roster',
};

function AuthProvider({ children }: { children: React.ReactNode }) {
  if (process.env.AUTH_DISABLED === 'true') {
    return <>{children}</>;
  }
  return (
    <ClerkProvider signInForceRedirectUrl="/app" signUpForceRedirectUrl="/app">
      {children}
    </ClerkProvider>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <html lang="en">
        <body className="bg-slate-950 text-slate-100">
          {children}
          <TeamAnalytics />
          <SpeedInsights />
        </body>
      </html>
    </AuthProvider>
  );
}

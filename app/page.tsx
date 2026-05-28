import { redirect } from 'next/navigation';

export default async function LandingPage() {
  if (process.env.AUTH_DISABLED === 'true') {
    redirect('/app');
  }

  const { auth } = await import('@clerk/nextjs/server');
  const { userId } = await auth();
  if (userId) redirect('/app');

  const { SignInButton, SignUpButton } = await import('@clerk/nextjs');

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4">
      <div className="w-full max-w-md space-y-8 text-center">
        <div>
          <h1 className="text-4xl font-bold tracking-tight text-slate-100">
            Tiny Teams Analyzer
          </h1>
          <p className="mt-3 text-sm text-slate-400">
            Analyze rosters, optimize lineups, and get AI-powered insights for
            Tiny Teams Baseball.
          </p>
        </div>

        <div className="flex flex-col gap-3">
          <SignInButton mode="redirect" forceRedirectUrl="/app">
            <button
              type="button"
              className="w-full rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white shadow hover:bg-emerald-500"
            >
              Sign in
            </button>
          </SignInButton>
          <SignUpButton mode="redirect" forceRedirectUrl="/app">
            <button
              type="button"
              className="w-full rounded-lg border border-slate-700 px-4 py-2.5 text-sm font-medium text-slate-200 hover:bg-slate-800"
            >
              Create account
            </button>
          </SignUpButton>
        </div>

        <p className="text-xs text-slate-600">
          A companion app for{' '}
          <a
            href="https://www.tiny-teams.com"
            className="text-slate-400 underline-offset-2 hover:underline"
            target="_blank"
            rel="noopener noreferrer"
          >
            Tiny Teams Baseball
          </a>{' '}
          by Knightmare Games
        </p>
      </div>
    </div>
  );
}

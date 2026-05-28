import { redirect } from 'next/navigation';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  if (process.env.AUTH_DISABLED !== 'true') {
    const { auth } = await import('@clerk/nextjs/server');
    const { userId } = await auth();
    if (!userId) redirect('/');
  }
  return <>{children}</>;
}

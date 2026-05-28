import { NextResponse, type NextRequest, type NextFetchEvent } from 'next/server';

export default async function middleware(req: NextRequest, event: NextFetchEvent) {
  if (process.env.AUTH_DISABLED === 'true') {
    return NextResponse.next();
  }

  const { clerkMiddleware, createRouteMatcher } = await import('@clerk/nextjs/server');
  const isProtectedRoute = createRouteMatcher(['/app(.*)']);

  const handler = clerkMiddleware(async (auth, innerReq) => {
    const pathname = new URL(innerReq.url).pathname;
    if (isProtectedRoute(innerReq) || (pathname.startsWith('/api/') && !pathname.startsWith('/api/webhooks'))) {
      await auth.protect();
    }
  });

  return handler(req, event);
}

export const config = {
  matcher: ['/((?!_next|.*\\..*).*)'],
};

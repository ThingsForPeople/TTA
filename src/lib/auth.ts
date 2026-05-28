const authDisabled = process.env.AUTH_DISABLED === 'true';

export async function getUser(): Promise<string | null> {
  if (authDisabled) return 'local-dev';
  const { auth } = await import('@clerk/nextjs/server');
  const { userId } = await auth();
  return userId;
}

export { authDisabled };

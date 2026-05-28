'use client';

import { useUser, UserButton } from '@clerk/nextjs';

const AUTH_DISABLED = process.env.NEXT_PUBLIC_AUTH_DISABLED === 'true';

export function useAuthUser(): string | undefined {
  if (AUTH_DISABLED) return 'local-dev';
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const { user } = useUser();
  return user?.id;
}

export function AuthUserButton() {
  if (AUTH_DISABLED) return null;
  return <UserButton appearance={{ elements: { avatarBox: 'h-7 w-7' } }} />;
}

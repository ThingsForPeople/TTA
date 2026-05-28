import { db, hasDb } from '@/db';
import { users } from '@/db/schema';
import { headers } from 'next/headers';

export async function POST(req: Request) {
  if (!hasDb()) {
    return new Response('Database not configured', { status: 503 });
  }

  const secret = process.env.CLERK_WEBHOOK_SECRET;
  if (!secret) {
    return new Response('Webhook secret not configured', { status: 500 });
  }

  const headerPayload = await headers();
  const svixId = headerPayload.get('svix-id');
  const svixTimestamp = headerPayload.get('svix-timestamp');
  const svixSignature = headerPayload.get('svix-signature');

  if (!svixId || !svixTimestamp || !svixSignature) {
    return new Response('Missing svix headers', { status: 400 });
  }

  const body = await req.text();
  const { Webhook } = await import('svix');
  const wh = new Webhook(secret);

  let event: { type: string; data: Record<string, unknown> };
  try {
    event = wh.verify(body, {
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': svixSignature,
    }) as typeof event;
  } catch {
    return new Response('Invalid signature', { status: 400 });
  }

  if (event.type === 'user.created' || event.type === 'user.updated') {
    const d = event.data;
    const emails = d.email_addresses as { email_address: string }[] | undefined;
    await db
      .insert(users)
      .values({
        id: d.id as string,
        email: emails?.[0]?.email_address ?? null,
        name: [d.first_name, d.last_name].filter(Boolean).join(' ') || null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: users.id,
        set: {
          email: emails?.[0]?.email_address ?? null,
          name: [d.first_name, d.last_name].filter(Boolean).join(' ') || null,
          updatedAt: new Date(),
        },
      });
  }

  return new Response('ok', { status: 200 });
}

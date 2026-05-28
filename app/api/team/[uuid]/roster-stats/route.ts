export async function GET(
  req: Request,
  { params }: { params: Promise<{ uuid: string }> },
) {
  const { uuid } = await params;

  const { searchParams } = new URL(req.url);
  const upstream = new URL(
    `https://www.tiny-teams.com/api/team-search/teams/${uuid}/roster-stats`,
  );
  for (const [key, value] of searchParams.entries()) {
    upstream.searchParams.set(key, value);
  }

  const res = await fetch(upstream.toString(), {
    headers: { Accept: 'application/json' },
  });

  if (!res.ok) {
    return Response.json(
      { error: `Upstream returned ${res.status}` },
      { status: res.status },
    );
  }

  const json = await res.json();
  return Response.json(json);
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ uuid: string; gameId: string }> },
) {
  const { uuid, gameId } = await params;

  const url = `https://www.tiny-teams.com/api/team-search/teams/${uuid}/games/${gameId}`;
  const res = await fetch(url, {
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

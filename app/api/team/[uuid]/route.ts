import { parseTeamHtml } from '@/lib/parseTeam';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ uuid: string }> },
) {
  const { uuid } = await params;

  const url = `https://www.tiny-teams.com/team-search/${uuid}`;
  const res = await fetch(url, {
    headers: { Accept: 'text/html' },
    next: { revalidate: 60 },
  });

  if (!res.ok) {
    return Response.json(
      { error: `Upstream returned ${res.status}` },
      { status: res.status },
    );
  }

  const html = await res.text();
  const parsed = parseTeamHtml(html);
  return Response.json(parsed);
}

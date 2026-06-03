import { getUser, authDisabled } from '@/lib/auth';
import { SYSTEM_PROMPT } from '@/lib/system-prompt';
import { checkRateLimit } from '@/lib/rate-limit';

const MAX_CONTEXT_LEN = 50_000;
// The recruit and talent-advisor tools build structured prompts (stat lines,
// talent option lists, multi-point instructions) that legitimately run past a
// chat-sized cap — 2k silently truncated their closing instructions mid-word.
// Generous but still bounded (context is the large field, capped separately).
const MAX_QUESTION_LEN = 8_000;
const MAX_HISTORY_TURNS = 6;

const ALLOWED_ACTION_TYPES = new Set(['talent-advisor', 'recruit', 'insight', 'game-analysis', 'matchup-analysis']);

export async function POST(req: Request) {
  const userId = await getUser();
  if (!userId) return new Response('Unauthorized', { status: 401 });

  const body = await req.json();
  const context = typeof body.context === 'string' ? body.context.slice(0, MAX_CONTEXT_LEN) : '';
  const compactContext = typeof body.compactContext === 'string' ? body.compactContext.slice(0, MAX_CONTEXT_LEN) : '';
  const preComputedInsights = typeof body.preComputedInsights === 'string' ? body.preComputedInsights.slice(0, MAX_CONTEXT_LEN) : '';
  const question = typeof body.question === 'string' ? body.question.slice(0, MAX_QUESTION_LEN) : '';
  const history = Array.isArray(body.history) ? body.history.slice(0, MAX_HISTORY_TURNS) : [];
  const teamUuid = typeof body.teamUuid === 'string' ? body.teamUuid : undefined;
  const actionType = typeof body.actionType === 'string' && ALLOWED_ACTION_TYPES.has(body.actionType)
    ? body.actionType
    : 'insight';

  if (!context || !question) {
    return Response.json({ error: 'Missing context or question' }, { status: 400 });
  }

  if (process.env.NODE_ENV === 'development') {
    const encoder = new TextEncoder();
    return streamFromLocalClaude({ context, question, history, encoder });
  }

  if (!teamUuid) {
    return Response.json({ error: 'Missing teamUuid' }, { status: 400 });
  }

  let userInfo: { email?: string; name?: string | null } | undefined;
  if (!authDisabled) {
    const { currentUser } = await import('@clerk/nextjs/server');
    const clerkUser = await currentUser();
    userInfo = clerkUser
      ? { email: clerkUser.emailAddresses?.[0]?.emailAddress, name: [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(' ') || null }
      : undefined;
  }

  const limit = await checkRateLimit(userId, teamUuid, actionType, userInfo);
  const rateLimitHeaders = {
    'X-RateLimit-Remaining': String(limit.remaining),
    'X-RateLimit-Reset': String(limit.resetsAt),
  };

  if (!limit.ok) {
    return Response.json(
      { error: limit.message, remaining: limit.remaining, resetsAt: limit.resetsAt },
      { status: 429, headers: rateLimitHeaders },
    );
  }

  const encoder = new TextEncoder();
  return streamFromGemini({ context, question, history, encoder, rateLimitHeaders });
}

async function streamFromLocalClaude({
  context,
  question,
  history = [],
  encoder,
}: {
  context: string;
  question: string;
  history?: { question: string; response: string }[];
  encoder: TextEncoder;
}) {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');

  let prompt = `Here is the current state of the team:\n\n${context}\n\n---\n\n`;
  for (const turn of history) {
    prompt += `User: ${turn.question}\n\nAssistant: ${turn.response}\n\n`;
  }
  prompt += `User: ${question}`;

  const q = query({
    prompt,
    options: {
      model: 'claude-sonnet-4-6',
      tools: [],
      systemPrompt: SYSTEM_PROMPT,
      includePartialMessages: true,
      cwd: process.cwd(),
    },
  });

  const readable = new ReadableStream({
    async start(controller) {
      try {
        for await (const msg of q) {
          if (msg.type === 'stream_event') {
            const ev = msg.event;
            if (
              ev.type === 'content_block_delta' &&
              ev.delta.type === 'text_delta'
            ) {
              controller.enqueue(encoder.encode(ev.delta.text));
            }
          } else if (msg.type === 'assistant' && msg.error) {
            controller.enqueue(encoder.encode(`\n\n[error: ${msg.error}]`));
          } else if (msg.type === 'result' && msg.subtype !== 'success') {
            controller.enqueue(encoder.encode(`\n\n[${msg.subtype}]`));
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        controller.enqueue(encoder.encode(`\n\n[error: ${message}]`));
      }
      controller.close();
    },
  });

  return new Response(readable, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' },
  });
}

async function streamFromGemini({
  context,
  question,
  history = [],
  encoder,
  rateLimitHeaders = {},
}: {
  context: string;
  question: string;
  history?: { question: string; response: string }[];
  encoder: TextEncoder;
  rateLimitHeaders?: Record<string, string>;
}) {
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const ai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

  const model = ai.getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite',
    systemInstruction: { role: 'user', parts: [{ text: SYSTEM_PROMPT }] },
    generationConfig: { maxOutputTokens: 16384 },
  });

  const contents: { role: 'user' | 'model'; parts: { text: string }[] }[] = [];
  const contextBlock = `Here is the current state of the team:\n\n${context}\n\n---\n\n`;
  for (const turn of history) {
    contents.push({ role: 'user', parts: [{ text: turn.question }] });
    contents.push({ role: 'model', parts: [{ text: turn.response }] });
  }
  contents.push({ role: 'user', parts: [{ text: contextBlock + question }] });

  const result = await model.generateContentStream({ contents });

  const readable = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of result.stream) {
          const text = chunk.text();
          if (text) {
            controller.enqueue(encoder.encode(text));
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        controller.enqueue(encoder.encode(`\n\n[error: ${msg}]`));
      }
      controller.close();
    },
  });

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
      ...rateLimitHeaders,
    },
  });
}

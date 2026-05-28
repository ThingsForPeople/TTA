import { getUser } from '@/lib/auth';
import { SYSTEM_PROMPT } from '@/lib/system-prompt';

export async function POST(req: Request) {
  if (process.env.NODE_ENV !== 'development') {
    return Response.json({ error: 'Not available in production' }, { status: 403 });
  }

  const userId = await getUser();
  if (!userId) return new Response('Unauthorized', { status: 401 });

  const { context, question, history } = await req.json();

  if (!context || !question) {
    return Response.json({ error: 'Missing context or question' }, { status: 400 });
  }

  const encoder = new TextEncoder();
  return streamFromLocalClaude({ context, question, history, encoder });
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
}: {
  context: string;
  question: string;
  history?: { question: string; response: string }[];
  encoder: TextEncoder;
}) {
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const ai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

  const model = ai.getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite',
    systemInstruction: { role: 'user', parts: [{ text: SYSTEM_PROMPT }] },
    generationConfig: { maxOutputTokens: 4096 },
  });

  const contextBlock = `Here is the current state of the team:\n\n${context}\n\n---\n\n`;
  const contents: { role: 'user' | 'model'; parts: { text: string }[] }[] = [];

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
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' },
  });
}

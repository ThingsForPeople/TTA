function looksLikeMarkdown(content: string): boolean {
  return /^#{1,4} |\*\*[^*]+\*\*|^- |^\d+\. /m.test(content) && !/<[a-z][\s>]/i.test(content);
}

function markdownToHtml(md: string): string {
  let html = md
    .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');

  // Convert bullet lists
  html = html.replace(/(?:^- .+$\n?)+/gm, (block) => {
    const items = block.trim().split('\n').map((line) =>
      `<li>${line.replace(/^- /, '')}</li>`
    ).join('');
    return `<ul>${items}</ul>`;
  });

  // Convert numbered lists
  html = html.replace(/(?:^\d+\. .+$\n?)+/gm, (block) => {
    const items = block.trim().split('\n').map((line) =>
      `<li>${line.replace(/^\d+\. /, '')}</li>`
    ).join('');
    return `<ol>${items}</ol>`;
  });

  // Wrap remaining bare lines as paragraphs
  html = html.replace(/^(?!<[a-z])(.+)$/gm, (_, line) => {
    const trimmed = line.trim();
    if (!trimmed) return '';
    return `<p>${trimmed}</p>`;
  });

  return html;
}

interface Props {
  content: string;
  className?: string;
}

export function Markdown({ content, className }: Props) {
  const html = looksLikeMarkdown(content) ? markdownToHtml(content) : content;
  return (
    <div
      className={`ai-html ${className ?? ''}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

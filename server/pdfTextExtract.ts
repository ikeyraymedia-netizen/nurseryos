/** Extract readable text from a PDF buffer for AI / spreadsheet-style parsing. */

export async function extractPdfText(buffer: Buffer): Promise<{
  text: string;
  totalPages: number;
}> {
  const { extractText } = await import('unpdf');
  const result = await extractText(new Uint8Array(buffer), { mergePages: true });
  const rawText = result.text as string | string[] | undefined;
  const raw =
    typeof rawText === 'string'
      ? rawText
      : Array.isArray(rawText)
        ? rawText.join('\n')
        : '';
  const text = raw.replace(/\u0000/g, '').replace(/[ \t]+\n/g, '\n').trim();
  return {
    text,
    totalPages: Number(result.totalPages) || 0
  };
}

/** Split long availability text into overlapping chunks for Gemini. */
export function chunkPdfText(text: string, maxChars = 28_000, overlap = 400): string[] {
  const cleaned = text.trim();
  if (!cleaned) return [];
  if (cleaned.length <= maxChars) return [cleaned];

  const chunks: string[] = [];
  let start = 0;
  while (start < cleaned.length) {
    let end = Math.min(start + maxChars, cleaned.length);
    if (end < cleaned.length) {
      const slice = cleaned.slice(start, end);
      const lastBreak = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('\n'));
      if (lastBreak > maxChars * 0.55) {
        end = start + lastBreak;
      }
    }
    const piece = cleaned.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= cleaned.length) break;
    start = Math.max(0, end - overlap);
  }
  return chunks;
}

/** Extracts the first JSON object from model output (tolerates code fences and preambles). */
export function parseJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = (fenced?.[1] ?? text).trim();
  try {
    return JSON.parse(body);
  } catch {
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('no JSON object in model output');
    return JSON.parse(body.slice(start, end + 1));
  }
}

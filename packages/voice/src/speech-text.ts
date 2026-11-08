/** Turns a chat answer into something pleasant to hear: no markdown, code, URLs or memory ids. */
export function toSpeakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' I put the code in the chat. ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)]\((?:https?:)?[^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/\s*\(m:[0-9a-f]{6,12}\)/gi, '')
    .replace(/\[m:[0-9a-f]{6,12}]/gi, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/(\*\*|__|\*|_|~~)(.+?)\1/g, '$2')
    .replace(/\|/g, ', ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}

/**
 * Splits streamed text into sentences so speech can start before the answer is complete.
 * Very long sentences are cut at a comma or space so the first audio isn't delayed.
 */
export class SentenceChunker {
  private buffer = '';
  private readonly minChars: number;
  private readonly maxChars: number;

  constructor(opts: { minChars?: number; maxChars?: number } = {}) {
    this.minChars = opts.minChars ?? 12;
    this.maxChars = opts.maxChars ?? 220;
  }

  push(delta: string): string[] {
    this.buffer += delta;
    const out: string[] = [];
    while (true) {
      const re = /[.!?…](?=\s)|\n/g;
      let cut = -1;
      for (let m = re.exec(this.buffer); m; m = re.exec(this.buffer)) {
        if (m.index + 1 >= this.minChars) {
          cut = m.index + 1;
          break;
        }
      }
      if (cut === -1 && this.buffer.length > this.maxChars) {
        const window = this.buffer.slice(0, this.maxChars);
        cut = Math.max(window.lastIndexOf(', ') + 1, window.lastIndexOf(' '));
        if (cut <= 0) cut = this.maxChars;
      }
      if (cut === -1) break;
      const sentence = this.buffer.slice(0, cut).trim();
      this.buffer = this.buffer.slice(cut);
      if (sentence) out.push(sentence);
    }
    return out;
  }

  flush(): string | undefined {
    const rest = this.buffer.trim();
    this.buffer = '';
    return rest || undefined;
  }
}

const STOP_COMMAND = /^\s*(?:hey\s+)?(?:feroxes[,!.]?\s+)?(?:stop|halt|freeze|abort)(?:\s+(?:everything|now|all))?\s*[.!]*\s*$/i;

/** "Feroxes, stop" — the spoken kill switch (architecture §9.4). */
export const isStopCommand = (transcript: string) => STOP_COMMAND.test(transcript);

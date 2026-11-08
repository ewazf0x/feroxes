import { github, gitlab, vscode } from './dev.ts';
import type { Connector } from './framework.ts';
import { google, notion, outlook } from './productivity.ts';
import { discord, instagram, reddit, slack, telegram, whatsapp } from './social.ts';

export * from './framework.ts';
export * from './dev.ts';
export * from './productivity.ts';
export * from './social.ts';

/** Every built-in connector, in the order the Integrations screen shows them. */
export function builtinConnectors(opts: { vscodeCommand?: string } = {}): Connector[] {
  return [instagram, discord, telegram, whatsapp, slack, reddit, google, outlook, notion, github, gitlab, vscode(opts.vscodeCommand ? { command: opts.vscodeCommand } : {})];
}

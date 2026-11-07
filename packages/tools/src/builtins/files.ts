import { lstat, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { type AnyTool, defineTool, z } from '../define.ts';

/**
 * Resolves a model-supplied path inside the workspace root, refusing anything that escapes it:
 * absolute paths, "..", and symlinks that point outside (checked on the real path).
 */
export async function resolveInside(root: string, userPath: string): Promise<string> {
  if (isAbsolute(userPath)) throw new Error('Use a path relative to the workspace.');
  if (userPath.includes('\0')) throw new Error('Invalid path.');
  const realRoot = await realpath(root);
  const target = resolve(realRoot, userPath);
  const inside = (p: string) => p === realRoot || p.startsWith(realRoot + sep);
  if (!inside(target)) throw new Error('Path is outside the workspace.');

  // Walk up to the deepest existing ancestor and check its real path (catches symlinked dirs).
  let probe = target;
  while (true) {
    try {
      const real = await realpath(probe);
      if (!inside(real)) throw new Error('Path is outside the workspace (symlink).');
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  return target;
}

const MAX_READ = 200_000;
const MAX_WRITE = 2_000_000;

export function fileTools(root: string): AnyTool[] {
  const rel = (p: string) => relative(root, p) || '.';

  const read = defineTool({
    name: 'files.read',
    toolset: 'files',
    description: 'Read a UTF-8 text file from the Feroxes workspace.',
    input: z.object({ path: z.string().min(1).max(500) }),
    risk: { category: 'read', reversible: true },
    idempotent: true,
    async execute({ path }) {
      const file = await resolveInside(root, path);
      const info = await stat(file);
      if (!info.isFile()) return { content: `${path} is not a file.`, isError: true };
      const text = (await readFile(file, 'utf8')).slice(0, MAX_READ);
      return { content: text, data: { bytes: info.size, truncated: info.size > MAX_READ } };
    },
  });

  const list = defineTool({
    name: 'files.list',
    toolset: 'files',
    description: 'List files and folders in a workspace directory.',
    input: z.object({ path: z.string().max(500).default('.') }),
    risk: { category: 'read', reversible: true },
    idempotent: true,
    async execute({ path }) {
      const dir = await resolveInside(root, path);
      const entries = await readdir(dir, { withFileTypes: true });
      const lines = entries.slice(0, 500).map((e) => `${e.isDirectory() ? 'dir ' : 'file'}  ${rel(join(dir, e.name))}`);
      return { content: lines.length ? lines.join('\n') : '(empty)', data: { count: entries.length } };
    },
  });

  const write = defineTool({
    name: 'files.write',
    toolset: 'files',
    description: 'Create or overwrite a UTF-8 text file in the Feroxes workspace. Overwriting an existing file needs approval.',
    input: z.object({ path: z.string().min(1).max(500), content: z.string().max(MAX_WRITE), overwrite: z.boolean().default(false) }),
    risk: { category: 'internal_write', reversible: true },
    // Overwriting loses the old content, so it is treated as destructive.
    riskFor: (input) => (input.overwrite ? 'destructive' : 'internal_write'),
    idempotent: false,
    preview: ({ path, content, overwrite }) => ({ title: `${overwrite ? 'Overwrite' : 'Create'} ${path}`, body: content.slice(0, 2000) }),
    async execute({ path, content, overwrite }) {
      const file = await resolveInside(root, path);
      const exists = await lstat(file).then(() => true, () => false);
      if (exists && !overwrite) return { content: `${path} already exists. Set overwrite to true to replace it.`, isError: true };
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, content, 'utf8');
      return { content: `Wrote ${content.length} characters to ${path}.` };
    },
  });

  const remove = defineTool({
    name: 'files.delete',
    toolset: 'files',
    description: 'Delete a file from the Feroxes workspace. Always needs approval.',
    input: z.object({ path: z.string().min(1).max(500) }),
    risk: { category: 'destructive', reversible: false },
    idempotent: false,
    preview: ({ path }) => ({ title: `Delete ${path}`, body: 'The file is removed permanently.' }),
    async execute({ path }) {
      const file = await resolveInside(root, path);
      if (file === (await realpath(root))) return { content: 'Refusing to delete the workspace itself.', isError: true };
      const info = await lstat(file).catch(() => undefined);
      if (!info) return { content: `${path} does not exist.`, isError: true };
      if (info.isDirectory()) return { content: `${path} is a directory; only files can be deleted.`, isError: true };
      await rm(file);
      return { content: `Deleted ${path}.` };
    },
  });

  return [read, list, write, remove] as unknown as AnyTool[];
}

import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { z } from '@feroxes/tools';
import { type Connector, ConnectorError, bearer, clip, lines } from './framework.ts';

const repo = { owner: z.string().min(1).max(100), repo: z.string().min(1).max(100) };

/** GitHub REST API (docs.github.com/rest), with a fine-grained personal access token. */
export const github: Connector = {
  id: 'github',
  name: 'GitHub',
  category: 'developer',
  docsUrl: 'https://docs.github.com/en/rest',
  auth: { kind: 'token', fields: [{ key: 'access_token', label: 'Fine-grained personal access token', secret: true, placeholder: 'github_pat_…', help: 'github.com → Settings → Developer settings → Fine-grained tokens. Give it only the repositories and permissions you want Feroxes to have.' }] },
  capabilities: [
    { id: 'read', label: 'Read repositories, issues, pull requests and notifications', description: 'Repository contents, issues, PRs, notifications.', default: true },
    { id: 'issues_write', label: 'Create and close issues', description: 'Needs the token permission Issues: read and write.', default: false },
    { id: 'comment', label: 'Comment on issues and pull requests', description: 'Posts under your name.', default: false },
  ],
  limitations: [
    'What Feroxes can reach is exactly what the token allows; fine-grained tokens can be limited to chosen repositories and expire.',
    'Rate limit: 5,000 requests per hour per token.',
    'Real-time events (webhooks) need a public URL; Feroxes reads on demand instead.',
  ],
  setupSteps: ['Create a fine-grained token at github.com/settings/personal-access-tokens.', 'Choose repositories; grant Contents, Issues, Pull requests and Notifications as needed (read-only is enough to start).', 'Paste it here.'],
  defaultHeaders: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
  baseUrl: () => 'https://api.github.com',
  sign: bearer(),
  async whoami(api) {
    const u = await api.request<{ id: number; login: string }>('GET', '/user');
    return { id: String(u.id), name: u.login };
  },
  actions: [
    {
      name: 'github.notifications',
      capability: 'read',
      category: 'read',
      untrusted: 'message',
      liveSafe: true,
      description: 'Unread GitHub notifications (mentions, review requests, CI).',
      input: z.object({ all: z.boolean().default(false) }),
      async run(i, { api }) {
        const n = await api.request<{ id: string; reason: string; subject: { title: string; type: string }; repository: { full_name: string }; updated_at: string }[]>('GET', '/notifications', { query: { all: i.all as boolean, per_page: 30 } });
        return { text: lines(n.map((x) => `${x.repository.full_name}: ${x.subject.type} "${clip(x.subject.title, 120)}" (${x.reason}, ${x.updated_at})`), 'No unread notifications.'), data: n.length };
      },
    },
    {
      name: 'github.repos',
      capability: 'read',
      category: 'read',
      liveSafe: true,
      description: 'Repositories you can access, most recently updated first.',
      input: z.object({}),
      async run(_i, { api }) {
        const r = await api.request<{ full_name: string; private: boolean; open_issues_count: number; pushed_at: string; description: string | null }[]>('GET', '/user/repos', { query: { sort: 'updated', per_page: 30 } });
        return { text: lines(r.map((x) => `${x.full_name}${x.private ? ' (private)' : ''}: ${x.open_issues_count} open issues, pushed ${x.pushed_at}${x.description ? ` — ${clip(x.description, 80)}` : ''}`)) };
      },
    },
    {
      name: 'github.search_issues',
      capability: 'read',
      category: 'read',
      untrusted: 'message',
      description: 'Search issues and pull requests with GitHub search syntax (e.g. "is:open assignee:@me").',
      input: z.object({ query: z.string().min(1).max(256) }),
      async run(i, { api }) {
        const r = await api.request<{ total_count: number; items: { number: number; title: string; state: string; html_url: string; repository_url: string; pull_request?: unknown }[] }>('GET', '/search/issues', { query: { q: i.query as string, per_page: 20 } });
        return { text: `${r.total_count} results\n${lines(r.items.map((x) => `${x.repository_url.split('/repos/')[1]}#${x.number} ${x.pull_request ? '[PR]' : '[issue]'} ${x.state}: ${clip(x.title, 120)}`))}` };
      },
    },
    {
      name: 'github.issue',
      capability: 'read',
      category: 'read',
      untrusted: 'message',
      description: 'Read one issue or pull request with its latest comments.',
      input: z.object({ ...repo, number: z.number().int().positive() }),
      async run(i, { api }) {
        const base = `/repos/${encodeURIComponent(String(i.owner))}/${encodeURIComponent(String(i.repo))}/issues/${Number(i.number)}`;
        const issue = await api.request<{ title: string; state: string; user: { login: string }; body: string | null }>('GET', base);
        const comments = await api.request<{ user: { login: string }; body: string; created_at: string }[]>('GET', `${base}/comments`, { query: { per_page: 20 } });
        return { text: `#${String(i.number)} ${issue.title} (${issue.state}) by ${issue.user.login}\n${clip(issue.body, 3000)}\n\nComments:\n${lines(comments.map((c) => `- ${c.user.login} (${c.created_at}): ${clip(c.body, 600)}`), '(none)')}` };
      },
    },
    {
      name: 'github.file',
      capability: 'read',
      category: 'read',
      untrusted: 'document',
      description: 'Read a text file from a repository.',
      input: z.object({ ...repo, path: z.string().min(1).max(500), ref: z.string().max(200).optional() }),
      async run(i, { api }) {
        const f = await api.request<{ type: string; encoding?: string; content?: string; size: number }>('GET', `/repos/${encodeURIComponent(String(i.owner))}/${encodeURIComponent(String(i.repo))}/contents/${String(i.path).split('/').map(encodeURIComponent).join('/')}`, { query: { ref: i.ref as string | undefined } });
        if (f.type !== 'file' || f.encoding !== 'base64' || !f.content) throw new ConnectorError('bad_request', `${String(i.path)} is not a readable text file.`);
        return { text: clip(Buffer.from(f.content, 'base64').toString('utf8'), 20_000) };
      },
    },
    {
      name: 'github.create_issue',
      capability: 'issues_write',
      category: 'external_write',
      description: 'Open a new issue.',
      input: z.object({ ...repo, title: z.string().min(1).max(256), body: z.string().max(20_000).default(''), labels: z.array(z.string().max(50)).max(10).default([]) }),
      preview: (i) => ({ title: `Open an issue in ${String(i.owner)}/${String(i.repo)}`, body: `${String(i.title)}\n\n${String(i.body ?? '')}` }),
      async run(i, { api }) {
        const r = await api.request<{ number: number; html_url: string }>('POST', `/repos/${encodeURIComponent(String(i.owner))}/${encodeURIComponent(String(i.repo))}/issues`, { json: { title: i.title, body: i.body, labels: i.labels } });
        return { text: `Opened #${r.number}: ${r.html_url}`, data: r };
      },
    },
    {
      name: 'github.close_issue',
      capability: 'issues_write',
      category: 'external_write',
      description: 'Close an issue (it can be reopened).',
      input: z.object({ ...repo, number: z.number().int().positive(), reason: z.enum(['completed', 'not_planned']).default('completed') }),
      preview: (i) => ({ title: `Close ${String(i.owner)}/${String(i.repo)}#${String(i.number)} (${String(i.reason)})` }),
      async run(i, { api }) {
        await api.request('PATCH', `/repos/${encodeURIComponent(String(i.owner))}/${encodeURIComponent(String(i.repo))}/issues/${Number(i.number)}`, { json: { state: 'closed', state_reason: i.reason } });
        return { text: `Closed #${String(i.number)}.` };
      },
    },
    {
      name: 'github.comment',
      capability: 'comment',
      category: 'communicate',
      description: 'Comment on an issue or pull request (posted under your name).',
      input: z.object({ ...repo, number: z.number().int().positive(), body: z.string().min(1).max(20_000) }),
      preview: (i) => ({ title: `Comment on ${String(i.owner)}/${String(i.repo)}#${String(i.number)}`, body: String(i.body) }),
      async run(i, { api }) {
        const r = await api.request<{ html_url: string }>('POST', `/repos/${encodeURIComponent(String(i.owner))}/${encodeURIComponent(String(i.repo))}/issues/${Number(i.number)}/comments`, { json: { body: i.body } });
        return { text: `Commented: ${r.html_url}` };
      },
    },
  ],
};

/** GitLab REST API v4 (docs.gitlab.com/api), gitlab.com or a self-managed instance. */
export const gitlab: Connector = {
  id: 'gitlab',
  name: 'GitLab',
  category: 'developer',
  docsUrl: 'https://docs.gitlab.com/api/rest/',
  auth: {
    kind: 'token',
    fields: [
      { key: 'access_token', label: 'Personal access token', secret: true, placeholder: 'glpat-…', help: 'GitLab → Preferences → Access tokens. Scope read_api to read; api to create issues and comments.' },
      { key: 'base_url', label: 'GitLab URL (self-managed only)', secret: false, placeholder: 'https://gitlab.com', optional: true },
    ],
  },
  capabilities: [
    { id: 'read', label: 'Read projects, issues and merge requests', description: '', default: true },
    { id: 'write', label: 'Create issues and comments', description: 'Needs the api scope.', default: false },
  ],
  limitations: ['Access follows the token scopes and your project roles.', 'gitlab.com rate limits apply (about 2,000 requests per minute per user).'],
  setupSteps: ['Create a personal access token (read_api, or api for writing).', 'Paste it here; add your instance URL if you self-host GitLab.'],
  baseUrl: (s) => `${(s.base_url || 'https://gitlab.com').replace(/\/$/, '')}/api/v4`,
  sign: bearer(),
  async whoami(api) {
    const u = await api.request<{ id: number; username: string }>('GET', '/user');
    return { id: String(u.id), name: u.username };
  },
  actions: [
    {
      name: 'gitlab.projects',
      capability: 'read',
      category: 'read',
      liveSafe: true,
      description: 'Projects you are a member of, most recently active first.',
      input: z.object({}),
      async run(_i, { api }) {
        const p = await api.request<{ id: number; path_with_namespace: string; open_issues_count?: number; last_activity_at: string }[]>('GET', '/projects', { query: { membership: true, order_by: 'last_activity_at', per_page: 30, simple: true } });
        return { text: lines(p.map((x) => `[${x.id}] ${x.path_with_namespace}${x.open_issues_count !== undefined ? `: ${x.open_issues_count} open issues` : ''} (active ${x.last_activity_at})`)) };
      },
    },
    {
      name: 'gitlab.my_work',
      capability: 'read',
      category: 'read',
      untrusted: 'message',
      description: 'Open issues and merge requests assigned to you.',
      input: z.object({}),
      async run(_i, { api }) {
        const q = { scope: 'assigned_to_me', state: 'opened', per_page: 30 };
        const [issues, mrs] = await Promise.all([api.request<{ references: { full: string }; title: string }[]>('GET', '/issues', { query: q }), api.request<{ references: { full: string }; title: string }[]>('GET', '/merge_requests', { query: q })]);
        return { text: `Issues:\n${lines(issues.map((x) => `${x.references.full} ${clip(x.title, 120)}`), '(none)')}\n\nMerge requests:\n${lines(mrs.map((x) => `${x.references.full} ${clip(x.title, 120)}`), '(none)')}` };
      },
    },
    {
      name: 'gitlab.create_issue',
      capability: 'write',
      category: 'external_write',
      description: 'Create an issue in a project (id or full path).',
      input: z.object({ project: z.string().min(1).max(300), title: z.string().min(1).max(255), description: z.string().max(20_000).default('') }),
      preview: (i) => ({ title: `Create a GitLab issue in ${String(i.project)}`, body: `${String(i.title)}\n\n${String(i.description ?? '')}` }),
      async run(i, { api }) {
        const r = await api.request<{ iid: number; web_url: string }>('POST', `/projects/${encodeURIComponent(String(i.project))}/issues`, { json: { title: i.title, description: i.description } });
        return { text: `Created #${r.iid}: ${r.web_url}` };
      },
    },
    {
      name: 'gitlab.comment',
      capability: 'write',
      category: 'communicate',
      description: 'Comment on an issue (posted under your name).',
      input: z.object({ project: z.string().min(1).max(300), issue: z.number().int().positive(), body: z.string().min(1).max(20_000) }),
      preview: (i) => ({ title: `Comment on ${String(i.project)}#${String(i.issue)}`, body: String(i.body) }),
      async run(i, { api }) {
        await api.request('POST', `/projects/${encodeURIComponent(String(i.project))}/issues/${Number(i.issue)}/notes`, { json: { body: i.body } });
        return { text: 'Comment posted.' };
      },
    },
  ],
};

/**
 * Visual Studio Code has no web API. Feroxes uses its official command-line interface (`code`) on
 * this PC: open files and folders, show diffs, list and install extensions.
 */
export function vscode(opts: { command?: string; run?: (args: string[]) => Promise<{ code: number | null; out: string }> } = {}): Connector {
  const cmd = opts.command ?? (process.platform === 'win32' ? 'code.cmd' : 'code');
  const run =
    opts.run ??
    ((args: string[]) =>
      new Promise<{ code: number | null; out: string }>((resolve, reject) => {
        // shell: false, arguments as an array; on Windows code.cmd needs cmd.exe, so arguments are validated paths/ids only.
        const child = spawn(cmd, args, { shell: process.platform === 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
        child.stderr.on('data', (d: Buffer) => (out += d.toString('utf8')));
        child.on('error', () => reject(new ConnectorError('setup', 'The `code` command was not found. In VS Code run "Shell Command: Install \'code\' command in PATH".')));
        child.on('close', (code) => resolve({ code, out }));
      }));
  const absPath = z.string().min(1).max(1000).refine((p) => isAbsolute(p) && !/["&|<>^%\r\n]/.test(p), 'an absolute path without shell characters');
  return {
    id: 'vscode',
    name: 'Visual Studio Code',
    category: 'developer',
    docsUrl: 'https://code.visualstudio.com/docs/configure/command-line',
    auth: { kind: 'none' },
    capabilities: [
      { id: 'open', label: 'Open files, folders and diffs', description: 'Opens windows on this PC.', default: true },
      { id: 'extensions', label: 'List and install extensions', description: 'Installing runs third-party code: always asks.', default: false },
    ],
    limitations: ['Uses the `code` CLI on the PC that runs Feroxes; reading the open editor or diagnostics would need a VS Code extension (not built yet).'],
    setupSteps: ['In VS Code: Command Palette → "Shell Command: Install \'code\' command in PATH" (macOS/Linux; Windows adds it at install).'],
    baseUrl: () => 'about:blank',
    sign: () => {},
    async whoami() {
      return { id: 'local', name: 'This PC' };
    },
    actions: [
      {
        name: 'vscode.open',
        capability: 'open',
        category: 'device_control',
        description: 'Open a file (optionally at a line) or folder in VS Code.',
        input: z.object({ path: absPath, line: z.number().int().positive().optional() }),
        preview: (i) => ({ title: `Open ${String(i.path)} in VS Code` }),
        async run(i) {
          const r = await run(i.line ? ['--goto', `${String(i.path)}:${Number(i.line)}`] : [String(i.path)]);
          if (r.code !== 0) throw new ConnectorError('server', clip(r.out, 300) || `code exited with ${r.code}`);
          return { text: `Opened ${String(i.path)} in VS Code.` };
        },
      },
      {
        name: 'vscode.diff',
        capability: 'open',
        category: 'device_control',
        description: 'Show a side-by-side diff of two files in VS Code.',
        input: z.object({ left: absPath, right: absPath }),
        async run(i) {
          const r = await run(['--diff', String(i.left), String(i.right)]);
          if (r.code !== 0) throw new ConnectorError('server', clip(r.out, 300));
          return { text: 'Diff opened in VS Code.' };
        },
      },
      {
        name: 'vscode.extensions',
        capability: 'extensions',
        category: 'read',
        liveSafe: true,
        description: 'List installed VS Code extensions with versions.',
        input: z.object({}),
        async run() {
          const r = await run(['--list-extensions', '--show-versions']);
          return { text: r.out.trim() || 'No extensions installed.' };
        },
      },
      {
        name: 'vscode.install_extension',
        capability: 'extensions',
        category: 'security',
        description: 'Install a VS Code extension by id (publisher.name). Installing runs third-party code.',
        input: z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/i, 'publisher.name') }),
        preview: (i) => ({ title: `Install the VS Code extension ${String(i.id)}`, body: 'Extensions can run code on this PC.' }),
        async run(i) {
          const r = await run(['--install-extension', String(i.id)]);
          if (r.code !== 0) throw new ConnectorError('server', clip(r.out, 300));
          return { text: clip(r.out, 500) };
        },
      },
    ],
  };
}

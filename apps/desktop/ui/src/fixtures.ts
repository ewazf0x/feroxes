/**
 * Canned data for demo/preview mode (index.html?demo=1): lets the UI render fully without a Core,
 * for screenshots, design review and a friendly first-run before anything is connected.
 */
const now = Date.now();
const ago = (m: number) => now - m * 60_000;

const status = { name: 'Feroxes', selfVersion: 7, boots: 23, since: now - 19 * 864e5, state: 'running', power: 'normal', attention: 'ambient', voice: true, providers: [{ id: 'kiro', name: 'Kiro (main brain)' }, { id: 'anthropic', name: 'Anthropic' }, { id: 'openai', name: 'OpenAI' }], approvals: 1, devicesOnline: 2, spendToday: { spent: 184_000_000, limit: 2_000_000_000 } };

const messages = [
  { id: 'm1', seq: 1, role: 'user', content: 'Can you tidy my Downloads folder and tell me if anything looks risky?' },
  { id: 'm2', seq: 2, role: 'assistant', content: "I'll take a look at what's there first.", toolCalls: [{ id: 't1', name: 'desktop__files', args: { path: 'Downloads' } }], meta: { modelId: 'kiro/balanced' } },
  { id: 'm3', seq: 3, role: 'tool', toolName: 'desktop__files', content: '47 files, 12.3 GB. Largest: ubuntu-24.iso (5.8 GB), screen-recording.mov (2.1 GB). 3 installers older than 90 days.' },
  { id: 'm4', seq: 4, role: 'assistant', content: "Here's the picture:\n\n- **12.3 GB** across 47 files. The two biggest are an Ubuntu ISO and an old screen recording.\n- **3 installers** are over 90 days old and safe to remove.\n- Nothing looks malicious. One file, `invoice_2026.pdf.exe`, is disguised as a PDF — I'd delete that one.\n\nWant me to move the old installers and that disguised file to the bin? I'll ask before deleting (m:9c21ab40).", meta: { modelId: 'kiro/balanced', costNanoUsd: 4_200_000, memoryIds: ['9c21ab40'] } },
];

const approvals = [{ id: 'a1', tool: 'desktop.delete', category: 'destructive', preview: { title: 'Move 4 files to the bin on Studio-PC', body: 'invoice_2026.pdf.exe\nnode-v18-setup.exe (112 days old)\npython-3.11.exe (134 days old)\nold-driver.msi (201 days old)' }, policyReason: 'destructive → ask', taint: [{ kind: 'screen', source: 'desktop:Studio-PC' }] }];

const goals = [
  { id: 'g1', title: 'Ship the Feroxes desktop app', horizon: 'month', progress: 0.55, status: 'active' },
  { id: 'g2', title: 'Run a half marathon in spring', horizon: 'long', progress: 0.3, status: 'active' },
  { id: 'g3', title: 'Keep the Downloads folder under 5 GB', horizon: 'week', progress: 0, status: 'proposed' },
];

const mind = {
  self: { version: 7, identity: { role: 'Personal AI agent of Sam: second brain and second hand', firstBootAt: status.since, bootCount: 23 }, values: ['Loyal to the owner, never against them', 'Honest; admits mistakes', 'The owner stays in control', 'Protects privacy'], boundaries: ['No self-modification without approval', 'No actions in banking or password apps'], currentFocus: ['Ship the desktop app', 'Keep mornings calm'], lessons: ['Sam prefers short answers before 10am'] },
  versions: Array.from({ length: 7 }, (_, i) => ({ version: i + 1 })),
  growth: 'Over the last 7 days: 34 runs (2 failed), $1.12 spent, 3 self-model updates. Lessons learned: Sam prefers short mornings; double-check calendar times in the local zone. Forecast calibration improving: Brier 0.18 over 11 predictions.',
  quality: { successRate: 0.94, corrections: 2, loopsCaught: 1, denied: 1 },
  calibration: { brier: 0.18, resolved: 11 },
  beliefs: [
    { cause: 'coffee after 4pm', effect: 'poor sleep', confidence: 0.82, domain: 'health' },
    { cause: 'poor sleep', effect: 'missed deadlines', confidence: 0.64, domain: 'work' },
    { cause: 'morning run', effect: 'better focus', confidence: 0.7, domain: 'health' },
  ],
  research: [{ status: 'done', question: 'Which standing desk under €600 fits a 150cm alcove?' }, { status: 'running', question: 'Best way to back up 2TB of photos off-site' }],
  improvements: [{ text: 'Ask once for the preferred date format and remember it.' }],
};

const devices = [
  { id: 'd1', name: 'Studio-PC', kind: 'desktop', platform: 'windows', online: true, capabilities: Array(11).fill(0), state: {} },
  { id: 'd2', name: 'Pixel', kind: 'phone', platform: 'android', online: true, capabilities: Array(9).fill(0), state: { battery: { percent: 72, charging: false } } },
];

const usage = {
  budgets: [
    { budget: { id: 'g1', name: 'Global daily', limit: 2_000_000_000 }, counter: { spent: 184_000_000 }, percent: 9.2 },
    { budget: { id: 'g2', name: 'Global monthly', limit: 30_000_000_000 }, counter: { spent: 3_120_000_000 }, percent: 10.4 },
    { budget: { id: 'g3', name: 'Background daily', limit: 250_000_000 }, counter: { spent: 210_000_000 }, percent: 84 },
  ],
  byModel: [
    { key: 'kiro/balanced', calls: 128, cost: 0 },
    { key: 'anthropic/claude-haiku-5.5', calls: 342, cost: 190_000_000 },
    { key: 'openai/text-embedding-3-small', calls: 512, cost: 12_000_000 },
  ],
};

const memories = [
  { id: 'mem-11119c21ab40', kind: 'relationship', pinned: true, sensitivity: 'private', content: "The owner's sister is named Leila and lives in Lyon." },
  { id: 'mem-2222aa31', kind: 'preference', sensitivity: 'normal', content: 'Prefers short answers without bullet lists for casual questions.' },
  { id: 'mem-3333bb77', kind: 'rule', sensitivity: 'normal', content: 'Always confirm before sending email or messages.' },
  { id: 'mem-4444cc90', kind: 'fact', sensitivity: 'private', content: 'Allergic to peanuts.' },
];

const today = {
  status,
  briefing: { text: "Good morning, Sam. It's quiet so far. Your only fixed item is a 14:00 call with the design team. The desktop-app goal is at 55% — the Windows build is the next step. One thing waits for you: moving 4 old files out of Downloads. Studio-PC has 6 GB of disk left, so clearing those would help." },
  situation: { facts: [], anomalies: [{ severity: 'warning', message: 'Studio-PC has 6 GB of disk free', suggestion: 'I can list the largest folders.' }] },
  approvals,
  goals,
  forecasts: [{ id: 'f1', statement: 'Sam ships the desktop app this month', probability: 0.62, resolveBy: now + 12 * 864e5 }, { id: 'f2', statement: 'The half-marathon plan slips a week', probability: 0.4, resolveBy: now + 20 * 864e5 }],
  notifications: [{ title: 'Research finished', body: 'Standing desk recommendation ready', at: ago(40) }],
};

const lim = (s: string) => [s];
const connectorsDemo = [
  { id: 'instagram', name: 'Instagram', category: 'social', docsUrl: 'https://developers.facebook.com/docs/instagram-platform', authKind: 'token', fields: [{ key: 'access_token', label: 'Instagram user access token (long-lived)', secret: true }], appFields: [], appConfigured: true, capabilities: [{ id: 'profile', label: 'Profile and media', description: 'Your profile, posts, reels and stats on them.', default: true }, { id: 'insights', label: 'Insights', description: 'Account and post insights.', default: true }, { id: 'comments_read', label: 'Read comments and tags', description: '', default: true }, { id: 'comments_manage', label: 'Reply to, hide and delete comments', description: 'Always asks.', default: false }, { id: 'publish', label: 'Publish posts, reels, carousels and stories', description: 'Always asks; publishing is public.', default: false }, { id: 'messages', label: 'Read and send direct messages', description: 'Replies only within 24 hours.', default: false }], limitations: ['Only Instagram professional accounts (Business or Creator) have an API. Personal accounts are not supported: Meta shut down the Basic Display API on 4 December 2024.', 'Publishing needs the media at a public HTTPS URL; up to 100 API-published posts per 24 hours.'], setupSteps: ['Create a Meta app with the Instagram product.', 'Generate a token for your professional account.', 'Paste it here.'], actions: [{ name: 'instagram.publish', capability: 'publish', category: 'communicate', description: '' }, { name: 'instagram.reply_comment', capability: 'comments_manage', category: 'communicate', description: '' }, { name: 'instagram.messages', capability: 'messages', category: 'communicate', description: '' }], connections: [{ id: 'c-ig', accountName: '@sam.studio', status: 'connected', enabledCapabilities: ['profile', 'insights', 'comments_read'], createdAt: ago(60 * 24 * 12), lastOkAt: ago(42) }] },
  { id: 'discord', name: 'Discord', category: 'social', docsUrl: '', authKind: 'token', fields: [], appFields: [], appConfigured: true, capabilities: [], limitations: lim('Bot accounts only.'), setupSteps: [], actions: [], connections: [] },
  { id: 'telegram', name: 'Telegram', category: 'social', docsUrl: '', authKind: 'token', fields: [], appFields: [], appConfigured: true, capabilities: [], limitations: lim('Bot API only.'), setupSteps: [], actions: [], connections: [{ id: 'c-tg', accountName: '@feroxes_bot', status: 'connected', enabledCapabilities: ['read'], createdAt: ago(60 * 24 * 3), lastOkAt: ago(5) }] },
  { id: 'whatsapp', name: 'WhatsApp Business', category: 'social', docsUrl: '', authKind: 'token', fields: [], appFields: [], appConfigured: true, capabilities: [], limitations: lim('Business numbers only.'), setupSteps: [], actions: [], connections: [] },
  { id: 'slack', name: 'Slack', category: 'social', docsUrl: '', authKind: 'token', fields: [], appFields: [], appConfigured: true, capabilities: [], limitations: lim(''), setupSteps: [], actions: [], connections: [] },
  { id: 'reddit', name: 'Reddit', category: 'social', docsUrl: '', authKind: 'oauth2', fields: [], appFields: [], appConfigured: false, capabilities: [], limitations: lim(''), setupSteps: [], actions: [], connections: [] },
  { id: 'google', name: 'Google', category: 'productivity', docsUrl: '', authKind: 'oauth2', fields: [], appFields: [], appConfigured: true, capabilities: [], limitations: lim(''), setupSteps: [], actions: [], connections: [{ id: 'c-g', accountName: 'sam@example.com', status: 'needs_reauth', enabledCapabilities: ['gmail_read', 'calendar_read'], createdAt: ago(60 * 24 * 9), lastError: 'Token has been expired or revoked.' }] },
  { id: 'outlook', name: 'Microsoft Outlook', category: 'productivity', docsUrl: '', authKind: 'oauth2', fields: [], appFields: [], appConfigured: false, capabilities: [], limitations: lim(''), setupSteps: [], actions: [], connections: [] },
  { id: 'notion', name: 'Notion', category: 'productivity', docsUrl: '', authKind: 'token', fields: [], appFields: [], appConfigured: true, capabilities: [], limitations: lim(''), setupSteps: [], actions: [], connections: [{ id: 'c-n', accountName: 'Feroxes (Sam\'s workspace)', status: 'connected', enabledCapabilities: ['read'], createdAt: ago(60 * 24 * 20), lastOkAt: ago(300) }] },
  { id: 'github', name: 'GitHub', category: 'developer', docsUrl: '', authKind: 'token', fields: [], appFields: [], appConfigured: true, capabilities: [], limitations: lim(''), setupSteps: [], actions: [], connections: [{ id: 'c-gh', accountName: 'ewazf0x', status: 'connected', enabledCapabilities: ['read'], createdAt: ago(60 * 24 * 30), lastOkAt: ago(12) }] },
  { id: 'gitlab', name: 'GitLab', category: 'developer', docsUrl: '', authKind: 'token', fields: [], appFields: [], appConfigured: true, capabilities: [], limitations: lim(''), setupSteps: [], actions: [], connections: [] },
  { id: 'vscode', name: 'Visual Studio Code', category: 'developer', docsUrl: '', authKind: 'none', fields: [], appFields: [], appConfigured: true, capabilities: [], limitations: lim(''), setupSteps: [], actions: [], connections: [] },
];
const activityDemo = [
  { seq: 9, ts: ago(42), action: 'instagram.comments', decision: 'allow', outcome: 'success', summary: 'instagram.comments: 14 comments on "Sunset over the harbour"' },
  { seq: 8, ts: ago(60 * 5), action: 'instagram.publish', decision: 'ask', outcome: 'pending', summary: 'Publish an Instagram image (public) — waiting for approval' },
  { seq: 7, ts: ago(60 * 24 * 2), action: 'connector.instagram.permissions', decision: 'system', outcome: 'success', summary: 'Changed what Feroxes may do with Instagram (@sam.studio): profile, insights, comments_read' },
  { seq: 6, ts: ago(60 * 24 * 12), action: 'connector.instagram.connect', decision: 'system', outcome: 'success', summary: 'Connected Instagram account @sam.studio (profile, insights, comments_read)' },
];

const MAP: Record<string, unknown> = { '/connectors': connectorsDemo, '/connectors/instagram/activity': activityDemo, '/status': status, '/today': today, '/sessions': [{ id: 'demo', title: 'Tidy Downloads' }], '/sessions/demo/messages': messages, '/approvals': approvals, '/mind': mind, '/goals': { horizons: ['now', 'today', 'week', 'month', 'long'], goals }, '/devices': devices, '/usage': usage };

export function demoResponse(path: string, init?: { method?: string; body?: unknown }): Promise<any> {
  if (init?.method === 'POST' || init?.method === 'DELETE') return Promise.resolve({ ok: true });
  if (path.startsWith('/memories')) return Promise.resolve(memories);
  return Promise.resolve(MAP[path] ?? {});
}

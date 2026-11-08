import { z } from '@feroxes/tools';
import { type Connector, ConnectorError, type Secrets, bearer, clip, lines } from './framework.ts';

const text = z.string().min(1).max(4000);

// ------------------------------------------------------------------ Telegram (Bot API)

export const telegram: Connector = {
  id: 'telegram',
  name: 'Telegram',
  category: 'social',
  docsUrl: 'https://core.telegram.org/bots/api',
  auth: { kind: 'token', fields: [{ key: 'access_token', label: 'Bot token', secret: true, placeholder: '123456789:AA…', help: 'Talk to @BotFather → /newbot. The token it gives you belongs to your bot, not your account.' }] },
  capabilities: [
    { id: 'read', label: 'Read messages sent to your bot', description: 'People (including you) message the bot; Feroxes reads them.', default: true },
    { id: 'send', label: 'Send messages as your bot', description: 'Always asks before sending.', default: false },
  ],
  limitations: [
    'The Bot API is for bots: Feroxes sees only messages sent to your bot, or posted in groups where the bot is a member (with privacy mode on, only commands and mentions).',
    'Your personal Telegram chats are not accessible through the Bot API, and Feroxes does not automate user accounts.',
    'Telegram keeps undelivered updates for 24 hours; read them at least daily.',
    'A bot can only message people who started a chat with it first.',
  ],
  setupSteps: ['In Telegram, open @BotFather and send /newbot.', 'Paste the bot token here.', 'Send your bot a message, then ask Feroxes to read Telegram.'],
  baseUrl: (s) => `https://api.telegram.org/bot${s.access_token ?? ''}`,
  sign: () => {},
  checkBody(body) {
    const b = body as { ok?: boolean; error_code?: number; description?: string; parameters?: { retry_after?: number } };
    if (!b || b.ok !== false) return undefined;
    const code = b.error_code === 401 ? 'auth' : b.error_code === 429 ? 'rate_limited' : b.error_code === 403 ? 'forbidden' : 'bad_request';
    return new ConnectorError(code, `Telegram: ${b.description ?? 'request failed'}`);
  },
  async whoami(api) {
    const r = await api.request<{ result: { id: number; username: string } }>('POST', '/getMe');
    return { id: String(r.result.id), name: `@${r.result.username}` };
  },
  actions: [
    {
      name: 'telegram.updates',
      capability: 'read',
      category: 'read',
      untrusted: 'message',
      liveSafe: true,
      description: 'New messages sent to the bot since the last read.',
      input: z.object({ limit: z.number().int().min(1).max(100).default(50) }),
      async run(i, { api, state }) {
        type Msg = { message_id: number; date: number; text?: string; caption?: string; chat: { id: number; type: string; title?: string; username?: string; first_name?: string }; from?: { username?: string; first_name?: string } };
        const r = await api.request<{ result: { update_id: number; message?: Msg; channel_post?: Msg }[] }>('POST', '/getUpdates', { json: { offset: state.get<number>('offset'), limit: i.limit, timeout: 0, allowed_updates: ['message', 'channel_post'] } });
        const chats = state.get<Record<string, string>>('chats') ?? {};
        const out: string[] = [];
        for (const u of r.result) {
          const m = u.message ?? u.channel_post;
          state.set('offset', u.update_id + 1);
          if (!m) continue;
          const chatName = m.chat.title ?? (m.chat.username ? `@${m.chat.username}` : m.chat.first_name ?? String(m.chat.id));
          chats[String(m.chat.id)] = chatName;
          out.push(`[chat ${m.chat.id} ${chatName}] ${m.from?.username ? `@${m.from.username}` : m.from?.first_name ?? ''} (${new Date(m.date * 1000).toISOString()}): ${clip(m.text ?? m.caption ?? '[non-text message]', 1000)}`);
        }
        state.set('chats', chats);
        return { text: lines(out, 'No new messages.'), data: { count: out.length } };
      },
    },
    {
      name: 'telegram.chats',
      capability: 'read',
      category: 'read',
      description: 'Chats the bot has seen (ids for sending).',
      input: z.object({}),
      async run(_i, { state }) {
        const chats = state.get<Record<string, string>>('chats') ?? {};
        return { text: lines(Object.entries(chats).map(([id, n]) => `${id}: ${n}`), 'No chats yet. Someone has to message the bot first.') };
      },
    },
    {
      name: 'telegram.send',
      capability: 'send',
      category: 'communicate',
      description: 'Send a message from the bot to a chat (id from telegram.chats).',
      input: z.object({ chat_id: z.union([z.number().int(), z.string().max(100)]), text }),
      preview: (i) => ({ title: `Send a Telegram message to chat ${String(i.chat_id)}`, body: String(i.text) }),
      async run(i, { api }) {
        const r = await api.request<{ result: { message_id: number } }>('POST', '/sendMessage', { json: { chat_id: i.chat_id, text: i.text } });
        return { text: `Sent (message ${r.result.message_id}).` };
      },
    },
  ],
};

// ------------------------------------------------------------------ Discord (bot + OAuth2 bot authorization)

/** View Channels, Send Messages, Read Message History. */
export const DISCORD_BOT_PERMISSIONS = String(1024 + 2048 + 65536);
export const discordInviteUrl = (applicationId: string) => `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(applicationId)}&scope=bot&permissions=${DISCORD_BOT_PERMISSIONS}`;

export const discord: Connector = {
  id: 'discord',
  name: 'Discord',
  category: 'social',
  docsUrl: 'https://discord.com/developers/docs/intro',
  auth: {
    kind: 'token',
    fields: [
      { key: 'access_token', label: 'Bot token', secret: true, help: 'Developer Portal → your application → Bot → Reset Token.' },
      { key: 'application_id', label: 'Application ID', secret: false, help: 'Developer Portal → General Information. Used to build the link that adds the bot to your servers (OAuth2 bot authorization).' },
    ],
  },
  capabilities: [
    { id: 'read', label: 'Read servers, channels and messages the bot can see', description: '', default: true },
    { id: 'send', label: 'Send messages and DMs as the bot', description: 'Always asks before sending.', default: false },
  ],
  limitations: [
    'Feroxes uses a bot account, as Discord requires. Automating your user account ("self-bots") breaks Discord\'s terms and is not supported.',
    'The bot sees only servers it was added to (through the OAuth2 invite link) and channels its role allows.',
    'Reading message text in servers needs the privileged Message Content intent (Developer Portal → Bot). Without it, message content is empty except DMs and mentions.',
    'Your own DMs with other people are not accessible; the bot can DM people who share a server with it.',
    'Real-time events would need a Gateway connection; Feroxes reads on demand for now.',
  ],
  setupSteps: [
    'discord.com/developers/applications → New Application → Bot → Reset Token; enable Message Content intent if you want it to read server messages.',
    'Paste the bot token and the Application ID here.',
    'Open the invite link Feroxes shows and add the bot to your server(s).',
  ],
  defaultHeaders: {},
  baseUrl: () => 'https://discord.com/api/v10',
  sign: (req, s) => {
    if (s.access_token) req.headers.authorization = `Bot ${s.access_token}`;
  },
  async whoami(api) {
    const u = await api.request<{ id: string; username: string }>('GET', '/users/@me');
    return { id: u.id, name: u.username };
  },
  actions: [
    {
      name: 'discord.servers',
      capability: 'read',
      category: 'read',
      liveSafe: true,
      description: 'Servers the bot is in.',
      input: z.object({}),
      async run(_i, { api, secrets }) {
        const g = await api.request<{ id: string; name: string }[]>('GET', '/users/@me/guilds');
        return { text: `${lines(g.map((x) => `${x.id}: ${x.name}`), 'The bot is in no servers yet.')}${secrets.application_id ? `\n\nAdd it to a server: ${discordInviteUrl(secrets.application_id)}` : ''}` };
      },
    },
    {
      name: 'discord.channels',
      capability: 'read',
      category: 'read',
      description: 'Text channels of a server.',
      input: z.object({ server_id: z.string().regex(/^\d{5,25}$/) }),
      async run(i, { api }) {
        const ch = await api.request<{ id: string; name: string; type: number }[]>('GET', `/guilds/${String(i.server_id)}/channels`);
        return { text: lines(ch.filter((c) => c.type === 0 || c.type === 5).map((c) => `${c.id}: #${c.name}`)) };
      },
    },
    {
      name: 'discord.read',
      capability: 'read',
      category: 'read',
      untrusted: 'message',
      description: 'Recent messages in a channel.',
      input: z.object({ channel_id: z.string().regex(/^\d{5,25}$/), limit: z.number().int().min(1).max(100).default(25) }),
      async run(i, { api }) {
        const m = await api.request<{ author: { username: string }; content: string; timestamp: string }[]>('GET', `/channels/${String(i.channel_id)}/messages`, { query: { limit: i.limit as number } });
        return { text: lines(m.reverse().map((x) => `${x.author.username} (${x.timestamp}): ${clip(x.content || '[no text: enable the Message Content intent]', 800)}`), 'No messages.') };
      },
    },
    {
      name: 'discord.send',
      capability: 'send',
      category: 'communicate',
      description: 'Post a message in a channel as the bot.',
      input: z.object({ channel_id: z.string().regex(/^\d{5,25}$/), text: z.string().min(1).max(2000) }),
      preview: (i) => ({ title: `Post in Discord channel ${String(i.channel_id)}`, body: String(i.text) }),
      async run(i, { api }) {
        const r = await api.request<{ id: string }>('POST', `/channels/${String(i.channel_id)}/messages`, { json: { content: i.text, allowed_mentions: { parse: [] } } });
        return { text: `Posted (message ${r.id}).` };
      },
    },
    {
      name: 'discord.dm',
      capability: 'send',
      category: 'communicate',
      description: 'Send a direct message from the bot to a user who shares a server with it.',
      input: z.object({ user_id: z.string().regex(/^\d{5,25}$/), text: z.string().min(1).max(2000) }),
      preview: (i) => ({ title: `DM Discord user ${String(i.user_id)} from your bot`, body: String(i.text) }),
      async run(i, { api }) {
        const ch = await api.request<{ id: string }>('POST', '/users/@me/channels', { json: { recipient_id: i.user_id } });
        await api.request('POST', `/channels/${ch.id}/messages`, { json: { content: i.text, allowed_mentions: { parse: [] } } });
        return { text: 'DM sent.' };
      },
    },
  ],
};

// ------------------------------------------------------------------ Slack (Web API)

const SLACK_AUTH_ERRORS = new Set(['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive']);

export const slack: Connector = {
  id: 'slack',
  name: 'Slack',
  category: 'social',
  docsUrl: 'https://docs.slack.dev/apis/web-api/',
  auth: {
    kind: 'token',
    fields: [
      { key: 'access_token', label: 'Bot User OAuth Token', secret: true, placeholder: 'xoxb-…', help: 'api.slack.com/apps → your app → OAuth & Permissions, after installing it to your workspace.' },
      { key: 'user_token', label: 'User OAuth Token (optional, for search)', secret: true, placeholder: 'xoxp-…', optional: true },
    ],
  },
  capabilities: [
    { id: 'read', label: 'Read channels the bot is in', description: 'Bot scopes channels:history, groups:history, channels:read, groups:read.', default: true },
    { id: 'search', label: 'Search messages as you', description: 'Needs the user token with search:read.', default: false },
    { id: 'send', label: 'Post messages as the bot', description: 'Bot scope chat:write. Always asks.', default: false },
  ],
  limitations: [
    'The bot reads only conversations it was invited to. Searching your whole workspace needs a user token.',
    'Slack apps for a single workspace are installed by you from api.slack.com/apps; the OAuth & Permissions page gives the tokens.',
    'Web API rate limits are per method (tiers); conversations.history on non-Marketplace apps can be heavily limited.',
  ],
  setupSteps: ['api.slack.com/apps → Create New App → From scratch.', 'OAuth & Permissions: add bot scopes channels:read, channels:history, groups:read, groups:history, chat:write (and user scope search:read if you want search).', 'Install to Workspace, copy the tokens here, then invite the bot to channels with /invite.'],
  baseUrl: () => 'https://slack.com/api',
  sign: (req, s) => {
    if (!req.headers.authorization && s.access_token) req.headers.authorization = `Bearer ${s.access_token}`;
  },
  checkBody(body) {
    const b = body as { ok?: boolean; error?: string };
    if (!b || b.ok !== false) return undefined;
    const e = b.error ?? 'error';
    const code = SLACK_AUTH_ERRORS.has(e) ? 'auth' : e === 'ratelimited' ? 'rate_limited' : e === 'missing_scope' || e === 'not_allowed_token_type' || e === 'not_in_channel' ? 'forbidden' : e === 'channel_not_found' ? 'not_found' : 'bad_request';
    return new ConnectorError(code, `Slack: ${e}`);
  },
  async whoami(api) {
    const r = await api.request<{ user_id: string; user: string; team: string }>('POST', '/auth.test');
    return { id: r.user_id, name: `${r.user} (${r.team})` };
  },
  actions: [
    {
      name: 'slack.channels',
      capability: 'read',
      category: 'read',
      liveSafe: true,
      description: 'Channels and conversations the bot can see.',
      input: z.object({}),
      async run(_i, { api }) {
        const r = await api.request<{ channels: { id: string; name?: string; is_member?: boolean; is_im?: boolean }[] }>('GET', '/conversations.list', { query: { types: 'public_channel,private_channel,mpim,im', exclude_archived: true, limit: 200 } });
        return { text: lines(r.channels.map((c) => `${c.id}: ${c.is_im ? 'DM' : `#${c.name}`}${c.is_member === false ? ' (bot not a member)' : ''}`)) };
      },
    },
    {
      name: 'slack.history',
      capability: 'read',
      category: 'read',
      untrusted: 'message',
      description: 'Recent messages in a channel the bot is in.',
      input: z.object({ channel: z.string().min(1).max(30), limit: z.number().int().min(1).max(100).default(30) }),
      async run(i, { api }) {
        const r = await api.request<{ messages: { user?: string; bot_id?: string; text: string; ts: string }[] }>('GET', '/conversations.history', { query: { channel: i.channel as string, limit: i.limit as number } });
        return { text: lines(r.messages.reverse().map((m) => `${m.user ?? m.bot_id ?? '?'} (${new Date(Number(m.ts) * 1000).toISOString()}): ${clip(m.text, 800)}`), 'No messages.') };
      },
    },
    {
      name: 'slack.search',
      capability: 'search',
      category: 'read',
      untrusted: 'message',
      description: 'Search Slack messages (Slack search syntax).',
      input: z.object({ query: z.string().min(1).max(500) }),
      async run(i, { api, secrets }) {
        if (!secrets.user_token) throw new ConnectorError('setup', 'Search needs the Slack user token (search:read). Add it in Integrations.');
        const r = await api.request<{ messages: { matches: { username?: string; text: string; channel: { name?: string }; permalink: string }[] } }>('GET', '/search.messages', { query: { query: i.query as string, count: 20 }, headers: { authorization: `Bearer ${secrets.user_token}` } });
        return { text: lines(r.messages.matches.map((m) => `#${m.channel.name ?? '?'} ${m.username ?? ''}: ${clip(m.text, 400)}`), 'No results.') };
      },
    },
    {
      name: 'slack.send',
      capability: 'send',
      category: 'communicate',
      description: 'Post a message as the bot.',
      input: z.object({ channel: z.string().min(1).max(30), text, thread_ts: z.string().max(30).optional() }),
      preview: (i) => ({ title: `Post in Slack ${String(i.channel)}`, body: String(i.text) }),
      async run(i, { api }) {
        const r = await api.request<{ ts: string }>('POST', '/chat.postMessage', { json: { channel: i.channel, text: i.text, ...(i.thread_ts ? { thread_ts: i.thread_ts } : {}) } });
        return { text: `Posted (ts ${r.ts}).` };
      },
    },
  ],
};

// ------------------------------------------------------------------ Reddit (OAuth2)

const REDDIT_UA = 'desktop:dev.feroxes.app:0.1.0 (personal assistant)';

export const reddit: Connector = {
  id: 'reddit',
  name: 'Reddit',
  category: 'social',
  docsUrl: 'https://www.reddit.com/dev/api/',
  auth: {
    kind: 'oauth2',
    appFields: [
      { key: 'client_id', label: 'Client ID', secret: false, help: 'reddit.com/prefs/apps → create app → "installed app", redirect uri = the address Feroxes shows.' },
      { key: 'client_secret', label: 'Secret (web apps only)', secret: true, optional: true },
    ],
    oauth: { authorizeUrl: 'https://www.reddit.com/api/v1/authorize', tokenUrl: 'https://www.reddit.com/api/v1/access_token', pkce: false, clientAuth: 'basic', baseScopes: ['identity'], extraAuthorizeParams: { duration: 'permanent' } },
  },
  capabilities: [
    { id: 'read', label: 'Read subreddits and your subscriptions', description: '', scopes: ['read', 'mysubreddits'], default: true },
    { id: 'inbox', label: 'Read your inbox', description: 'Private messages and replies.', scopes: ['privatemessages', 'history'], default: false },
    { id: 'post', label: 'Post and comment as you', description: 'Always asks.', scopes: ['submit'], default: false },
  ],
  limitations: ['Reddit\'s Data API terms apply: free access for personal, non-commercial use within 100 queries per minute per client.', 'Feroxes acts only with the scopes you approve on Reddit\'s consent page.'],
  setupSteps: ['reddit.com/prefs/apps → "create another app…" → type "installed app".', 'Set the redirect URI to the address shown here and paste the client ID.', 'Connect and approve on Reddit.'],
  defaultHeaders: { 'user-agent': REDDIT_UA },
  baseUrl: () => 'https://oauth.reddit.com',
  sign: bearer(),
  checkBody(body) {
    const errs = (body as { json?: { errors?: string[][] } })?.json?.errors;
    return errs?.length ? new ConnectorError('bad_request', `Reddit: ${errs.map((e) => e.join(' ')).join('; ')}`) : undefined;
  },
  async revoke(s: Secrets, app: Secrets, f: typeof fetch) {
    const basic = Buffer.from(`${app.client_id ?? ''}:${app.client_secret ?? ''}`).toString('base64');
    await f('https://www.reddit.com/api/v1/revoke_token', { method: 'POST', headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded', 'user-agent': REDDIT_UA }, body: new URLSearchParams({ token: s.refresh_token ?? s.access_token ?? '', token_type_hint: s.refresh_token ? 'refresh_token' : 'access_token' }) });
  },
  async whoami(api) {
    const u = await api.request<{ id: string; name: string }>('GET', '/api/v1/me');
    return { id: u.id, name: `u/${u.name}` };
  },
  actions: [
    {
      name: 'reddit.subreddit',
      capability: 'read',
      category: 'read',
      untrusted: 'message',
      liveSafe: true,
      description: 'Top posts of a subreddit.',
      input: z.object({ name: z.string().regex(/^[A-Za-z0-9_]{2,21}$/).default('popular'), sort: z.enum(['hot', 'new', 'top']).default('hot') }),
      async run(i, { api }) {
        const r = await api.request<{ data: { children: { data: { title: string; score: number; num_comments: number; permalink: string; name: string } }[] } }>('GET', `/r/${String(i.name)}/${String(i.sort)}`, { query: { limit: 15, raw_json: 1 } });
        return { text: lines(r.data.children.map(({ data: p }) => `[${p.name}] ${clip(p.title, 160)} (${p.score} points, ${p.num_comments} comments) https://reddit.com${p.permalink}`)) };
      },
    },
    {
      name: 'reddit.inbox',
      capability: 'inbox',
      category: 'read',
      untrusted: 'message',
      description: 'Your Reddit inbox (messages, replies, mentions).',
      input: z.object({ unread_only: z.boolean().default(true) }),
      async run(i, { api }) {
        const r = await api.request<{ data: { children: { data: { name: string; author: string; subject: string; body: string; created_utc: number } }[] } }>('GET', i.unread_only ? '/message/unread' : '/message/inbox', { query: { limit: 25, raw_json: 1 } });
        return { text: lines(r.data.children.map(({ data: m }) => `[${m.name}] ${m.author} — ${clip(m.subject, 80)}: ${clip(m.body, 500)}`), 'Inbox is empty.') };
      },
    },
    {
      name: 'reddit.submit',
      capability: 'post',
      category: 'communicate',
      description: 'Create a text post in a subreddit (public, under your name).',
      input: z.object({ subreddit: z.string().regex(/^[A-Za-z0-9_]{2,21}$/), title: z.string().min(1).max(300), text: z.string().max(40_000).default('') }),
      preview: (i) => ({ title: `Post to r/${String(i.subreddit)} as you`, body: `${String(i.title)}\n\n${String(i.text ?? '')}` }),
      async run(i, { api }) {
        const r = await api.request<{ json: { data?: { url?: string } } }>('POST', '/api/submit', { form: { sr: String(i.subreddit), kind: 'self', title: String(i.title), text: String(i.text ?? ''), api_type: 'json' } });
        return { text: `Posted: ${r.json.data?.url ?? '(no URL returned)'}` };
      },
    },
    {
      name: 'reddit.reply',
      capability: 'post',
      category: 'communicate',
      description: 'Reply to a post, comment or message by its fullname (t1_…, t3_…, t4_…).',
      input: z.object({ thing_id: z.string().regex(/^t[1-6]_[a-z0-9]{1,13}$/), text: z.string().min(1).max(10_000) }),
      preview: (i) => ({ title: `Reply on Reddit to ${String(i.thing_id)} as you`, body: String(i.text) }),
      async run(i, { api }) {
        await api.request('POST', '/api/comment', { form: { thing_id: String(i.thing_id), text: String(i.text), api_type: 'json' } });
        return { text: 'Reply posted.' };
      },
    },
  ],
};

// ------------------------------------------------------------------ WhatsApp Business Platform (Cloud API)

export const whatsapp: Connector = {
  id: 'whatsapp',
  name: 'WhatsApp Business',
  category: 'social',
  docsUrl: 'https://developers.facebook.com/docs/whatsapp/cloud-api',
  auth: {
    kind: 'token',
    fields: [
      { key: 'access_token', label: 'System user access token', secret: true, help: 'Meta Business Suite → Business settings → System users → generate a token with whatsapp_business_messaging (and whatsapp_business_management for templates).' },
      { key: 'phone_number_id', label: 'Phone number ID', secret: false, help: 'WhatsApp Manager / App dashboard → WhatsApp → API Setup.' },
      { key: 'waba_id', label: 'WhatsApp Business Account ID (for templates)', secret: false, optional: true },
      { key: 'api_version', label: 'Graph API version', secret: false, placeholder: 'v23.0', optional: true },
    ],
  },
  capabilities: [
    { id: 'send', label: 'Send messages from your business number', description: 'Always asks. Free-form text only within 24 hours of the customer\'s last message.', default: false },
    { id: 'templates', label: 'Read message templates', description: '', default: true },
  ],
  limitations: [
    'This is the official WhatsApp Business Platform: it works with a business phone number registered to the Cloud API, not with your personal WhatsApp account. Your personal chats are not accessible here (on Android, Feroxes can read WhatsApp notifications through the phone app instead).',
    'Free-form messages are allowed only within 24 hours after the person last wrote to you; otherwise only approved template messages can be sent. Meta charges per message for some categories.',
    'Receiving messages needs a public HTTPS webhook. A Core on a home PC needs a tunnel for that, so incoming WhatsApp messages are not wired yet.',
  ],
  setupSteps: ['developers.facebook.com → create an app with the WhatsApp product, or use Meta Business Suite.', 'Register your business number; copy the Phone number ID.', 'Create a system user token with whatsapp_business_messaging and paste both here.'],
  baseUrl: (s) => `https://graph.facebook.com/${s.api_version || 'v23.0'}`,
  sign: bearer(),
  async whoami(api, s) {
    if (!s.phone_number_id) throw new ConnectorError('setup', 'Phone number ID is required.');
    const r = await api.request<{ id: string; display_phone_number: string; verified_name?: string }>('GET', `/${encodeURIComponent(s.phone_number_id)}`, { query: { fields: 'display_phone_number,verified_name' } });
    return { id: r.id, name: `${r.verified_name ?? 'WhatsApp'} ${r.display_phone_number}` };
  },
  actions: [
    {
      name: 'whatsapp.send_text',
      capability: 'send',
      category: 'communicate',
      description: 'Send a text from your WhatsApp Business number (to: international format, digits only). Works only within 24 h of their last message.',
      input: z.object({ to: z.string().regex(/^\d{6,15}$/), text: z.string().min(1).max(4096) }),
      preview: (i) => ({ title: `Send a WhatsApp message to +${String(i.to)}`, body: String(i.text) }),
      async run(i, { api, secrets }) {
        const r = await api.request<{ messages: { id: string }[] }>('POST', `/${encodeURIComponent(secrets.phone_number_id ?? '')}/messages`, { json: { messaging_product: 'whatsapp', recipient_type: 'individual', to: i.to, type: 'text', text: { preview_url: false, body: i.text } } });
        return { text: `Sent (${r.messages[0]?.id ?? 'no id'}).` };
      },
    },
    {
      name: 'whatsapp.send_template',
      capability: 'send',
      category: 'communicate',
      description: 'Send an approved template message (allowed outside the 24-hour window).',
      input: z.object({ to: z.string().regex(/^\d{6,15}$/), template: z.string().min(1).max(512), language: z.string().min(2).max(10).default('en_US'), params: z.array(z.string().max(1024)).max(10).default([]) }),
      preview: (i) => ({ title: `Send the WhatsApp template "${String(i.template)}" to +${String(i.to)}`, body: (i.params as string[]).join(' | ') }),
      async run(i, { api, secrets }) {
        const params = i.params as string[];
        const r = await api.request<{ messages: { id: string }[] }>('POST', `/${encodeURIComponent(secrets.phone_number_id ?? '')}/messages`, {
          json: { messaging_product: 'whatsapp', to: i.to, type: 'template', template: { name: i.template, language: { code: i.language }, ...(params.length ? { components: [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: p })) }] } : {}) } },
        });
        return { text: `Sent (${r.messages[0]?.id ?? 'no id'}).` };
      },
    },
    {
      name: 'whatsapp.templates',
      capability: 'templates',
      category: 'read',
      liveSafe: true,
      description: 'Message templates and their approval status.',
      input: z.object({}),
      async run(_i, { api, secrets }) {
        if (!secrets.waba_id) throw new ConnectorError('setup', 'Add the WhatsApp Business Account ID in Integrations to list templates.');
        const r = await api.request<{ data: { name: string; status: string; language: string; category: string }[] }>('GET', `/${encodeURIComponent(secrets.waba_id)}/message_templates`, { query: { fields: 'name,status,language,category', limit: 50 } });
        return { text: lines(r.data.map((t) => `${t.name} (${t.language}, ${t.category}): ${t.status}`), 'No templates.') };
      },
    },
  ],
};

// ------------------------------------------------------------------ Instagram (Instagram API with Instagram Login)

const IG = 'https://graph.instagram.com/v23.0';

async function waitForContainer(api: Parameters<Connector['whoami']>[0], id: string, signal: AbortSignal) {
  for (let i = 0; i < 30; i++) {
    const s = await api.request<{ status_code: string; status?: string }>('GET', `${IG}/${id}`, { query: { fields: 'status_code,status' } });
    if (s.status_code === 'FINISHED') return;
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new ConnectorError('bad_request', `Instagram couldn't process the media (${s.status ?? s.status_code}).`);
    if (signal.aborted) throw new ConnectorError('timeout', 'Cancelled.');
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new ConnectorError('timeout', 'Instagram is still processing the video; try publishing again in a few minutes.');
}

export const instagram: Connector = {
  id: 'instagram',
  name: 'Instagram',
  category: 'social',
  docsUrl: 'https://developers.facebook.com/docs/instagram-platform',
  auth: { kind: 'token', fields: [{ key: 'access_token', label: 'Instagram user access token (long-lived)', secret: true, help: 'App dashboard → Instagram → API setup with Instagram login → Generate access token for your professional account.' }] },
  capabilities: [
    { id: 'profile', label: 'Profile and media', description: 'Your profile, posts, reels and stats on them.', default: true },
    { id: 'insights', label: 'Insights', description: 'Account and post insights.', default: true },
    { id: 'comments_read', label: 'Read comments and tags', description: '', default: true },
    { id: 'comments_manage', label: 'Reply to, hide and delete comments', description: 'Always asks.', default: false },
    { id: 'publish', label: 'Publish posts, reels, carousels and stories', description: 'Always asks; publishing is public.', default: false },
    { id: 'messages', label: 'Read and send direct messages', description: 'Needs instagram_business_manage_messages; replies only within 24 hours.', default: false },
  ],
  limitations: [
    'Only Instagram professional accounts (Business or Creator) have an API. Personal accounts are not supported: Meta shut down the Basic Display API on 4 December 2024.',
    'Publishing needs the media at a public HTTPS URL (JPEG for photos); Instagram downloads it. There is a limit of 100 API-published posts per 24 hours (see instagram.publishing_limit).',
    'Direct messages: only conversations people start with you, replies within 24 hours, and the permission usually needs Meta App Review (advanced access) beyond your own test accounts.',
    'Not available through any official API: your home feed, other people\'s stories, liking or following, or messaging people who haven\'t written to you. Hashtag search and business discovery need Facebook Login for Business instead.',
    'The token lasts 60 days; Feroxes refreshes it automatically during health checks (Instagram allows refreshing tokens that are at least 24 hours old).',
  ],
  setupSteps: ['developers.facebook.com → create an app (Business) → add the Instagram product → "API setup with Instagram login".', 'Add your professional account as a tester, then Generate access token.', 'Paste the token here.'],
  baseUrl: () => IG,
  sign: bearer(),
  async refresh(s, f) {
    const res = await f(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(s.access_token ?? '')}`, { signal: AbortSignal.timeout(20_000) });
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: { message?: string } };
    if (!res.ok || !json.access_token) throw new ConnectorError(res.status === 400 || res.status === 401 ? 'auth' : 'server', `Instagram token refresh failed${json.error?.message ? `: ${json.error.message}` : ''}`);
    return { access_token: json.access_token, ...(json.expires_in ? { expires_in: json.expires_in } : {}) };
  },
  async whoami(api) {
    const u = await api.request<{ user_id?: string; id: string; username: string }>('GET', '/me', { query: { fields: 'user_id,username' } });
    return { id: u.user_id ?? u.id, name: `@${u.username}` };
  },
  actions: [
    {
      name: 'instagram.profile',
      capability: 'profile',
      category: 'read',
      liveSafe: true,
      description: 'Your Instagram profile and counts.',
      input: z.object({}),
      async run(_i, { api }) {
        const u = await api.request<Record<string, unknown>>('GET', '/me', { query: { fields: 'user_id,username,name,account_type,followers_count,follows_count,media_count' } });
        return { text: `@${String(u.username)} (${String(u.account_type ?? '')}): ${String(u.followers_count ?? '?')} followers, ${String(u.follows_count ?? '?')} following, ${String(u.media_count ?? '?')} posts`, data: u };
      },
    },
    {
      name: 'instagram.media',
      capability: 'profile',
      category: 'read',
      description: 'Your recent posts and reels with likes and comment counts.',
      input: z.object({ limit: z.number().int().min(1).max(50).default(15) }),
      async run(i, { api }) {
        const r = await api.request<{ data: { id: string; caption?: string; media_type: string; permalink: string; timestamp: string; like_count?: number; comments_count?: number }[] }>('GET', '/me/media', { query: { fields: 'id,caption,media_type,permalink,timestamp,like_count,comments_count', limit: i.limit as number } });
        return { text: lines(r.data.map((m) => `[${m.id}] ${m.media_type} ${m.timestamp}: ${m.like_count ?? 0} likes, ${m.comments_count ?? 0} comments — ${clip(m.caption, 100)} ${m.permalink}`), 'No posts yet.') };
      },
    },
    {
      name: 'instagram.insights',
      capability: 'insights',
      category: 'read',
      description: 'Insights for your account (last day) or for one post (media_id). Available metrics change over time; unknown ones are reported.',
      input: z.object({ media_id: z.string().regex(/^\d{5,30}$/).optional() }),
      async run(i, { api }) {
        const r = i.media_id
          ? await api.request<{ data: { name: string; values?: { value: number }[]; total_value?: { value: number } }[] }>('GET', `/${String(i.media_id)}/insights`, { query: { metric: 'reach,likes,comments,shares,saved,views' } })
          : await api.request<{ data: { name: string; values?: { value: number }[]; total_value?: { value: number } }[] }>('GET', '/me/insights', { query: { metric: 'reach,views,accounts_engaged,total_interactions', period: 'day', metric_type: 'total_value' } });
        return { text: lines(r.data.map((m) => `${m.name}: ${m.total_value?.value ?? m.values?.at(-1)?.value ?? '?'}`)) };
      },
    },
    {
      name: 'instagram.comments',
      capability: 'comments_read',
      category: 'read',
      untrusted: 'message',
      description: 'Comments on one of your posts.',
      input: z.object({ media_id: z.string().regex(/^\d{5,30}$/) }),
      async run(i, { api }) {
        const r = await api.request<{ data: { id: string; text: string; username?: string; timestamp: string; hidden?: boolean }[] }>('GET', `/${String(i.media_id)}/comments`, { query: { fields: 'id,text,username,timestamp,hidden', limit: 50 } });
        return { text: lines(r.data.map((c) => `[${c.id}] @${c.username ?? '?'} (${c.timestamp})${c.hidden ? ' [hidden]' : ''}: ${clip(c.text, 500)}`), 'No comments.') };
      },
    },
    {
      name: 'instagram.tags',
      capability: 'comments_read',
      category: 'read',
      untrusted: 'message',
      description: 'Posts other accounts tagged you in.',
      input: z.object({}),
      async run(_i, { api }) {
        const r = await api.request<{ data: { id: string; caption?: string; username?: string; permalink?: string; timestamp?: string }[] }>('GET', '/me/tags', { query: { fields: 'id,caption,username,permalink,timestamp', limit: 25 } });
        return { text: lines(r.data.map((m) => `@${m.username ?? '?'} ${m.timestamp ?? ''}: ${clip(m.caption, 160)} ${m.permalink ?? ''}`), 'No tags.') };
      },
    },
    {
      name: 'instagram.reply_comment',
      capability: 'comments_manage',
      category: 'communicate',
      description: 'Reply publicly to a comment on your post.',
      input: z.object({ comment_id: z.string().regex(/^\d{5,30}$/), text: z.string().min(1).max(2200) }),
      preview: (i) => ({ title: `Reply publicly to Instagram comment ${String(i.comment_id)}`, body: String(i.text) }),
      async run(i, { api }) {
        const r = await api.request<{ id: string }>('POST', `/${String(i.comment_id)}/replies`, { json: { message: i.text } });
        return { text: `Replied (${r.id}).` };
      },
    },
    {
      name: 'instagram.hide_comment',
      capability: 'comments_manage',
      category: 'external_write',
      description: 'Hide or unhide a comment on your post.',
      input: z.object({ comment_id: z.string().regex(/^\d{5,30}$/), hide: z.boolean().default(true) }),
      preview: (i) => ({ title: `${i.hide ? 'Hide' : 'Unhide'} Instagram comment ${String(i.comment_id)}` }),
      async run(i, { api }) {
        await api.request('POST', `/${String(i.comment_id)}`, { json: { hide: i.hide } });
        return { text: i.hide ? 'Comment hidden.' : 'Comment visible again.' };
      },
    },
    {
      name: 'instagram.delete_comment',
      capability: 'comments_manage',
      category: 'destructive',
      description: 'Delete a comment on your post (cannot be undone).',
      input: z.object({ comment_id: z.string().regex(/^\d{5,30}$/) }),
      preview: (i) => ({ title: `Delete Instagram comment ${String(i.comment_id)}`, body: 'This cannot be undone.' }),
      async run(i, { api }) {
        await api.request('DELETE', `/${String(i.comment_id)}`);
        return { text: 'Comment deleted.' };
      },
    },
    {
      name: 'instagram.publish',
      capability: 'publish',
      category: 'communicate',
      description: 'Publish a photo, reel, story or carousel from public HTTPS URL(s). Photos must be JPEG.',
      input: z.object({
        kind: z.enum(['image', 'reel', 'story_image', 'story_video', 'carousel']),
        urls: z.array(z.url({ protocol: /^https$/ })).min(1).max(10),
        caption: z.string().max(2200).default(''),
      }),
      preview: (i) => ({ title: `Publish an Instagram ${String(i.kind).replace('_', ' ')} (public)`, body: `${String(i.caption ?? '')}\n\n${(i.urls as string[]).join('\n')}` }),
      async run(i, { api, signal }) {
        const urls = i.urls as string[];
        const kind = String(i.kind);
        const isVideo = (u: string) => /\.(mp4|mov)(\?|$)/i.test(u);
        let creation: string;
        if (kind === 'carousel') {
          if (urls.length < 2) throw new ConnectorError('bad_request', 'A carousel needs 2 to 10 items.');
          const children: string[] = [];
          for (const u of urls) {
            const c = await api.request<{ id: string }>('POST', '/me/media', { json: { is_carousel_item: true, ...(isVideo(u) ? { media_type: 'VIDEO', video_url: u } : { image_url: u }) } });
            if (isVideo(u)) await waitForContainer(api, c.id, signal);
            children.push(c.id);
          }
          creation = (await api.request<{ id: string }>('POST', '/me/media', { json: { media_type: 'CAROUSEL', children: children.join(','), caption: i.caption } })).id;
        } else {
          const u = urls[0]!;
          const body = kind === 'image' ? { image_url: u, caption: i.caption } : kind === 'reel' ? { media_type: 'REELS', video_url: u, caption: i.caption } : kind === 'story_image' ? { media_type: 'STORIES', image_url: u } : { media_type: 'STORIES', video_url: u };
          creation = (await api.request<{ id: string }>('POST', '/me/media', { json: body })).id;
          if (kind === 'reel' || kind === 'story_video') await waitForContainer(api, creation, signal);
        }
        const done = await api.request<{ id: string }>('POST', '/me/media_publish', { json: { creation_id: creation } });
        return { text: `Published (media ${done.id}).`, data: done };
      },
    },
    {
      name: 'instagram.publishing_limit',
      capability: 'publish',
      category: 'read',
      description: 'How many posts you have published through the API in the last 24 hours.',
      input: z.object({}),
      async run(_i, { api }) {
        const r = await api.request<{ data: { quota_usage: number; config?: { quota_total: number } }[] }>('GET', '/me/content_publishing_limit', { query: { fields: 'quota_usage,config' } });
        const d = r.data[0];
        return { text: d ? `${d.quota_usage} of ${d.config?.quota_total ?? 100} API posts used in the last 24 hours.` : 'Unknown.' };
      },
    },
    {
      name: 'instagram.conversations',
      capability: 'messages',
      category: 'read',
      untrusted: 'message',
      description: 'Your Instagram DM conversations with their latest messages.',
      input: z.object({}),
      async run(_i, { api }) {
        const r = await api.request<{ data: { id: string; updated_time: string; messages?: { data: { message?: string; from?: { username?: string; id: string }; created_time: string }[] } }[] }>('GET', '/me/conversations', { query: { platform: 'instagram', fields: 'id,updated_time,messages.limit(5){message,from,created_time}', limit: 20 } });
        return { text: lines(r.data.map((c) => `[${c.id}] updated ${c.updated_time}\n${(c.messages?.data ?? []).map((m) => `  ${m.from?.username ?? m.from?.id ?? '?'}: ${clip(m.message, 300)}`).join('\n')}`), 'No conversations.') };
      },
    },
    {
      name: 'instagram.send_message',
      capability: 'messages',
      category: 'communicate',
      description: 'Reply to someone in Instagram DMs (recipient id from instagram.conversations; within 24 hours of their message).',
      input: z.object({ recipient_id: z.string().regex(/^\d{5,30}$/), text: z.string().min(1).max(1000) }),
      preview: (i) => ({ title: `Send an Instagram DM to ${String(i.recipient_id)}`, body: String(i.text) }),
      async run(i, { api }) {
        const r = await api.request<{ message_id?: string }>('POST', '/me/messages', { json: { recipient: { id: i.recipient_id }, message: { text: i.text } } });
        return { text: `Sent${r.message_id ? ` (${r.message_id})` : ''}.` };
      },
    },
  ],
};

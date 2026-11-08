import { z } from '@feroxes/tools';
import { type ApiClient, type Connector, ConnectorError, bearer, clip, lines } from './framework.ts';

const email = z.string().email().max(254);
const iso = z.string().datetime({ offset: true });
const noCrlf = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();
const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url');

/** RFC 5322 message for Gmail's users.messages.send. Header values can't carry line breaks. */
export function mimeMessage(m: { to: string[]; cc?: string[]; subject: string; body: string; inReplyTo?: string }): string {
  const enc = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);
  const head = [
    `To: ${m.to.map(noCrlf).join(', ')}`,
    ...(m.cc?.length ? [`Cc: ${m.cc.map(noCrlf).join(', ')}`] : []),
    `Subject: ${enc(noCrlf(m.subject))}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${noCrlf(m.inReplyTo)}`, `References: ${noCrlf(m.inReplyTo)}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ];
  return `${head.join('\r\n')}\r\n\r\n${Buffer.from(m.body).toString('base64').replace(/.{76}/g, '$&\r\n')}`;
}

type GmailPart = { mimeType?: string; body?: { data?: string }; parts?: GmailPart[]; headers?: { name: string; value: string }[] };
function gmailText(p: GmailPart | undefined): string | undefined {
  if (!p) return undefined;
  if (p.mimeType === 'text/plain' && p.body?.data) return Buffer.from(p.body.data, 'base64url').toString('utf8');
  for (const c of p.parts ?? []) {
    const t = gmailText(c);
    if (t) return t;
  }
  if (p.mimeType === 'text/html' && p.body?.data) return Buffer.from(p.body.data, 'base64url').toString('utf8').replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ');
  return undefined;
}
const header = (p: GmailPart | undefined, name: string) => p?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary';
const DRIVE = 'https://www.googleapis.com/drive/v3';

/** Google: Gmail, Calendar, Drive and Contacts in one consent, scoped per capability. */
export const google: Connector = {
  id: 'google',
  name: 'Google',
  category: 'productivity',
  docsUrl: 'https://developers.google.com/identity/protocols/oauth2/native-app',
  auth: {
    kind: 'oauth2',
    appFields: [
      { key: 'client_id', label: 'OAuth client ID (Desktop app)', secret: false, placeholder: '….apps.googleusercontent.com' },
      { key: 'client_secret', label: 'Client secret', secret: true, help: 'Google issues one for Desktop clients; it is stored in the vault.' },
    ],
    oauth: {
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      revokeUrl: 'https://oauth2.googleapis.com/revoke',
      pkce: true,
      clientAuth: 'body',
      baseScopes: ['openid', 'email', 'profile'],
      extraAuthorizeParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
    },
  },
  capabilities: [
    { id: 'gmail_read', label: 'Read Gmail', description: 'Search and read your mail.', scopes: ['https://www.googleapis.com/auth/gmail.readonly'], default: true },
    { id: 'gmail_send', label: 'Send Gmail', description: 'Always asks before sending.', scopes: ['https://www.googleapis.com/auth/gmail.send'], default: false },
    { id: 'calendar_read', label: 'Read Calendar', description: '', scopes: ['https://www.googleapis.com/auth/calendar.readonly'], default: true },
    { id: 'calendar_write', label: 'Create and change events', description: 'Invitations always ask.', scopes: ['https://www.googleapis.com/auth/calendar.events'], default: false },
    { id: 'drive_read', label: 'Search and read Drive', description: '', scopes: ['https://www.googleapis.com/auth/drive.readonly'], default: true },
    { id: 'drive_write', label: 'Create files and move them to the trash', description: 'Only files Feroxes created (drive.file).', scopes: ['https://www.googleapis.com/auth/drive.file'], default: false },
    { id: 'contacts_read', label: 'Read Contacts', description: '', scopes: ['https://www.googleapis.com/auth/contacts.readonly'], default: true },
  ],
  limitations: [
    'You create the OAuth client in your own Google Cloud project (type "Desktop app"); Feroxes signs in with PKCE on a loopback address, as Google recommends for installed apps.',
    'While the consent screen is in "Testing", Google expires refresh tokens after 7 days. Set it to "In production" (your own unverified app is fine for personal use) to stay connected.',
    'Gmail read and Drive read are restricted scopes: an unverified personal app works for your own account; sharing the app with others would need Google verification.',
    'With drive.file, Feroxes can only change or trash files it created itself.',
  ],
  setupSteps: [
    'console.cloud.google.com → new project → enable the Gmail, Calendar, Drive and People APIs.',
    'OAuth consent screen → External → add yourself as a test user, then Publish to production.',
    'Credentials → Create OAuth client ID → Desktop app. Paste the client ID and secret here, then Connect.',
  ],
  baseUrl: () => 'https://www.googleapis.com',
  sign: bearer(),
  async whoami(api) {
    const u = await api.request<{ sub: string; email?: string; name?: string }>('GET', 'https://openidconnect.googleapis.com/v1/userinfo');
    return { id: u.sub, name: u.email ?? u.name ?? u.sub };
  },
  actions: [
    {
      name: 'google.gmail_search',
      capability: 'gmail_read',
      category: 'read',
      untrusted: 'email',
      liveSafe: true,
      description: 'Search Gmail with Gmail search syntax (e.g. "is:unread newer_than:2d"). Returns sender, subject, date and snippet.',
      input: z.object({ query: z.string().max(500).default('is:unread'), limit: z.number().int().min(1).max(25).default(10) }),
      async run(i, { api }) {
        const list = await api.request<{ messages?: { id: string }[]; resultSizeEstimate?: number }>('GET', `${GMAIL}/messages`, { query: { q: i.query as string, maxResults: i.limit as number } });
        const rows = await Promise.all(
          (list.messages ?? []).map(async (m) => {
            const msg = await api.request<{ id: string; snippet: string; payload: GmailPart }>('GET', `${GMAIL}/messages/${m.id}`, { query: { format: 'metadata', metadataHeaders: 'From' } });
            const full = await api.request<{ payload: GmailPart }>('GET', `${GMAIL}/messages/${m.id}`, { query: { format: 'metadata', metadataHeaders: 'Subject' } }).catch(() => msg);
            return `[${m.id}] ${header(msg.payload, 'From')} — ${clip(header(full.payload, 'Subject'), 120)}: ${clip(msg.snippet, 200)}`;
          }),
        );
        return { text: lines(rows, 'No matching mail.') };
      },
    },
    {
      name: 'google.gmail_read',
      capability: 'gmail_read',
      category: 'read',
      untrusted: 'email',
      description: 'Read one email (id from google.gmail_search).',
      input: z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{6,64}$/) }),
      async run(i, { api }) {
        const m = await api.request<{ id: string; threadId: string; payload: GmailPart; snippet: string }>('GET', `${GMAIL}/messages/${String(i.id)}`, { query: { format: 'full' } });
        const body = gmailText(m.payload) ?? m.snippet;
        return { text: `From: ${header(m.payload, 'From')}\nTo: ${header(m.payload, 'To')}\nDate: ${header(m.payload, 'Date')}\nSubject: ${header(m.payload, 'Subject')}\nMessage-ID: ${header(m.payload, 'Message-ID')}\n\n${clip(body, 12_000)}`, data: { threadId: m.threadId } };
      },
    },
    {
      name: 'google.gmail_send',
      capability: 'gmail_send',
      category: 'communicate',
      description: 'Send an email from your Gmail account.',
      input: z.object({ to: z.array(email).min(1).max(20), cc: z.array(email).max(20).default([]), subject: z.string().max(300), body: z.string().max(50_000), thread_id: z.string().max(64).optional(), in_reply_to: z.string().max(500).optional() }),
      preview: (i) => ({ title: `Send an email to ${(i.to as string[]).join(', ')}`, body: `Subject: ${String(i.subject)}\n\n${String(i.body)}`, ...((i.cc as string[]).length ? { fields: { cc: (i.cc as string[]).join(', ') } } : {}) }),
      async run(i, { api }) {
        const raw = b64url(mimeMessage({ to: i.to as string[], cc: i.cc as string[], subject: String(i.subject), body: String(i.body), ...(i.in_reply_to ? { inReplyTo: String(i.in_reply_to) } : {}) }));
        const r = await api.request<{ id: string }>('POST', `${GMAIL}/messages/send`, { json: { raw, ...(i.thread_id ? { threadId: i.thread_id } : {}) } });
        return { text: `Sent (message ${r.id}).` };
      },
    },
    {
      name: 'google.calendar_upcoming',
      capability: 'calendar_read',
      category: 'read',
      untrusted: 'message',
      liveSafe: true,
      description: 'Upcoming events on your primary calendar.',
      input: z.object({ days: z.number().int().min(1).max(60).default(7) }),
      async run(i, { api }) {
        const now = new Date();
        const r = await api.request<{ items: { id: string; summary?: string; start: { dateTime?: string; date?: string }; end: { dateTime?: string; date?: string }; location?: string; attendees?: unknown[] }[] }>('GET', `${CAL}/events`, { query: { timeMin: now.toISOString(), timeMax: new Date(now.getTime() + Number(i.days) * 864e5).toISOString(), singleEvents: true, orderBy: 'startTime', maxResults: 50 } });
        return { text: lines(r.items.map((e) => `[${e.id}] ${e.start.dateTime ?? e.start.date} → ${e.end.dateTime ?? e.end.date}: ${clip(e.summary ?? '(no title)', 120)}${e.location ? ` @ ${clip(e.location, 60)}` : ''}${e.attendees?.length ? ` (${e.attendees.length} people)` : ''}`), 'Nothing scheduled.') };
      },
    },
    {
      name: 'google.calendar_create',
      capability: 'calendar_write',
      category: 'external_write',
      riskFor: (i) => ((i.attendees as string[] | undefined)?.length ? 'communicate' : 'external_write'),
      description: 'Create an event on your primary calendar. With attendees, Google emails them invitations.',
      input: z.object({ title: z.string().min(1).max(300), start: iso, end: iso, description: z.string().max(8000).default(''), location: z.string().max(300).optional(), attendees: z.array(email).max(50).default([]) }),
      preview: (i) => ({ title: `Add "${String(i.title)}" to your calendar${(i.attendees as string[]).length ? ` and invite ${(i.attendees as string[]).join(', ')}` : ''}`, body: `${String(i.start)} → ${String(i.end)}${i.location ? `\n${String(i.location)}` : ''}\n\n${String(i.description ?? '')}` }),
      async run(i, { api }) {
        const attendees = i.attendees as string[];
        const r = await api.request<{ id: string; htmlLink: string }>('POST', `${CAL}/events`, { query: { sendUpdates: attendees.length ? 'all' : 'none' }, json: { summary: i.title, description: i.description, ...(i.location ? { location: i.location } : {}), start: { dateTime: i.start }, end: { dateTime: i.end }, attendees: attendees.map((a) => ({ email: a })) } });
        return { text: `Event created: ${r.htmlLink}` };
      },
    },
    {
      name: 'google.drive_search',
      capability: 'drive_read',
      category: 'read',
      description: 'Find files in Google Drive by name or text.',
      input: z.object({ query: z.string().min(1).max(200) }),
      async run(i, { api }) {
        const q = String(i.query).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const r = await api.request<{ files: { id: string; name: string; mimeType: string; modifiedTime: string; webViewLink?: string }[] }>('GET', `${DRIVE}/files`, { query: { q: `(name contains '${q}' or fullText contains '${q}') and trashed = false`, fields: 'files(id,name,mimeType,modifiedTime,webViewLink)', pageSize: 20, orderBy: 'modifiedTime desc' } });
        return { text: lines(r.files.map((f) => `[${f.id}] ${f.name} (${f.mimeType.replace('application/vnd.google-apps.', 'google ')}, ${f.modifiedTime})`), 'No files found.') };
      },
    },
    {
      name: 'google.drive_read',
      capability: 'drive_read',
      category: 'read',
      untrusted: 'document',
      description: 'Read a Google Doc, Sheet (as CSV) or text file from Drive.',
      input: z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{10,100}$/) }),
      async run(i, { api }) {
        const meta = await api.request<{ name: string; mimeType: string; size?: string }>('GET', `${DRIVE}/files/${String(i.id)}`, { query: { fields: 'name,mimeType,size' } });
        const exportAs: Record<string, string> = { 'application/vnd.google-apps.document': 'text/plain', 'application/vnd.google-apps.spreadsheet': 'text/csv', 'application/vnd.google-apps.presentation': 'text/plain' };
        let body: string;
        if (exportAs[meta.mimeType]) body = await api.request<string>('GET', `${DRIVE}/files/${String(i.id)}/export`, { query: { mimeType: exportAs[meta.mimeType] }, text: true });
        else if (meta.mimeType.startsWith('text/') || meta.mimeType === 'application/json') {
          if (Number(meta.size ?? 0) > 2_000_000) throw new ConnectorError('bad_request', `${meta.name} is too large to read here.`);
          body = await api.request<string>('GET', `${DRIVE}/files/${String(i.id)}`, { query: { alt: 'media' }, text: true });
        } else throw new ConnectorError('bad_request', `${meta.name} (${meta.mimeType}) isn't a text document.`);
        return { text: `${meta.name}\n\n${clip(body, 20_000)}` };
      },
    },
    {
      name: 'google.drive_create',
      capability: 'drive_write',
      category: 'external_write',
      description: 'Create a text file (or Google Doc) in Drive.',
      input: z.object({ name: z.string().min(1).max(200), content: z.string().max(1_000_000), as_google_doc: z.boolean().default(false) }),
      preview: (i) => ({ title: `Create "${String(i.name)}" in Google Drive`, body: clip(i.content, 2000) }),
      async run(i, { api }) {
        const boundary = `feroxes${Date.now().toString(36)}`;
        const meta = { name: i.name, ...(i.as_google_doc ? { mimeType: 'application/vnd.google-apps.document' } : {}) };
        const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${String(i.content)}\r\n--${boundary}--`;
        const r = await api.request<{ id: string; webViewLink?: string }>('POST', 'https://www.googleapis.com/upload/drive/v3/files', { query: { uploadType: 'multipart', fields: 'id,webViewLink' }, body, headers: { 'content-type': `multipart/related; boundary=${boundary}` } });
        return { text: `Created ${r.webViewLink ?? r.id}` };
      },
    },
    {
      name: 'google.drive_trash',
      capability: 'drive_write',
      category: 'destructive',
      description: 'Move a file Feroxes created to the Drive trash (restorable for 30 days).',
      input: z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{10,100}$/) }),
      preview: (i) => ({ title: `Move Drive file ${String(i.id)} to the trash` }),
      async run(i, { api }) {
        await api.request('PATCH', `${DRIVE}/files/${String(i.id)}`, { json: { trashed: true } });
        return { text: 'Moved to the trash.' };
      },
    },
    {
      name: 'google.contacts_search',
      capability: 'contacts_read',
      category: 'read',
      description: 'Find a contact by name, email or phone.',
      input: z.object({ query: z.string().min(1).max(100) }),
      async run(i, { api }) {
        const url = 'https://people.googleapis.com/v1/people:searchContacts';
        const readMask = 'names,emailAddresses,phoneNumbers,organizations';
        await api.request('GET', url, { query: { query: '', readMask } }); // warm-up request, as the People API requires
        const r = await api.request<{ results?: { person: { names?: { displayName: string }[]; emailAddresses?: { value: string }[]; phoneNumbers?: { value: string }[]; organizations?: { name?: string }[] } }[] }>('GET', url, { query: { query: i.query as string, readMask, pageSize: 10 } });
        return { text: lines((r.results ?? []).map(({ person: p }) => `${p.names?.[0]?.displayName ?? '?'}${p.organizations?.[0]?.name ? ` (${p.organizations[0].name})` : ''}: ${[...(p.emailAddresses ?? []).map((e) => e.value), ...(p.phoneNumbers ?? []).map((n) => n.value)].join(', ')}`), 'No contacts found.') };
      },
    },
  ],
};

// ------------------------------------------------------------------ Microsoft Outlook (Graph)

const GRAPH = 'https://graph.microsoft.com/v1.0';

export const outlook: Connector = {
  id: 'outlook',
  name: 'Microsoft Outlook',
  category: 'productivity',
  docsUrl: 'https://learn.microsoft.com/graph/outlook-mail-concept-overview',
  auth: {
    kind: 'oauth2',
    appFields: [
      { key: 'client_id', label: 'Application (client) ID', secret: false, help: 'Azure portal → App registrations → New registration → platform "Mobile and desktop applications" with the redirect URI Feroxes shows.' },
      { key: 'client_secret', label: 'Client secret (leave empty for a public client)', secret: true, optional: true },
    ],
    oauth: { authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token', pkce: true, clientAuth: 'body', baseScopes: ['offline_access', 'User.Read'] },
  },
  capabilities: [
    { id: 'mail_read', label: 'Read mail', description: '', scopes: ['Mail.Read'], default: true },
    { id: 'mail_send', label: 'Send mail', description: 'Always asks.', scopes: ['Mail.Send'], default: false },
    { id: 'calendar_read', label: 'Read calendar', description: '', scopes: ['Calendars.Read'], default: true },
    { id: 'calendar_write', label: 'Create events', description: 'Invitations always ask.', scopes: ['Calendars.ReadWrite'], default: false },
  ],
  limitations: [
    'Works with personal Microsoft accounts (Outlook.com) and work/school accounts; a work tenant may require admin consent for these permissions.',
    'Microsoft has no standard token revocation endpoint: disconnecting deletes the tokens here; remove the app at account.live.com/consent/Manage (personal) or myapps.microsoft.com (work) to revoke it.',
  ],
  setupSteps: ['portal.azure.com → Microsoft Entra ID → App registrations → New registration (accounts in any organizational directory and personal accounts).', 'Authentication → add platform "Mobile and desktop applications" with the redirect URI shown here.', 'Paste the Application (client) ID here and Connect.'],
  baseUrl: () => GRAPH,
  sign: bearer(),
  async whoami(api) {
    const u = await api.request<{ id: string; displayName?: string; mail?: string; userPrincipalName?: string }>('GET', '/me', { query: { $select: 'id,displayName,mail,userPrincipalName' } });
    return { id: u.id, name: u.mail ?? u.userPrincipalName ?? u.displayName ?? u.id };
  },
  actions: [
    {
      name: 'outlook.mail_search',
      capability: 'mail_read',
      category: 'read',
      untrusted: 'email',
      liveSafe: true,
      description: 'Search your Outlook mail (keywords; empty = latest).',
      input: z.object({ query: z.string().max(200).default('') }),
      async run(i, { api }) {
        const q = String(i.query).replace(/"/g, '');
        const r = await api.request<{ value: { id: string; subject?: string; from?: { emailAddress: { address: string; name?: string } }; receivedDateTime: string; bodyPreview?: string; isRead?: boolean }[] }>('GET', '/me/messages', { query: { ...(q ? { $search: `"${q}"` } : { $orderby: 'receivedDateTime desc' }), $top: 15, $select: 'id,subject,from,receivedDateTime,bodyPreview,isRead' } });
        return { text: lines(r.value.map((m) => `[${m.id.slice(-24)}] ${m.isRead === false ? '(unread) ' : ''}${m.from?.emailAddress.address ?? '?'} — ${clip(m.subject, 120)} (${m.receivedDateTime}): ${clip(m.bodyPreview, 200)}`), 'No mail found.'), data: r.value.map((m) => m.id) };
      },
    },
    {
      name: 'outlook.mail_read',
      capability: 'mail_read',
      category: 'read',
      untrusted: 'email',
      description: 'Read one Outlook email by its full id.',
      input: z.object({ id: z.string().min(10).max(400) }),
      async run(i, { api }) {
        const m = await api.request<{ subject?: string; from?: { emailAddress: { address: string } }; toRecipients?: { emailAddress: { address: string } }[]; receivedDateTime: string; body: { content: string } }>('GET', `/me/messages/${encodeURIComponent(String(i.id))}`, { query: { $select: 'subject,from,toRecipients,receivedDateTime,body' }, headers: { prefer: 'outlook.body-content-type="text"' } });
        return { text: `From: ${m.from?.emailAddress.address ?? '?'}\nTo: ${(m.toRecipients ?? []).map((r) => r.emailAddress.address).join(', ')}\nDate: ${m.receivedDateTime}\nSubject: ${m.subject ?? ''}\n\n${clip(m.body.content, 12_000)}` };
      },
    },
    {
      name: 'outlook.mail_send',
      capability: 'mail_send',
      category: 'communicate',
      description: 'Send an email from your Outlook account.',
      input: z.object({ to: z.array(email).min(1).max(20), cc: z.array(email).max(20).default([]), subject: z.string().max(300), body: z.string().max(50_000) }),
      preview: (i) => ({ title: `Send an email to ${(i.to as string[]).join(', ')}`, body: `Subject: ${String(i.subject)}\n\n${String(i.body)}` }),
      async run(i, { api }) {
        const rcpt = (xs: string[]) => xs.map((address) => ({ emailAddress: { address } }));
        await api.request('POST', '/me/sendMail', { json: { message: { subject: noCrlf(String(i.subject)), body: { contentType: 'Text', content: i.body }, toRecipients: rcpt(i.to as string[]), ccRecipients: rcpt(i.cc as string[]) }, saveToSentItems: true } });
        return { text: 'Sent.' };
      },
    },
    {
      name: 'outlook.calendar',
      capability: 'calendar_read',
      category: 'read',
      untrusted: 'message',
      description: 'Your Outlook calendar for the next days.',
      input: z.object({ days: z.number().int().min(1).max(60).default(7) }),
      async run(i, { api }) {
        const now = new Date();
        const r = await api.request<{ value: { subject?: string; start: { dateTime: string }; end: { dateTime: string }; location?: { displayName?: string }; organizer?: { emailAddress: { address: string } } }[] }>('GET', '/me/calendarView', { query: { startDateTime: now.toISOString(), endDateTime: new Date(now.getTime() + Number(i.days) * 864e5).toISOString(), $orderby: 'start/dateTime', $top: 50, $select: 'subject,start,end,location,organizer' }, headers: { prefer: 'outlook.timezone="UTC"' } });
        return { text: lines(r.value.map((e) => `${e.start.dateTime}Z → ${e.end.dateTime}Z: ${clip(e.subject ?? '(no title)', 120)}${e.location?.displayName ? ` @ ${e.location.displayName}` : ''}`), 'Nothing scheduled.') };
      },
    },
    {
      name: 'outlook.create_event',
      capability: 'calendar_write',
      category: 'external_write',
      riskFor: (i) => ((i.attendees as string[] | undefined)?.length ? 'communicate' : 'external_write'),
      description: 'Create an Outlook calendar event (attendees receive invitations).',
      input: z.object({ title: z.string().min(1).max(300), start: iso, end: iso, body: z.string().max(8000).default(''), attendees: z.array(email).max(50).default([]) }),
      preview: (i) => ({ title: `Add "${String(i.title)}" to Outlook${(i.attendees as string[]).length ? ` and invite ${(i.attendees as string[]).join(', ')}` : ''}`, body: `${String(i.start)} → ${String(i.end)}\n\n${String(i.body ?? '')}` }),
      async run(i, { api }) {
        const r = await api.request<{ webLink?: string }>('POST', '/me/events', { json: { subject: i.title, body: { contentType: 'Text', content: i.body }, start: { dateTime: new Date(String(i.start)).toISOString().slice(0, 19), timeZone: 'UTC' }, end: { dateTime: new Date(String(i.end)).toISOString().slice(0, 19), timeZone: 'UTC' }, attendees: (i.attendees as string[]).map((a) => ({ emailAddress: { address: a }, type: 'required' })) } });
        return { text: `Event created${r.webLink ? `: ${r.webLink}` : '.'}` };
      },
    },
  ],
};

// ------------------------------------------------------------------ Notion

function richText(rt: { plain_text?: string }[] | undefined): string {
  return (rt ?? []).map((t) => t.plain_text ?? '').join('');
}
const paragraphs = (content: string) =>
  content
    .split(/\n{2,}/)
    .filter((p) => p.trim())
    .slice(0, 90)
    .map((p) => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: p.slice(0, 2000) } }] } }));

async function notionTitle(api: ApiClient, item: { object: string; properties?: Record<string, { type: string; title?: { plain_text: string }[] }>; title?: { plain_text: string }[] }) {
  void api;
  if (item.object === 'database') return richText(item.title);
  const prop = Object.values(item.properties ?? {}).find((p) => p.type === 'title');
  return richText(prop?.title) || '(untitled)';
}

export const notion: Connector = {
  id: 'notion',
  name: 'Notion',
  category: 'productivity',
  docsUrl: 'https://developers.notion.com/reference/intro',
  auth: { kind: 'token', fields: [{ key: 'access_token', label: 'Internal integration secret', secret: true, placeholder: 'ntn_…', help: 'notion.so/profile/integrations → New integration → copy the secret. Then share pages with it (••• → Connections).' }] },
  capabilities: [
    { id: 'read', label: 'Search and read shared pages', description: '', default: true },
    { id: 'write', label: 'Create pages and add content', description: 'Asks unless your autonomy settings allow it.', default: false },
  ],
  limitations: ['The integration sees only pages and databases you share with it (••• → Connections → your integration).', 'Notion allows about 3 requests per second per integration.', 'Blocks are read as plain text; images, embeds and some block types are skipped.'],
  setupSteps: ['notion.so/profile/integrations → New integration (Internal) → copy the secret.', 'Paste it here.', 'In Notion, share the pages Feroxes may use with the integration.'],
  defaultHeaders: { 'notion-version': '2022-06-28' },
  baseUrl: () => 'https://api.notion.com/v1',
  sign: bearer(),
  async whoami(api) {
    const u = await api.request<{ id: string; name?: string; bot?: { workspace_name?: string } }>('GET', '/users/me');
    return { id: u.id, name: u.bot?.workspace_name ? `${u.name ?? 'Integration'} (${u.bot.workspace_name})` : (u.name ?? u.id) };
  },
  actions: [
    {
      name: 'notion.search',
      capability: 'read',
      category: 'read',
      liveSafe: true,
      description: 'Search pages and databases shared with Feroxes.',
      input: z.object({ query: z.string().max(200).default('') }),
      async run(i, { api }) {
        const r = await api.request<{ results: { id: string; object: string; url?: string; last_edited_time?: string; properties?: Record<string, { type: string; title?: { plain_text: string }[] }>; title?: { plain_text: string }[] }[] }>('POST', '/search', { json: { query: i.query, page_size: 20 } });
        const rows = await Promise.all(r.results.map(async (x) => `[${x.id}] ${x.object}: ${await notionTitle(api, x)} (${x.last_edited_time ?? ''})`));
        return { text: lines(rows, 'Nothing shared with the integration matches.') };
      },
    },
    {
      name: 'notion.read',
      capability: 'read',
      category: 'read',
      untrusted: 'document',
      description: 'Read the text of a Notion page.',
      input: z.object({ page_id: z.string().regex(/^[0-9a-f-]{32,36}$/i) }),
      async run(i, { api }) {
        const out: string[] = [];
        let cursor: string | undefined;
        do {
          const r = await api.request<{ results: Record<string, unknown>[]; next_cursor: string | null; has_more: boolean }>('GET', `/blocks/${String(i.page_id)}/children`, { query: { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) } });
          for (const b of r.results) {
            const type = String(b.type);
            const t = richText((b[type] as { rich_text?: { plain_text?: string }[] } | undefined)?.rich_text);
            if (t) out.push(type.startsWith('heading') ? `\n${t}` : type === 'to_do' ? `[${(b[type] as { checked?: boolean }).checked ? 'x' : ' '}] ${t}` : type.includes('list_item') ? `- ${t}` : t);
          }
          cursor = r.has_more ? (r.next_cursor ?? undefined) : undefined;
        } while (cursor && out.join('\n').length < 20_000);
        return { text: clip(out.join('\n'), 20_000) || '(empty page)' };
      },
    },
    {
      name: 'notion.create_page',
      capability: 'write',
      category: 'external_write',
      description: 'Create a page under a parent page shared with Feroxes.',
      input: z.object({ parent_page_id: z.string().regex(/^[0-9a-f-]{32,36}$/i), title: z.string().min(1).max(200), content: z.string().max(100_000).default('') }),
      preview: (i) => ({ title: `Create the Notion page "${String(i.title)}"`, body: clip(i.content, 2000) }),
      async run(i, { api }) {
        const r = await api.request<{ id: string; url: string }>('POST', '/pages', { json: { parent: { page_id: i.parent_page_id }, properties: { title: { title: [{ text: { content: i.title } }] } }, children: paragraphs(String(i.content ?? '')) } });
        return { text: `Created ${r.url}` };
      },
    },
    {
      name: 'notion.append',
      capability: 'write',
      category: 'external_write',
      description: 'Append text to the end of a Notion page.',
      input: z.object({ page_id: z.string().regex(/^[0-9a-f-]{32,36}$/i), content: z.string().min(1).max(100_000) }),
      preview: (i) => ({ title: `Add text to Notion page ${String(i.page_id)}`, body: clip(i.content, 2000) }),
      async run(i, { api }) {
        await api.request('PATCH', `/blocks/${String(i.page_id)}/children`, { json: { children: paragraphs(String(i.content)) } });
        return { text: 'Added.' };
      },
    },
  ],
};

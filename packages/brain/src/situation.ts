import type { SessionMessage } from '@feroxes/agent';
import type { DeviceEvent, DeviceSummary } from '@feroxes/devices';
import { type Clock, localParts, systemClock } from '@feroxes/shared';

export interface Anomaly {
  key: string; // dedupe key
  severity: 'info' | 'warning' | 'critical';
  message: string;
  suggestion?: string;
}

/** A sensor adds facts and anomalies to the situation. Calendar, email, weather etc. plug in here. */
export interface Sensor {
  name: string;
  read(now: number): Promise<{ facts: string[]; anomalies: Anomaly[] }>;
}

export interface SituationSnapshot {
  at: number;
  facts: string[];
  anomalies: Anomaly[];
}

/** PC and phone health from device heartbeats: battery, disk, memory, CPU, connectivity. */
export function deviceSensor(devices: () => DeviceSummary[]): Sensor {
  return {
    name: 'devices',
    async read() {
      const facts: string[] = [];
      const anomalies: Anomaly[] = [];
      for (const d of devices()) {
        const s = d.state;
        const bits = [d.online ? 'online' : 'offline', s.locked ? 'locked' : '', s.foregroundApp ? `using ${s.foregroundApp}` : '', s.battery ? `battery ${s.battery.percent}%${s.battery.charging ? ' charging' : ''}` : '', s.network ? `network ${s.network}` : '', s.diskFreeGb !== undefined ? `${s.diskFreeGb} GB free` : '', d.ownerActive ? 'owner active now' : ''].filter(Boolean);
        facts.push(`${d.name} (${d.kind}): ${bits.join(', ')}`);
        if (s.battery && s.battery.percent <= 15 && !s.battery.charging) anomalies.push({ key: `battery:${d.id}`, severity: s.battery.percent <= 5 ? 'critical' : 'warning', message: `${d.name} battery at ${s.battery.percent}%`, suggestion: 'Plug it in.' });
        if (s.diskFreeGb !== undefined && s.diskFreeGb < 10) anomalies.push({ key: `disk:${d.id}`, severity: s.diskFreeGb < 3 ? 'critical' : 'warning', message: `${d.name} has only ${s.diskFreeGb} GB free`, suggestion: 'I can list the largest folders and old downloads for you to review.' });
        if (s.memoryPercent !== undefined && s.memoryPercent > 92) anomalies.push({ key: `mem:${d.id}`, severity: 'warning', message: `${d.name} memory at ${s.memoryPercent}%`, suggestion: 'I can show the apps using the most memory.' });
        if (s.cpuPercent !== undefined && s.cpuPercent > 95) anomalies.push({ key: `cpu:${d.id}`, severity: 'info', message: `${d.name} CPU at ${s.cpuPercent}%` });
        if (s.network === 'offline') anomalies.push({ key: `net:${d.id}`, severity: 'warning', message: `${d.name} reports no network` });
      }
      return { facts, anomalies };
    },
  };
}

const PHISHING = [
  /\b(verify|confirm|update)\b.{0,40}\b(account|password|bank|card|identity)\b/i,
  /\b(urgent|immediately|within 24 hours|suspended|locked)\b/i,
  /\b(gift ?cards?|wire transfer|crypto|bitcoin|western union)\b/i,
  /\b(otp|one[- ]time code|verification code|pin)\b.{0,30}\b(send|share|tell|give)\b|\b(send|share|tell|give)\b.{0,30}\b(otp|code|pin|password|bank details)\b/i,
  /https?:\/\/[^\s]*(?:bit\.ly|tinyurl|t\.co|[0-9]{1,3}(?:\.[0-9]{1,3}){3}|-login|-verify|secure-)/i,
];

/** Scores a message for scam or phishing patterns (heuristic first pass; 0..1). */
export function phishingScore(text: string): number {
  const hits = PHISHING.filter((p) => p.test(text)).length;
  return Math.min(1, hits / 3);
}

/** Watches incoming phone notifications for scam patterns (defensive awareness). */
export class ThreatSensor implements Sensor {
  readonly name = 'threats';
  private readonly recent: { at: number; from: string; text: string; score: number }[] = [];

  observe(e: DeviceEvent) {
    if (e.event !== 'notification') return;
    const text = `${String(e.data.title ?? '')} ${String(e.data.text ?? '')}`;
    const score = phishingScore(text);
    if (score >= 0.34) this.recent.push({ at: e.at, from: String(e.data.app ?? e.deviceName), text: text.slice(0, 160), score });
    if (this.recent.length > 50) this.recent.shift();
  }

  async read(now: number) {
    const fresh = this.recent.filter((r) => now - r.at < 24 * 3_600_000);
    return {
      facts: [],
      anomalies: fresh.map((r) => ({ key: `phish:${r.at}`, severity: r.score >= 0.66 ? 'critical' : 'warning', message: `Possible scam message (${r.from}): "${r.text}"`, suggestion: "Don't reply, click links or share codes. I won't act on it." }) as Anomaly),
    };
  }
}

/**
 * Life patterns from the owner's own messages: when they are usually active. Used to time
 * proactive messages and to predict quiet hours (a small, inspectable world model).
 */
export function activityPattern(messages: Pick<SessionMessage, 'role' | 'createdAt'>[], timeZone: string): { activeHours: number[]; quietHours: number[]; samples: number } {
  const counts = new Array<number>(24).fill(0);
  let samples = 0;
  for (const m of messages) {
    if (m.role !== 'user') continue;
    counts[localParts(m.createdAt, timeZone).hour]!++;
    samples++;
  }
  if (samples < 20) return { activeHours: [], quietHours: [], samples };
  const max = Math.max(...counts);
  return { activeHours: counts.map((c, h) => (c >= max * 0.5 ? h : -1)).filter((h) => h >= 0), quietHours: counts.map((c, h) => (c === 0 ? h : -1)).filter((h) => h >= 0), samples };
}

/** Owner-state model: frustration, hurry and mood signals from recent messages, as style guidance. */
export function ownerState(recent: Pick<SessionMessage, 'role' | 'content' | 'createdAt'>[], now: number, timeZone: string): { signals: Record<string, number | boolean>; guidance: string } {
  const own = recent.filter((m) => m.role === 'user').slice(-6);
  const text = own.map((m) => m.content).join('\n');
  const frustration = Math.min(1, (text.match(/\b(wtf|ugh|again|still (not|doesn'?t)|not working|broken|useless|wrong|why (is|does|won'?t)|come on)\b/gi)?.length ?? 0) * 0.25 + (text.match(/[!?]{2,}/g)?.length ?? 0) * 0.15 + (/[A-Z]{5,}/.test(text) ? 0.2 : 0));
  const gratitude = /\b(thanks|thank you|great|perfect|awesome|love it|nice)\b/i.test(text);
  const gaps = own.slice(1).map((m, i) => m.createdAt - own[i]!.createdAt);
  const hurried = gaps.length >= 2 && gaps.every((g) => g < 45_000) && own.every((m) => m.content.length < 80);
  const hour = localParts(now, timeZone).hour;
  const lateNight = hour >= 0 && hour < 5;
  const corrections = (text.match(/\b(no,|actually|that'?s wrong|not what i)\b/gi)?.length ?? 0);
  const tips: string[] = [];
  if (frustration >= 0.5) tips.push('The owner seems frustrated: fix the problem first, be brief, no filler, acknowledge the mistake once.');
  if (hurried) tips.push('The owner is in a hurry: answer in one or two lines.');
  if (lateNight) tips.push("It's late at night for the owner: keep it short and avoid starting long tasks unless asked.");
  if (corrections >= 2) tips.push('You were corrected several times: double-check facts before answering.');
  if (gratitude && frustration < 0.3) tips.push('The owner is in a good mood.');
  return { signals: { frustration: Math.round(frustration * 100) / 100, hurried, lateNight, corrections, gratitude }, guidance: tips.join(' ') };
}

/** Fuses all sensors into one "current situation" block, and reports new anomalies once. */
export class SituationService {
  private readonly sensors: Sensor[];
  private readonly clock: Clock;
  private readonly seen = new Map<string, number>();
  private last?: SituationSnapshot;

  constructor(deps: { sensors: Sensor[]; clock?: Clock }) {
    this.sensors = deps.sensors;
    this.clock = deps.clock ?? systemClock;
  }

  async snapshot(): Promise<SituationSnapshot> {
    const now = this.clock.now();
    const facts: string[] = [];
    const anomalies: Anomaly[] = [];
    for (const s of this.sensors) {
      try {
        const r = await s.read(now);
        facts.push(...r.facts);
        anomalies.push(...r.anomalies);
      } catch (error) {
        facts.push(`(sensor ${s.name} failed: ${String(error)})`);
      }
    }
    this.last = { at: now, facts, anomalies };
    return this.last;
  }

  /** Anomalies not reported in the last 6 hours (for proactive notifications). */
  async newAnomalies(): Promise<Anomaly[]> {
    const now = this.clock.now();
    const snap = await this.snapshot();
    const fresh = snap.anomalies.filter((a) => (this.seen.get(a.key) ?? 0) < now - 6 * 3_600_000);
    for (const a of fresh) this.seen.set(a.key, now);
    return fresh;
  }

  async render(): Promise<string> {
    const snap = await this.snapshot();
    if (!snap.facts.length && !snap.anomalies.length) return '';
    return [`<situation at="${new Date(snap.at).toISOString()}">`, ...snap.facts.map((f) => `- ${f}`), ...snap.anomalies.map((a) => `! ${a.severity}: ${a.message}${a.suggestion ? ` (${a.suggestion})` : ''}`), '</situation>'].join('\n');
  }
}

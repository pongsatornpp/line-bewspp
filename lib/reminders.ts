import { Redis } from "@upstash/redis";
import type { SheetRow } from "./sheet";
import { addDays, todayBangkok } from "./sheet";

const KEY = "yuta:reminders";
const BANGKOK_OFFSET_H = 7;

export type Reminder = {
  id: string;
  userId: string;
  callName: string;
  message: string;
  dueAt: number; // epoch ms
};

/** Shape returned by Gemini's structured parse of a "remind me" request. */
export type ReminderRequest = {
  kind: "absolute" | "in_minutes" | "before_event" | "unclear";
  time?: string; // HH:MM, 24h Bangkok
  date?: string; // YYYY-MM-DD or ""
  minutes?: number;
  eventTitle?: string;
  message?: string;
};

function redis(): Redis | null {
  // Vercel Marketplace may inject either naming scheme.
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  return url && token ? new Redis({ url, token }) : null;
}

export const remindersEnabled = () => redis() !== null;

export async function addReminder(r: Reminder): Promise<void> {
  const db = redis();
  if (!db) throw new Error("reminders not configured");
  await db.zadd(KEY, { score: r.dueAt, member: r });
}

/** Returns due reminders; each is claimed with ZREM so concurrent cron runs never send twice. */
export async function claimDueReminders(nowMs: number): Promise<Reminder[]> {
  const db = redis();
  if (!db) return [];
  const due = await db.zrange<Reminder[]>(KEY, 0, nowMs, { byScore: true });
  const claimed: Reminder[] = [];
  for (const r of due) {
    if ((await db.zrem(KEY, r)) === 1) claimed.push(r);
  }
  return claimed;
}

// ---------- time resolution (done in code, never by the model) ----------

export function bangkokToMs(date: string, time: string): number | null {
  const d = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const t = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!d || !t) return null;
  const h = Number(t[1]);
  const min = Number(t[2]);
  if (h > 23 || min > 59) return null;
  return Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), h - BANGKOK_OFFSET_H, min);
}

export function describeWhen(dueAt: number, nowMs: number): string {
  const bkk = (ms: number) => new Date(ms + BANGKOK_OFFSET_H * 3600_000).toISOString();
  const [day, hm] = [bkk(dueAt).slice(0, 10), bkk(dueAt).slice(11, 16)];
  const today = todayBangkok(new Date(nowMs));
  if (day === today) return `วันนี้ ${hm}`;
  if (day === addDays(today, 1)) return `พรุ่งนี้ ${hm}`;
  return `วันที่ ${day.slice(8, 10)}/${day.slice(5, 7)} ${hm}`;
}

export type Resolved = { dueAt: number; message: string } | { error: "unclear" | "past" | "no_event" };

export function resolveReminder(
  req: ReminderRequest,
  nowMs: number,
  events: SheetRow[],
): Resolved {
  const extra = req.message?.trim();

  if (req.kind === "in_minutes" && req.minutes && req.minutes > 0) {
    return { dueAt: nowMs + req.minutes * 60_000, message: extra || "ครบเวลาที่ให้เตือนแล้ว" };
  }

  if (req.kind === "absolute" && req.time) {
    const today = todayBangkok(new Date(nowMs));
    const explicit = req.date && /^\d{4}-\d{2}-\d{2}$/.test(req.date) ? req.date : null;
    let dueAt = bangkokToMs(explicit ?? today, req.time);
    if (dueAt === null) return { error: "unclear" };
    if (dueAt <= nowMs) {
      if (explicit) return { error: "past" };
      dueAt = bangkokToMs(addDays(today, 1), req.time)!; // time already passed today -> tomorrow
    }
    return { dueAt, message: extra || "ครบเวลาที่ให้เตือนแล้ว" };
  }

  if (req.kind === "before_event" && req.eventTitle && req.minutes && req.minutes > 0) {
    const title = req.eventTitle.trim();
    const upcoming = events
      .filter((e) => e.title && (e.title.includes(title) || title.includes(e.title)))
      .map((e) => ({ e, startMs: bangkokToMs(e.date, e.start) }))
      .filter((x): x is { e: SheetRow; startMs: number } => x.startMs !== null && x.startMs > nowMs)
      .sort((a, b) => a.startMs - b.startMs);
    if (upcoming.length === 0) return { error: "no_event" };
    const { e, startMs } = upcoming[0];
    const dueAt = startMs - req.minutes * 60_000;
    if (dueAt <= nowMs) return { error: "past" };
    return { dueAt, message: `อีก ${req.minutes} นาที ${e.title} จะเริ่มแล้วนะ (${e.start})` };
  }

  return { error: "unclear" };
}

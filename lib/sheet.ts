const TZ = "Asia/Bangkok";
const CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 2_500;

export type SheetRow = {
  type: string;
  date: string;
  start: string;
  end: string;
  title: string;
  place: string;
  priority: string;
  note: string;
};

export type SheetData = { events: SheetRow[]; faqs: SheetRow[] };

// ---------- Bangkok time helpers ----------

function bangkokParts(d: Date): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const out: Record<string, string> = {};
  for (const p of parts) out[p.type] = p.value;
  if (out.hour === "24") out.hour = "00";
  return out;
}

/** YYYY-MM-DD in Asia/Bangkok */
export function todayBangkok(now: Date = new Date()): string {
  const p = bangkokParts(now);
  return `${p.year}-${p.month}-${p.day}`;
}

/** e.g. "2026-11-22 14:05" in Asia/Bangkok */
export function nowBangkokString(now: Date = new Date()): string {
  const p = bangkokParts(now);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/** Pick the date the user is asking about. Falls back to today (Bangkok). */
export function resolveQuestionDate(question: string, now: Date = new Date()): string | null {
  const today = todayBangkok(now);
  const iso = question.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  if (question.includes("มะรืน")) return addDays(today, 2);
  if (question.includes("พรุ่งนี้")) return addDays(today, 1);
  if (question.includes("วันนี้")) return today;
  const dm = question.match(/(?<![\d:])(\d{1,2})\/(\d{1,2})(?![\d:])/);
  if (dm) {
    const day = Number(dm[1]);
    const month = Number(dm[2]);
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      return `${today.slice(0, 4)}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }
  return null;
}

// ---------- CSV ----------

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      rows.push(row);
      row = [];
    } else {
      cell += c;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

/** Sheets exports dates as displayed, so accept YYYY-MM-DD, D/M/YYYY and Buddhist-era years. */
function normalizeDate(raw: string): string {
  const v = raw.trim();
  let y: number, m: number, d: number;
  let match = v.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (match) {
    [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if ((match = v.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/))) {
    [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else {
    return v;
  }
  if (y > 2400) y -= 543;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function normalizeTime(raw: string): string {
  const m = raw.trim().match(/^(\d{1,2})[:.](\d{2})/);
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : raw.trim();
}

function toRows(csv: string): SheetRow[] {
  const table = parseCsv(csv);
  if (table.length === 0) return [];
  const header = table[0].map((h) => h.trim().toLowerCase());
  return table.slice(1).map((cells) => {
    const get = (name: string) => (cells[header.indexOf(name)] ?? "").trim();
    return {
      type: get("type").toLowerCase(),
      date: normalizeDate(get("date")),
      start: normalizeTime(get("start")),
      end: normalizeTime(get("end")),
      title: get("title"),
      place: get("place"),
      priority: get("priority"),
      note: get("note"),
    };
  });
}

// ---------- fetch + cache ----------

let cache: { at: number; data: SheetData } | null = null;

export class SheetUnavailableError extends Error {}

/** Cached for 60s; on fetch failure falls back to the stale cache if any. */
export async function loadSheet(): Promise<SheetData> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.data;

  try {
    const url = process.env.SHEET_CSV_URL;
    if (!url) throw new Error("SHEET_CSV_URL is not set");
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`sheet fetch status ${res.status}`);
    const text = await res.text();
    const rows = toRows(text);
    // Diagnostics only: header names + distinct `type` values (no row content).
    console.log("[sheet] parsed", {
      contentType: res.headers.get("content-type"),
      header: parseCsv(text)[0]?.map((h) => h.trim().slice(0, 30)),
      totalRows: rows.length,
      types: Array.from(new Set(rows.map((r) => r.type))).slice(0, 10),
    });
    const data: SheetData = {
      events: rows.filter((r) => r.type === "event"),
      faqs: rows.filter((r) => r.type === "faq"),
    };
    cache = { at: now, data };
    return data;
  } catch (err) {
    console.error("[sheet] fetch failed:", err instanceof Error ? err.message : "unknown");
    if (cache) {
      console.warn("[sheet] using stale cache");
      return cache.data;
    }
    throw new SheetUnavailableError("sheet unavailable and no cache");
  }
}

// ---------- helpers ----------

function toMinutes(t: string): number | null {
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function byStart(a: SheetRow, b: SheetRow): number {
  return (toMinutes(a.start) ?? 0) - (toMinutes(b.start) ?? 0);
}

export async function getEventsForDate(date: string): Promise<SheetRow[]> {
  const { events } = await loadSheet();
  return events.filter((e) => e.date === date).sort(byStart);
}

function label(e: SheetRow): string {
  return `${e.start} ${e.title}${e.priority ? ` (ความสำคัญ${e.priority})` : ""}`;
}

/** Overlap detection done in code so the model never computes it. */
export function findConflicts(events: SheetRow[]): string[] {
  const timed = events
    .map((e) => {
      const s = toMinutes(e.start);
      if (s === null) return null;
      const end = toMinutes(e.end);
      return { e, s, end: end !== null && end > s ? end : s + 1 };
    })
    .filter((x): x is { e: SheetRow; s: number; end: number } => x !== null);

  const out: string[] = [];
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length; j++) {
      const a = timed[i];
      const b = timed[j];
      if (a.e.date === b.e.date && a.s < b.end && b.s < a.end) {
        const [first, second] = a.s <= b.s ? [a, b] : [b, a];
        out.push(`${label(first.e)} ชนกับ ${label(second.e)}`);
      }
    }
  }
  return out;
}

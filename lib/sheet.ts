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
  who: string;
  /** Weekdays (0=Sun..6=Sat) for recurring rows like "วัน จ - ศ"; empty for dated rows. */
  days: number[];
  /** Day of month (1-31) for monthly rows like "23 ของทุกเดือน"; 0 if not monthly. */
  monthDay: number;
  /** Sheet "Type" column: a free-form category such as All / Wedding ("faq" marks FAQ rows). */
  category: string;
  status: string;
};

export type SheetData = {
  events: SheetRow[];
  routines: SheetRow[];
  /** Rows with no date/weekday pattern, e.g. "Found Venue" (to-dos). */
  tasks: SheetRow[];
  faqs: SheetRow[];
};

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

const WEEKDAYS_TH = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];

/** Weekday name for a YYYY-MM-DD date, computed in code so the model never guesses it. */
export function weekdayTh(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return `วัน${WEEKDAYS_TH[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}`;
}

export function weekdayIndex(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** e.g. "2026-11-22 14:05 (วันอาทิตย์)" in Asia/Bangkok */
export function nowBangkokString(now: Date = new Date()): string {
  const p = bangkokParts(now);
  const date = `${p.year}-${p.month}-${p.day}`;
  return `${date} ${p.hour}:${p.minute} (${weekdayTh(date)})`;
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
  if (question.includes("เมื่อวานซืน")) return addDays(today, -2);
  if (question.includes("เมื่อวาน")) return addDays(today, -1);
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
  const m = raw.trim().match(/^(\d{1,2})[:.](\d{2})(?::\d{2})?\s*([AaPp][Mm])?/);
  if (!m) return raw.trim();
  let h = Number(m[1]);
  if (m[3]) {
    const pm = m[3].toLowerCase() === "pm";
    if (pm && h < 12) h += 12;
    if (!pm && h === 12) h = 0;
  }
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

/** "18:00", "18:00-19:30", "18:00 – 19:30", "18:00 ถึง 19:30" -> { start, end } */
function splitTime(raw: string, endRaw: string): { start: string; end: string } {
  const range = raw.split(/\s*(?:-|–|—|ถึง|to)\s*/i);
  if (range.length >= 2 && range[1]) {
    return { start: normalizeTime(range[0]), end: normalizeTime(range[1]) };
  }
  return { start: normalizeTime(raw), end: normalizeTime(endRaw) };
}

// Accepts the original English headers plus the sheet's actual ones (Time/Date/Activity/Location/With/Priority).
const ALIASES: Record<Exclude<keyof SheetRow, "days" | "monthDay" | "category">, string[]> = {
  type: ["type", "ประเภท"],
  date: ["date", "วันที่", "วัน"],
  start: ["start", "time", "เวลา", "เวลาเริ่ม"],
  end: ["end", "เวลาสิ้นสุด", "เวลาจบ"],
  title: ["title", "activity", "กิจกรรม", "เรื่อง"],
  place: ["place", "location", "สถานที่"],
  priority: ["priority", "ความสำคัญ"],
  note: ["note", "notes", "หมายเหตุ"],
  who: ["with", "กับ", "ไปกับ"],
  status: ["status", "สถานะ"],
};

const DAY_INDEX: Record<string, number> = { อา: 0, จ: 1, อ: 2, พ: 3, พฤ: 4, ศ: 5, ส: 6 };

/** "วัน จ - ศ", "จ,พ,ศ", "เสาร์-อาทิตย์", "ทุกวัน" -> weekday numbers. Empty if not a weekday pattern. */
function parseDays(raw: string): number[] {
  let v = raw.trim().replace(/\s+/g, "");
  if (/^(ทุกวัน|everyday|daily)$/i.test(v)) return [0, 1, 2, 3, 4, 5, 6];
  v = v
    .replace(/^วัน/, "")
    .replace(/ทุก/g, "")
    .replace(/วัน/g, "")
    .replace(/จันทร์/g, "จ")
    .replace(/อังคาร/g, "อ")
    .replace(/พุธ/g, "พ")
    .replace(/พฤหัสบดี|พฤหัส/g, "พฤ")
    .replace(/ศุกร์/g, "ศ")
    .replace(/เสาร์/g, "ส")
    .replace(/อาทิตย์/g, "อา");
  if (!/^(พฤ|อา|จ|อ|พ|ศ|ส|[-–—,และถึง])+$/.test(v)) return [];
  const range = v.match(/^(พฤ|อา|จ|อ|พ|ศ|ส)[-–—ถึง](พฤ|อา|จ|อ|พ|ศ|ส)$/);
  if (range) {
    const out: number[] = [];
    let d = DAY_INDEX[range[1]];
    const end = DAY_INDEX[range[2]];
    for (let i = 0; i < 7; i++) {
      out.push(d);
      if (d === end) break;
      d = (d + 1) % 7;
    }
    return out;
  }
  const tokens = v.match(/พฤ|อา|จ|อ|พ|ศ|ส/g) ?? [];
  return Array.from(new Set(tokens.map((t) => DAY_INDEX[t])));
}

function toRows(csv: string): SheetRow[] {
  const table = parseCsv(csv);
  if (table.length === 0) return [];
  const header = table[0].map((h) => h.trim().toLowerCase());
  const col = (field: keyof typeof ALIASES) =>
    header.findIndex((h) => ALIASES[field].includes(h));
  const idx = Object.fromEntries(
    (Object.keys(ALIASES) as (keyof typeof ALIASES)[]).map((f) => [f, col(f)]),
  ) as Record<keyof typeof ALIASES, number>;

  return table.slice(1).map((cells) => {
    // A lone "-" / "–" / "—" is a placeholder for "empty".
    const get = (f: keyof typeof ALIASES) => {
      const v = idx[f] >= 0 ? (cells[idx[f]] ?? "").trim() : "";
      return /^[-–—]+$/.test(v) ? "" : v;
    };
    const { start, end } = splitTime(get("start"), get("end"));
    const rawDate = get("date");
    let date = normalizeDate(rawDate);
    let days: number[] = [];
    let monthDay = 0;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const md = rawDate.match(/(\d{1,2})\s*ของ?ทุกเดือน|ทุกเดือน(?:วันที่)?\s*(\d{1,2})|ทุกวันที่\s*(\d{1,2})/);
      const n = md ? Number(md[1] ?? md[2] ?? md[3]) : 0;
      if (n >= 1 && n <= 31) monthDay = n;
      else days = parseDays(rawDate);
      date = "";
    }
    // The sheet's "Type" column is a free-form category (All / Wedding ...); only "faq" changes the row kind.
    const category = get("type");
    const hasWhen = date !== "" || days.length > 0 || monthDay > 0;
    const type =
      category.toLowerCase() === "faq" ? "faq" : hasWhen ? "event" : get("title") ? "task" : "";
    return {
      type,
      date,
      start,
      end,
      title: get("title"),
      place: get("place"),
      // Numeric priority: 1 = highest.
      priority: ({ "1": "สูง", "2": "กลาง", "3": "ต่ำ" } as Record<string, string>)[get("priority")] ?? get("priority"),
      note: get("note"),
      who: get("who"),
      days,
      monthDay,
      category: category.toLowerCase() === "faq" ? "" : category,
      status: get("status"),
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
      events: rows.filter((r) => r.type === "event" && r.days.length === 0 && r.monthDay === 0),
      routines: rows.filter((r) => r.type === "event" && (r.days.length > 0 || r.monthDay > 0)),
      tasks: rows.filter((r) => r.type === "task"),
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

/** Next date (YYYY-MM-DD, on or after `today`) whose day-of-month equals `day`. */
export function nextMonthlyOccurrence(day: number, today: string): string {
  const [y, m] = today.split("-").map(Number);
  for (let i = 0; i < 14; i++) {
    const cand = new Date(Date.UTC(y, m - 1 + i, day));
    if (cand.getUTCDate() !== day) continue; // month too short
    const iso = cand.toISOString().slice(0, 10);
    if (iso >= today) return iso;
  }
  return today;
}

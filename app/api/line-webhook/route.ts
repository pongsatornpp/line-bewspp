import { NextResponse } from "next/server";
import { messagingApi, validateSignature, webhook } from "@line/bot-sdk";
import { askYuta, NO_INFO_REPLY, parseReminderRequest } from "@/lib/gemini";
import { addReminder, describeWhen, remindersEnabled, resolveReminder } from "@/lib/reminders";
import {
  loadSheet,
  nowBangkokString,
  resolveQuestionDate,
  todayBangkok,
  coversDate,
  rowsForQuestionCategory,
  isUpcoming,
  SheetUnavailableError,
} from "@/lib/sheet";

export const runtime = "nodejs";
export const maxDuration = 15;

const PROFILE_TIMEOUT_MS = 1_500;

function getLineClient() {
  return new messagingApi.MessagingApiClient({
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN ?? "",
  });
}

async function getCallName(client: messagingApi.MessagingApiClient, userId?: string): Promise<string> {
  if (!userId) return "ป๊า";
  try {
    const profile = await Promise.race([
      client.getProfile(userId),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("profile timeout")), PROFILE_TIMEOUT_MS),
      ),
    ]);
    return profile.displayName.includes("เอม") ? "ม๊า" : "ป๊า";
  } catch (err) {
    console.error("[line] getProfile failed:", err instanceof Error ? err.message : "unknown");
    return "ป๊า";
  }
}

async function buildReminderReply(
  question: string,
  callName: string,
  userId: string | undefined,
  events: Awaited<ReturnType<typeof loadSheet>>["events"],
): Promise<string> {
  const cannot = `ยูตะตั้งเตือนให้ไม่ได้ในตอนนี้ฮับ${callName} ลองบอกเวลาใหม่อีกทีนะ 🐾`;
  if (!remindersEnabled() || !userId) {
    console.error("[reminder] unavailable", { redisConfigured: remindersEnabled(), hasUserId: !!userId });
    return cannot;
  }

  const parsed = await parseReminderRequest({ question, nowBangkok: nowBangkokString(), events });
  if (!parsed) return `ยูตะฟังเวลาไม่ชัดเลยอ่ะฮับ${callName} ลองบอกใหม่ เช่น "เตือน 18:30" นะ 🐾`;

  // The model sometimes drops the task text; recover "…นาที ให้กินยา" with a simple pattern.
  if (!parsed.message?.trim()) {
    const m = question.match(/(?:นาที|ชั่วโมง|\d{1,2}[:.]\d{2})\s*ให้\s*(\S.*)$/);
    if (m) parsed.message = m[1].trim();
  }

  const nowMs = Date.now();
  const resolved = resolveReminder(parsed, nowMs, events);
  if ("error" in resolved) {
    if (resolved.error === "past") return `เวลานั้นผ่านไปแล้วอ่ะฮับ${callName} ลองบอกเวลาใหม่นะ 🐾`;
    if (resolved.error === "no_event") return `ยูตะหากิจกรรมนั้นในตารางไม่เจอฮับ${callName} ลองบอกเป็นเวลาแทนนะ 🐾`;
    return `ยูตะยังจับเวลาไม่ได้อ่ะฮับ${callName} ลองบอกใหม่ เช่น "เตือน 18:30" หรือ "เตือนก่อนประชุม 15 นาที" นะ 🐾`;
  }

  try {
    await addReminder({
      id: crypto.randomUUID(),
      userId,
      callName,
      message: resolved.message,
      dueAt: resolved.dueAt,
    });
  } catch (err) {
    console.error("[reminder] save failed:", err instanceof Error ? err.message : "unknown");
    return cannot;
  }
  return `ได้เลยฮับ${callName} เดี๋ยวยูตะเตือน${describeWhen(resolved.dueAt, nowMs)} น้า 🐶`;
}

async function handleEvent(client: messagingApi.MessagingApiClient, event: webhook.Event) {
  if (event.type !== "message" || event.message.type !== "text") return;
  const question = event.message.text;
  const { replyToken } = event;
  if (!replyToken) return;

  const [callName, sheet] = await Promise.all([
    getCallName(client, event.source?.userId),
    loadSheet().catch((err) => {
      if (err instanceof SheetUnavailableError) return null;
      throw err;
    }),
  ]);

  let reply: string;
  if (/เตือน/.test(question)) {
    reply = await buildReminderReply(question, callName, event.source?.userId, sheet?.events ?? []);
  } else if (!sheet) {
    reply = `ตอนนี้ยูตะเปิดตารางไม่ได้ชั่วคราวฮับ${callName} ลองถามใหม่อีกสักครู่นะ 🐾`;
  } else {
    // Explicit date (or an event named in the question) -> that day.
    // Otherwise ("ตอนนี้มีอะไรบ้าง") -> everything from today through the next 7 days (Bangkok).
    const today = todayBangkok();
    const date =
      resolveQuestionDate(question) ??
      sheet.events.find((e) => e.title && question.includes(e.title))?.date ??
      null;
    const events = sheet.events
      .filter((e) => (date ? coversDate(e, date) : isUpcoming(e, today, 7)))
      .sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));

    console.log("[sheet] rows", {
      events: sheet.events.length,
      faqs: sheet.faqs.length,
      date: date ?? "upcoming-7d",
      matchedForDate: events.length,
    });

    const allRows = [...sheet.routines, ...sheet.tasks, ...sheet.events];
    const byCategory = rowsForQuestionCategory(question, allRows);
    // Rows the user asked about directly (a category like Food/Wedding, or a whole title): answer only about those.
    const focus =
      byCategory.length > 0
        ? byCategory
        : allRows.filter((e) => e.title.length >= 3 && question.includes(e.title));

    const result = await askYuta({
      question,
      callName,
      events: focus.length > 0 ? [] : events,
      routines: focus.length > 0 ? [] : sheet.routines,
      tasks: focus.length > 0 ? [] : sheet.tasks,
      targetDate: date ?? undefined,
      focus,
      faqs: sheet.faqs,
      nowBangkok: nowBangkokString(),
    });
    reply = "text" in result ? result.text : NO_INFO_REPLY(callName);
  }

  try {
    await client.replyMessage({ replyToken, messages: [{ type: "text", text: reply }] });
  } catch (err) {
    // Expired/invalid replyToken etc: log status only, never retry.
    const e = err as { status?: number; statusCode?: number };
    console.error("[line] reply failed, status:", e?.status ?? e?.statusCode);
  }
}

export async function POST(req: Request) {
  const body = await req.text();
  const signature = req.headers.get("x-line-signature") ?? "";
  const secret = process.env.LINE_CHANNEL_SECRET ?? "";

  if (!secret) {
    console.error("[line] LINE_CHANNEL_SECRET is not set in this deployment");
    return new NextResponse("Server not configured", { status: 401 });
  }
  if (!signature || !validateSignature(body, secret, signature)) {
    console.error("[line] signature mismatch (secretLength=%d)", secret.length);
    return new NextResponse("Invalid signature", { status: 401 });
  }

  try {
    const { events } = JSON.parse(body) as { events?: webhook.Event[] };
    const client = getLineClient();
    for (const event of events ?? []) {
      try {
        await handleEvent(client, event);
      } catch (err) {
        console.error("[line] event failed:", err instanceof Error ? err.message : "unknown");
      }
    }
  } catch (err) {
    console.error("[line] bad body:", err instanceof Error ? err.message : "unknown");
  }
  return NextResponse.json({ ok: true });
}

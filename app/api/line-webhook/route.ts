import { NextResponse } from "next/server";
import { messagingApi, validateSignature, webhook } from "@line/bot-sdk";
import { askYuta, NO_INFO_REPLY } from "@/lib/gemini";
import {
  loadSheet,
  nowBangkokString,
  resolveQuestionDate,
  todayBangkok,
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
  if (!sheet) {
    reply = `ตอนนี้ยูตะเปิดตารางไม่ได้ชั่วคราวครับ ${callName}ลองถามใหม่อีกสักครู่นะ 🐾`;
  } else {
    // Date: explicit in question -> date of an event named in the question -> today (Bangkok).
    const date =
      resolveQuestionDate(question) ??
      sheet.events.find((e) => e.title && question.includes(e.title))?.date ??
      todayBangkok();
    const events = sheet.events
      .filter((e) => e.date === date)
      .sort((a, b) => a.start.localeCompare(b.start));

    console.log("[sheet] rows", {
      events: sheet.events.length,
      faqs: sheet.faqs.length,
      date,
      matchedForDate: events.length,
    });

    const result = await askYuta({
      question,
      callName,
      events,
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

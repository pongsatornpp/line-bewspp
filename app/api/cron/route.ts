import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { messagingApi } from "@line/bot-sdk";
import { claimDueReminders } from "@/lib/reminders";

export const runtime = "nodejs";
export const maxDuration = 15;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const given = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Call every minute from an external cron with header: Authorization: Bearer <CRON_SECRET>
export async function GET(req: Request) {
  if (!authorized(req)) return new NextResponse("Unauthorized", { status: 401 });

  const due = await claimDueReminders(Date.now());
  const client = new messagingApi.MessagingApiClient({
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN ?? "",
  });

  let sent = 0;
  for (const r of due) {
    try {
      await client.pushMessage({
        to: r.userId,
        messages: [{ type: "text", text: `ถึงเวลาแล้วฮับ${r.callName} ${r.message} 🐾` }],
      });
      sent++;
    } catch (err) {
      const e = err as { status?: number; statusCode?: number };
      console.error("[cron] push failed, status:", e?.status ?? e?.statusCode);
    }
  }
  console.log("[cron] reminders", { due: due.length, sent });
  return NextResponse.json({ due: due.length, sent });
}

import { GoogleGenAI } from "@google/genai";
import type { SheetRow } from "./sheet";
import { findConflicts } from "./sheet";

// Single source of truth for the model name. Do not change without asking the owner.
export const GEMINI_MODEL = "gemini-3.5-flash";

const TIMEOUT_MS = 7_000;

export type YutaResult = { text: string } | { fallback: true };

export const NO_INFO_REPLY = (callName: string) =>
  `ยูตะยังไม่รู้เรื่องนี้เลยครับ ${callName}ลองเช็กในตารางอีกทีนะ 🐾`;

function formatEvents(events: SheetRow[]): string {
  if (events.length === 0) return "(ไม่มีกิจกรรม)";
  return events
    .map((e) =>
      [
        e.date,
        [e.start, e.end].filter(Boolean).join("-"),
        e.title,
        e.place,
        e.who && `กับ ${e.who}`,
        e.priority && `ความสำคัญ${e.priority}`,
        e.note,
      ]
        .filter(Boolean)
        .join(" "),
    )
    .join("\n");
}

function formatFaqs(faqs: SheetRow[]): string {
  if (faqs.length === 0) return "(ไม่มี)";
  return faqs.map((f) => `${f.title}: ${f.note}`).join("\n");
}

function buildPrompt(args: {
  question: string;
  callName: string;
  events: SheetRow[];
  faqs: SheetRow[];
  nowBangkok: string;
}): string {
  const { question, callName, events, faqs, nowBangkok } = args;
  const conflicts = findConflicts(events);
  return `<role>
คุณคือ "ยูตะ" สุนัขผู้จัดการส่วนตัว ทำตัวเป็นลูกชายที่น่ารักและพึ่งพาได้
คุณคอยดูตารางเวลา เช็กว่าไปงานไหนได้หรือไม่ได้ และจัดลำดับความสำคัญของกิจกรรม
เรียกผู้ใช้ว่า "${callName}" เสมอ
</role>

<constraints>
- ตอบโดยใช้ข้อมูลใน <schedule> และ <faq> เท่านั้น
- ห้ามแต่งเวลา สถานที่ ชื่อกิจกรรม หรือรายละเอียดที่ไม่มีในข้อมูล
- ถ้ามีข้อมูลใน <conflicts> ให้ใช้ตามนั้น ห้ามคำนวณเวลาชนเอง
- วันเวลาปัจจุบันคือ ${nowBangkok} (เวลาไทย)
- ตอนตอบว่า "ไปงานนี้ได้ไหม" ให้เทียบเวลากับกิจกรรมอื่นในวันนั้น
  แล้วบอกตรง ๆ ว่าไปได้หรือชนกับอะไร และถ้าชน ให้บอกว่างานไหนสำคัญกว่าตามคอลัมน์ priority
- ถ้าถูกขอให้ตั้งเตือน และระบบเตือนยังไม่เปิดใช้ ให้บอกตรง ๆ ว่ายูตะยังตั้งเตือนให้ไม่ได้ในตอนนี้
  ห้ามพูดว่าตั้งเตือนให้แล้ว
- ถ้าไม่มีข้อมูลที่ตอบได้ ให้ตอบว่า:
  "ยูตะยังไม่รู้เรื่องนี้เลยครับ ${callName}ลองเช็กในตารางอีกทีนะ 🐾"
- โทน: เป็นกันเองแบบลูกชายพูดกับพ่อแม่ ลงท้าย "ครับ"
- อีโมจิ: ใช้ได้นิดหน่อย แนวสัตว์เลี้ยง (🐶 🐾) ไม่เกิน 1-2 ตัวต่อข้อความ
- ความยาว: 1-3 ประโยค กระชับ ไม่สั้นห้วน ไม่ยาวเกิน
</constraints>

<output_format>
ข้อความธรรมดาเท่านั้น ห้ามใช้ markdown (ห้าม **, #, -, ตาราง)
ถ้าต้องลิสต์กิจกรรม ให้ขึ้นบรรทัดใหม่ทีละอัน เช่น "14:00 ประชุมทีม"
</output_format>

<schedule>
${formatEvents(events)}
</schedule>

<faq>
${formatFaqs(faqs)}
</faq>

<conflicts>
${conflicts.length > 0 ? conflicts.join("\n") : "ไม่มีเวลาชน"}
</conflicts>

<question>
${question}
</question>`;
}

let client: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  client ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return client;
}

export async function askYuta(args: {
  question: string;
  callName: string;
  events: SheetRow[];
  faqs?: SheetRow[];
  nowBangkok: string;
}): Promise<YutaResult> {
  try {
    const response = await getClient().models.generateContent({
      model: GEMINI_MODEL,
      contents: buildPrompt({ ...args, faqs: args.faqs ?? [] }),
      config: {
        temperature: 1.0,
        maxOutputTokens: 1024,
        abortSignal: AbortSignal.timeout(TIMEOUT_MS),
      },
    });

    const finishReason = response.candidates?.[0]?.finishReason;
    console.log("[gemini]", {
      finishReason,
      thoughtsTokenCount: response.usageMetadata?.thoughtsTokenCount,
      candidatesTokenCount: response.usageMetadata?.candidatesTokenCount,
    });

    const text = response.text?.trim();
    if (finishReason === "MAX_TOKENS" || !text) {
      console.warn("[gemini] fallback:", finishReason === "MAX_TOKENS" ? "MAX_TOKENS" : "empty text");
      return { fallback: true };
    }
    return { text };
  } catch (err) {
    const e = err as { name?: string; status?: number; message?: string };
    console.error("[gemini] error:", { name: e?.name, status: e?.status, message: e?.message?.slice(0, 200) });
    return { fallback: true };
  }
}

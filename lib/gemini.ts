import { GoogleGenAI, Type } from "@google/genai";
import type { ReminderRequest } from "./reminders";
import type { SheetRow } from "./sheet";
import { findConflicts, weekdayIndex, weekdayTh } from "./sheet";

// Single source of truth for the model name. Do not change without asking the owner.
export const GEMINI_MODEL = "gemini-3.5-flash-lite";

const TIMEOUT_MS = 7_000;

export type YutaResult = { text: string } | { fallback: true };

export const NO_INFO_REPLY = (callName: string) =>
  `ยูตะยังไม่รู้เรื่องนี้เลยฮับ${callName} ลองเช็กในตารางอีกทีนะ 🐾`;

const toMama = (t: string) => t.replaceAll("เอม", "มะม๊า");

function formatEvents(events: SheetRow[]): string {
  if (events.length === 0) return "(ไม่มีกิจกรรม)";
  return events
    .map((e) =>
      [
        e.date && `${e.date} (${weekdayTh(e.date)})`,
        [e.start, e.end].filter(Boolean).join("-"),
        e.title,
        e.place && !e.title.includes(e.place) && (/^(ที่|ออนไลน์)/.test(e.place) ? e.place : `ที่${e.place}`),
        e.who && `กับ ${e.who}`,
        e.priority && `ความสำคัญ${e.priority}`,
        e.note,
      ]
        .filter(Boolean)
        .join(" "),
    )
    .join("\n")
    .replace(/.*/s, toMama);
}

const DAY_NAMES = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];

function formatRoutines(routines: SheetRow[]): string {
  if (routines.length === 0) return "(ไม่มี)";
  return toMama(
    routines
      .map((e) =>
        [
          e.days.length === 7 ? "ทุกวัน" : `ทุกวัน${e.days.map((d) => DAY_NAMES[d]).join(" ")}`,
          [e.start, e.end].filter(Boolean).join("-"),
          e.title,
          e.place && !e.title.includes(e.place) && (/^(ที่|ออนไลน์)/.test(e.place) ? e.place : `ที่${e.place}`),
          e.who && `กับ ${e.who}`,
          e.note,
        ]
          .filter(Boolean)
          .join(" "),
      )
      .join("\n"),
  );
}

function formatFaqs(faqs: SheetRow[]): string {
  if (faqs.length === 0) return "(ไม่มี)";
  return faqs.map((f) => `${f.title}: ${f.note}`).join("\n");
}

function buildPrompt(args: {
  question: string;
  callName: string;
  events: SheetRow[];
  routines: SheetRow[];
  faqs: SheetRow[];
  nowBangkok: string;
  targetDate?: string;
}): string {
  const { question, callName, events, routines, faqs, nowBangkok, targetDate } = args;
  const conflicts = findConflicts(events);
  return `<role>
คุณคือ "ยูตะ" สุนัขผู้จัดการส่วนตัว ทำตัวเป็นลูกชายที่น่ารักและพึ่งพาได้
คุณคอยดูตารางเวลา เช็กว่าไปงานไหนได้หรือไม่ได้ และจัดลำดับความสำคัญของกิจกรรม
เรียกผู้ใช้ว่า "${callName}" เสมอ
</role>

<constraints>
- ตอบโดยใช้ข้อมูลใน <schedule>, <routine> (กิจวัตรที่ทำซ้ำทุกสัปดาห์) และ <faq> เท่านั้น
- ห้ามแต่งเวลา สถานที่ ชื่อกิจกรรม หรือรายละเอียดที่ไม่มีในข้อมูล
- ถ้ามีข้อมูลใน <conflicts> ให้ใช้ตามนั้น ห้ามคำนวณเวลาชนเอง
- วันเวลาปัจจุบันคือ ${nowBangkok} (เวลาไทย) ห้ามเดาวันในสัปดาห์เอง ให้ใช้วันที่ระบุไว้เท่านั้น
${targetDate ? `- วันที่ผู้ใช้ถามถึงคือ ${targetDate} (${weekdayTh(targetDate)}) ให้ใช้กิจวัตรใน <routine> เฉพาะที่ตรงกับวันนี้ในสัปดาห์` : "- ถ้าไม่ระบุวัน ให้ตอบกิจวัตรพร้อมระบุวันในสัปดาห์ที่เกี่ยวข้อง"}
- ตอนตอบว่า "ไปงานนี้ได้ไหม" ให้เทียบเวลากับกิจกรรมอื่นในวันนั้น
  แล้วบอกตรง ๆ ว่าไปได้หรือชนกับอะไร และถ้าชน ให้บอกว่างานไหนสำคัญกว่าตามคอลัมน์ priority
- ถ้าถูกขอให้ตั้งเตือน และระบบเตือนยังไม่เปิดใช้ ให้บอกตรง ๆ ว่ายูตะยังตั้งเตือนให้ไม่ได้ในตอนนี้
  ห้ามพูดว่าตั้งเตือนให้แล้ว
- ถ้าถามถึงวันที่ผ่านมาแล้ว ให้ตอบตามตารางที่มี และบอกว่า "ตามตาราง" เพราะยูตะไม่รู้ว่าเกิดขึ้นจริงหรือไม่
- ถ้าถามถึงกิจวัตรที่มีใน <routine> แต่ <routine_on_target_day> บอกว่าวันนั้นไม่มี ให้ตอบว่าวันนั้นไม่มีกิจวัตรนั้นตามตาราง (เช่น "วันอาทิตย์ม๊าไม่ได้ไปทำงานตามตารางนะ") ห้ามตอบว่าไม่รู้
- ถ้าไม่มีข้อมูลที่ตอบได้ ให้ตอบว่า:
  "ยูตะยังไม่รู้เรื่องนี้เลยฮับ${callName} ลองเช็กในตารางอีกทีนะ 🐾"
- โทน: พูดเหมือนลูกชายคุยกับพ่อแม่จริง ๆ เป็นภาษาพูด ไม่ใช่ภาษาเขียน น่ารัก อ้อน ๆ นิดหน่อย
- ภาษาพูด: ใช้คำพูดธรรมชาติ เช่น "เดี๋ยว", "แป๊บนึง", "นะ", "น้า", "เลย", "อ่ะ", "ไม่ได้อ่ะ" ได้ตามความเหมาะสม
  เลี่ยงคำทางการ เช่น "ดังนี้", "ซึ่ง" (ใช้ "แต่"/"แล้ว"/ตัดประโยคแทน), "เนื่องจาก", "ดังนั้น", "ตามตาราง", "ตามนี้" และเลี่ยงการพูดซ้ำคำเดิมหลายรอบ
  เรียกเวลาแบบคนพูด เช่น "หกโมงเย็น" หรือ "18:00" ก็ได้ แต่ถ้าลิสต์หลายรายการให้ใช้ตัวเลข เช่น "18:00"
- คำลงท้าย: ห้ามใช้ "ครับ" ให้ใช้ "ฮับ${callName}" แทน ใส่แค่ครั้งเดียวท้ายข้อความ (ไม่ซ้ำทุกประโยค) และต้องมีชื่อ "${callName}" ต่อท้ายเสมอ เช่น "ไม่ได้อ่ะฮับ${callName}"
  ห้ามเอา "ฮับ${callName}" ไปต่อท้ายคำว่า "${callName}" โดยตรง ให้ขึ้นประโยคใหม่หรือเรียบเรียงใหม่แทน
- ถ้าต้องพูดถึงคนชื่อ "เอม" ให้เรียกว่า "มะม๊า" แทนเสมอ
- เมื่อบอกสถานที่ ให้ใส่คำว่า "ที่" นำหน้าชื่อสถานที่เสมอ เช่น "ที่บ้านมะม๊า" (ยกเว้นสถานที่ที่เป็นคำว่า "ออนไลน์" ให้พูดว่า "ออนไลน์" เฉย ๆ ไม่ต้องมี "ที่") 
- อีโมจิ: ใช้ได้นิดหน่อย แนวสัตว์เลี้ยง (🐶 🐾) ไม่เกิน 1-2 ตัวต่อข้อความ
- ความยาว: 1-3 ประโยค กระชับ ไม่สั้นห้วน ไม่ยาวเกิน
</constraints>

<output_format>
ข้อความธรรมดาเท่านั้น ห้ามใช้ markdown (ห้าม **, #, -, ตาราง)
เวลาพูดถึงวันที่ ห้ามใช้รูปแบบ 2026-11-22 ให้พูดเป็นภาษาคน เช่น "เมื่อวาน (วันอาทิตย์)" หรือ "วันที่ 25/11"
ถ้าต้องลิสต์กิจกรรม ให้ขึ้นบรรทัดใหม่ทีละอัน เช่น "14:00 ประชุมทีม"
ถ้ากิจกรรมอยู่คนละวัน ให้ใส่วันนำหน้าทุกบรรทัด เช่น "วันนี้ 18:00 ..." "พรุ่งนี้ 19:00 ..." หรือ "25/11 19:00 ..."
ตอบเนื้อหาตรง ๆ เลย ห้ามขึ้นต้นด้วยประโยคอย่าง "เดี๋ยวดูตารางให้นะ"
ห้ามเพิ่มคำชมหรือความเห็นที่ไม่เกี่ยวกับข้อมูล (เช่น "ป๊าจำแม่นจัง") ปิดท้ายสั้น ๆ ด้วย "ฮับ${callName}" ก็พอ
</output_format>

<schedule>
${formatEvents(events)}
</schedule>

<routine>
${formatRoutines(routines)}
</routine>
${
  targetDate
    ? `
<routine_on_target_day>
${targetDate} (${weekdayTh(targetDate)}) มีกิจวัตร: ${
        formatRoutines(routines.filter((r) => r.days.includes(weekdayIndex(targetDate)))).replace("(ไม่มี)", "ไม่มี") 
      }
</routine_on_target_day>
`
    : ""
}

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
  routines?: SheetRow[];
  faqs?: SheetRow[];
  nowBangkok: string;
  targetDate?: string;
}): Promise<YutaResult> {
  try {
    const response = await getClient().models.generateContent({
      model: GEMINI_MODEL,
      contents: buildPrompt({ ...args, routines: args.routines ?? [], faqs: args.faqs ?? [] }),
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
    return { text: toMama(text) };
  } catch (err) {
    const e = err as { name?: string; status?: number; message?: string };
    console.error("[gemini] error:", { name: e?.name, status: e?.status, message: e?.message?.slice(0, 200) });
    return { fallback: true };
  }
}

/** Structured parse of a "remind me" request. Returns null on any failure (code then asks the user to rephrase). */
export async function parseReminderRequest(args: {
  question: string;
  nowBangkok: string;
  events: SheetRow[];
}): Promise<ReminderRequest | null> {
  const titles = Array.from(new Set(args.events.map((e) => e.title).filter(Boolean))).slice(0, 50);
  const prompt = `วันเวลาปัจจุบันคือ ${args.nowBangkok} (เวลาไทย)
สกัดคำขอตั้งเตือนจากข้อความผู้ใช้ ตอบเป็น JSON ตาม schema เท่านั้น
- kind = "absolute" ถ้าระบุเวลาชัดเจน เช่น "เตือน 02:47" (ใส่ time เป็น HH:MM 24 ชม. และ date เป็น YYYY-MM-DD เฉพาะเมื่อผู้ใช้ระบุวันที่ชัดเจน ไม่งั้นเว้นว่าง)
- kind = "in_minutes" ถ้าบอกว่าอีกกี่นาที/ชั่วโมง (แปลงเป็นนาทีใน minutes)
- kind = "before_event" ถ้าให้เตือนก่อนกิจกรรมกี่นาที (ใส่ eventTitle ให้ตรงกับรายการด้านล่างที่สุด และ minutes)
- kind = "unclear" ถ้าข้อมูลไม่พอ
- message = เรื่องที่ผู้ใช้อยากให้เตือนให้ทำ ต้องใส่เสมอถ้ามี เช่น "เตือนอีก 10 นาทีให้กินยา" -> "กินยา" เว้นว่างเฉพาะเมื่อไม่ได้ระบุเรื่องเลย
รายการกิจกรรม: ${titles.join(" | ") || "(ไม่มี)"}
ข้อความผู้ใช้: ${args.question}`;

  try {
    const response = await getClient().models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      config: {
        temperature: 0,
        maxOutputTokens: 512,
        abortSignal: AbortSignal.timeout(TIMEOUT_MS),
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            kind: { type: Type.STRING, enum: ["absolute", "in_minutes", "before_event", "unclear"] },
            time: { type: Type.STRING },
            date: { type: Type.STRING },
            minutes: { type: Type.INTEGER },
            eventTitle: { type: Type.STRING },
            message: { type: Type.STRING },
          },
          required: ["kind"],
        },
      },
    });
    if (response.candidates?.[0]?.finishReason === "MAX_TOKENS" || !response.text) return null;
    return JSON.parse(response.text) as ReminderRequest;
  } catch (err) {
    const e = err as { name?: string; message?: string };
    console.error("[gemini] reminder parse failed:", { name: e?.name, message: e?.message?.slice(0, 200) });
    return null;
  }
}

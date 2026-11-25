import type { SheetData, SheetRow } from "./sheet";
import { addDays, isDoneStatus, todayBangkok, weekdayTh } from "./sheet";

const DAY_NAMES = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];
const PARTNER_WORDS = /ม๊า|มะม๊า|เอม/;

/** "นัดสำคัญ": rows that have a priority and aren't done/past, ordered by priority 1 -> 3. Built in code, not by the model. */
export function importantRows(sheet: SheetData, question: string, today = todayBangkok()): SheetRow[] {
  let rows = [
    ...sheet.events.filter((e) => (e.endDate || e.date) >= today),
    ...sheet.routines,
    ...sheet.tasks,
  ].filter((r) => r.priorityRank < 99 && !isDoneStatus(r.status));

  if (PARTNER_WORDS.test(question)) {
    const withPartner = rows.filter((r) => PARTNER_WORDS.test(r.who));
    if (withPartner.length > 0) rows = withPartner;
  }

  return rows.sort(
    (a, b) =>
      a.priorityRank - b.priorityRank ||
      (a.date || "9999").localeCompare(b.date || "9999") ||
      a.start.localeCompare(b.start),
  );
}

function whenLabel(r: SheetRow, today: string): string {
  if (r.monthDay > 0) return `ทุกวันที่ ${r.monthDay} ของเดือน`;
  if (r.days.length > 0) return r.days.length === 7 ? "ทุกวัน" : `ทุก${r.days.map((d) => DAY_NAMES[d]).join(" ")}`;
  if (!r.date) return "ยังไม่กำหนดวัน";
  const dm = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
  if (r.endDate) return `${dm(r.date)}-${dm(r.endDate)}`;
  if (r.date === today) return "วันนี้";
  if (r.date === addDays(today, 1)) return "พรุ่งนี้";
  return `${dm(r.date)} (${weekdayTh(r.date)})`;
}

export function importantReply(rows: SheetRow[], callName: string, today = todayBangkok()): string {
  const other = callName === "ป๊า" ? "ม๊า" : "ป๊า";
  const toMama = (t: string) => t.replaceAll("เอม", "มะม๊า");
  if (rows.length === 0) return `ตอนนี้ไม่มีนัดสำคัญที่ค้างอยู่เลยฮับ${callName} 🐾`;
  const lines = rows.slice(0, 10).map((r, i) => {
    const parts = [
      `${i + 1}.`,
      whenLabel(r, today),
      r.start,
      r.title,
      r.place && `ที่${/^[A-Za-z0-9]/.test(r.place) ? " " : ""}${r.place}`,
      r.who && `กับ ${r.who}`,
      `(ความสำคัญ ${r.priorityRank})`,
    ];
    return toMama(parts.filter(Boolean).join(" "));
  });
  return `นัดสำคัญที่ยังไม่ได้ทำ เรียงจากสำคัญที่สุดฮับ${callName}\n${lines.join("\n")}\nห้ามลืมนะ สำคัญมาก ห้ามทำให้${other}เสียใจนะ ไม่งั้นยูตะจะกัด${callName}แน่ 🐶`;
}

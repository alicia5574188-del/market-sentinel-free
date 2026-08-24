import test from "node:test";
import assert from "node:assert/strict";
import { parseBlsCalendar } from "../lib/global-risk.ts";

test("BLS 官方日历只提取高影响事件并正确换算纽约时区", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "DTSTART;TZID=America/New_York:20260812T083000",
    "SUMMARY:Consumer Price Index",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "DTSTART;TZID=America/New_York:20260813T100000",
    "SUMMARY:Routine notice",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const events = parseBlsCalendar(ics);
  assert.equal(events.length, 1);
  assert.equal(events[0].title, "Consumer Price Index");
  assert.equal(events[0].time, Date.parse("2026-08-12T12:30:00Z"));
});

/**
 * Which scheduled slot is due. The OS scheduler calls `quietapply tick` every 15 minutes (and at login
 * or wake); a tick runs at most once per slot. If the computer was off or asleep through several slots,
 * only the latest one runs, once (missed slots are not replayed). That includes last evening's slot when
 * the computer is switched on the next morning before the first slot of the day.
 */
export function dueSlot(
  now: Date,
  schedule: string[],
  lastSlot: string | undefined,
  timeZone?: string,
): string | undefined {
  const today = localParts(now, timeZone);
  const yesterday = localParts(new Date(now.getTime() - 86_400_000), timeZone);
  const minutes = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const passed = [
    // Yesterday's slots only count as missed when something already ran before (not on a first tick).
    ...(lastSlot ? schedule.map((s) => `${yesterday.date}T${s}`) : []),
    ...schedule.filter((s) => minutes(s) <= today.minutes).map((s) => `${today.date}T${s}`),
  ].sort();
  const latest = passed.at(-1);
  if (!latest) return undefined;
  return !lastSlot || latest > lastSlot ? latest : undefined;
}

/** The next scheduled time after now, as "today 19:00" or "tomorrow 09:00". */
export function nextSlot(now: Date, schedule: string[], timeZone?: string): string | undefined {
  const { minutes } = localParts(now, timeZone);
  const sorted = [...schedule].sort();
  const later = sorted.find((s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5)) > minutes);
  if (later) return `today ${later}`;
  return sorted[0] ? `tomorrow ${sorted[0]}` : undefined;
}

/** A failed slot gets one retry, 15 minutes later, the same day. */
export function retryDue(
  now: Date,
  last: { slot?: string; status?: string; at?: string; retried?: string },
): string | undefined {
  if (last.status !== "failed" || !last.slot || last.retried === last.slot || !last.at) return undefined;
  if (now.getTime() - new Date(last.at).getTime() < 15 * 60_000) return undefined;
  if (last.slot.slice(0, 10) !== localParts(now).date) return undefined;
  return last.slot;
}

function localParts(d: Date, timeZone?: string): { date: string; minutes: number } {
  const tz = !timeZone || timeZone === "auto" ? undefined : timeZone;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

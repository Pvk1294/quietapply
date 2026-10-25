/**
 * Which scheduled slot is due. The OS scheduler calls `quietapply tick` every 15 minutes; a tick runs at
 * most once per slot, and if the machine slept through several slots only the latest one runs (missed
 * slots are not replayed).
 */
export function dueSlot(
  now: Date,
  schedule: string[],
  lastSlot: string | undefined,
  timeZone?: string,
): string | undefined {
  const { date, minutes } = localParts(now, timeZone);
  const passed = schedule
    .map((s) => ({ s, m: Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5)) }))
    .filter((x) => x.m <= minutes)
    .sort((a, b) => a.m - b.m);
  const latest = passed.at(-1);
  if (!latest) return undefined;
  const key = `${date}T${latest.s}`;
  return !lastSlot || key > lastSlot ? key : undefined;
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

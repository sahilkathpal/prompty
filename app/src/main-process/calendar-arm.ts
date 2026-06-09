// Block E4 — Calendar-arm scheduler (Stage 3 — adds T-0 notification + arm-changed broadcast).

import { Notification } from "electron";
import { listUpcomingEvents } from "./google-calendar";
import { qualifies, pickNextQualifying, pickUpcomingQualifying } from "./calendar-filter";
import { getSession } from "./google-auth";
import { openMainWindow } from "../../electron/main-window";

export interface CalendarEvent {
  id: string;
  title: string;
  startsAt: number; // ms epoch
  attendees?: { name?: string; email?: string }[];
}

export interface CalendarArmDeps {
  onArmed?: (event: CalendarEvent) => void;
  onUnarmed?: (event: CalendarEvent) => void;
  onNotificationClick?: (event: CalendarEvent) => void;
  /** Fired when the T-0 notification is clicked (or T-0 elapses if app is up). */
  onStartTime?: (event: CalendarEvent) => void;
}

export interface CalendarArmHandle {
  stop(): void;
  pollNow(): Promise<void>;
  getCurrentArmed(): CalendarEvent | null;
  /** Cancel the T-0 notification timer for a given event id (e.g. session already started). */
  cancelStartTimer(eventId: string): void;
}

function fakeEventFromEnv(): CalendarEvent | null {
  if (process.env.PROMPTY_E2E_FAKE_EVENT === "1") {
    return {
      id: "e2e-fake-1",
      title: "Discovery call with Alex Chen",
      startsAt: Date.now() + 5 * 60 * 1000,
      attendees: [{ name: "Alex Chen", email: "alex@external.example" }],
    };
  }
  return null;
}

export async function fetchUpcomingEvent(): Promise<CalendarEvent | null> {
  const fake = fakeEventFromEnv();
  if (fake) return fake;

  const session = getSession();
  if (!session) return null;

  let events;
  try {
    events = await listUpcomingEvents(15);
  } catch (e) {
    console.error("[calendar-arm] listUpcomingEvents failed:", (e as Error).message);
    return null;
  }

  const picked = pickNextQualifying(events, session.email);
  if (!picked) return null;

  const startsAt = picked.start?.dateTime
    ? Date.parse(picked.start.dateTime)
    : null;
  if (!startsAt) return null;

  return {
    id: picked.id,
    title: picked.summary ?? "(no title)",
    startsAt,
    attendees: (picked.attendees ?? [])
      .filter((a) => !a.self && !a.resource && a.email)
      .map((a) => ({ name: a.displayName, email: a.email })),
  };
}

function toCalendarEvent(raw: import("./google-calendar").GCalEvent): CalendarEvent | null {
  const startsAt = raw.start?.dateTime ? Date.parse(raw.start.dateTime) : null;
  if (!startsAt) return null;
  return {
    id: raw.id,
    title: raw.summary ?? "(no title)",
    startsAt,
    attendees: (raw.attendees ?? [])
      .filter((a) => !a.self && !a.resource && a.email)
      .map((a) => ({ name: a.displayName, email: a.email })),
  };
}

export async function listUpcomingQualifyingEvents(
  limit: number,
  windowMinutes: number,
): Promise<CalendarEvent[]> {
  const session = getSession();
  if (!session) return [];
  let events;
  try {
    events = await listUpcomingEvents(windowMinutes);
  } catch (e) {
    console.error("[calendar-arm] listUpcomingQualifyingEvents failed:", (e as Error).message);
    return [];
  }
  const picked = pickUpcomingQualifying(events, session.email, limit);
  return picked.map(toCalendarEvent).filter((e): e is CalendarEvent => e !== null);
}

export { qualifies };

const POLL_MS = 60_000;
const WINDOW_MS = 15 * 60_000;

export function startCalendarArm(deps: CalendarArmDeps): CalendarArmHandle {
  const armedIds = new Set<string>();
  const startTimers = new Map<string, NodeJS.Timeout>();
  let currentArmed: CalendarEvent | null = null;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const clearStartTimer = (id: string) => {
    const t = startTimers.get(id);
    if (t) clearTimeout(t);
    startTimers.delete(id);
  };

  const scheduleStartNotification = (ev: CalendarEvent) => {
    clearStartTimer(ev.id);
    const ms = Math.max(0, ev.startsAt - Date.now());
    const t = setTimeout(() => {
      if (stopped) return;
      try {
        const n = new Notification({
          title: `${ev.title} is starting`,
          body: "Click to run the call",
        });
        n.on("click", () => {
          console.log(`[calendar-arm] T-0 notification clicked: ${ev.title}`);
          deps.onStartTime?.(ev);
        });
        n.show();
      } catch (e) {
        console.error("[calendar-arm] T-0 notification failed:", (e as Error).message);
      }
    }, ms);
    startTimers.set(ev.id, t);
  };

  const setCurrentArmed = (ev: CalendarEvent | null) => {
    const changed =
      (currentArmed?.id ?? null) !== (ev?.id ?? null);
    const prev = currentArmed;
    currentArmed = ev;
    if (changed) {
      if (prev) deps.onUnarmed?.(prev);
      if (ev) deps.onArmed?.(ev);
    }
  };

  const poll = async () => {
    if (stopped) return;
    try {
      const ev = await fetchUpcomingEvent();
      if (!ev) {
        if (currentArmed && currentArmed.startsAt < Date.now() - WINDOW_MS) {
          setCurrentArmed(null);
        }
        return;
      }
      if (armedIds.has(ev.id)) {
        // Already-armed event still in window — keep current set.
        if (currentArmed?.id !== ev.id) setCurrentArmed(ev);
        return;
      }
      const ms = ev.startsAt - Date.now();
      if (ms < 0 || ms > WINDOW_MS) return;
      armedIds.add(ev.id);
      setCurrentArmed(ev);
      scheduleStartNotification(ev);
      const n = new Notification({
        title: `Ready for ${ev.title}`,
        body: `Prep for ${ev.title} — click to start`,
      });
      n.on("click", () => {
        console.log(`[calendar-arm] notification clicked: ${ev.title}`);
        try {
          openMainWindow("prep");
        } catch (e) {
          console.error("[calendar-arm] openMainWindow failed:", (e as Error).message);
        }
        deps.onNotificationClick?.(ev);
      });
      n.show();
    } catch (e) {
      console.error("[calendar-arm] poll failed:", (e as Error).message);
    }
  };

  const loop = () => {
    if (stopped) return;
    void poll();
    timer = setTimeout(loop, POLL_MS);
  };
  loop();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      for (const t of startTimers.values()) clearTimeout(t);
      startTimers.clear();
    },
    pollNow: poll,
    getCurrentArmed() {
      return currentArmed;
    },
    cancelStartTimer(eventId) {
      clearStartTimer(eventId);
    },
  };
}

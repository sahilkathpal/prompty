// Four-condition arming filter for Google Calendar events.

import type { GCalEvent, GCalAttendee } from "./google-calendar";

const VIDEO_LINK_RE =
  /https?:\/\/[^\s]*(?:zoom\.us\/j\/|meet\.google\.com\/|teams\.microsoft\.com\/|zoom|meet|teams)/i;

function hasVideoLink(event: GCalEvent): boolean {
  if (event.location && VIDEO_LINK_RE.test(event.location)) return true;
  if (event.description && VIDEO_LINK_RE.test(event.description)) return true;
  const entries = event.conferenceData?.entryPoints ?? [];
  for (const ep of entries) {
    if (ep.entryPointType === "video" && ep.uri) return true;
  }
  return false;
}

function selfAttendee(event: GCalEvent, userEmail: string): GCalAttendee | null {
  const want = userEmail.toLowerCase();
  for (const a of event.attendees ?? []) {
    if (a.self === true) return a;
    if (a.email && a.email.toLowerCase() === want) return a;
  }
  return null;
}

function acceptedOrOrganizer(event: GCalEvent, userEmail: string): boolean {
  if (event.organizer?.self === true) return true;
  const me = selfAttendee(event, userEmail);
  if (me?.responseStatus === "accepted") return true;
  // If there's no attendees list and the user is the organizer's email, treat as accepted.
  if (
    event.organizer?.email &&
    event.organizer.email.toLowerCase() === userEmail.toLowerCase()
  ) {
    return true;
  }
  return false;
}

export function qualifies(event: GCalEvent, userEmail: string): boolean {
  if (!event || !userEmail) return false;
  // Skip all-day events regardless.
  if (!event.start?.dateTime || !event.end?.dateTime) return false;
  if (!hasVideoLink(event)) return false;
  if (!acceptedOrOrganizer(event, userEmail)) return false;
  return true;
}

export function pickUpcomingQualifying(
  events: GCalEvent[],
  userEmail: string,
  limit: number,
): GCalEvent[] {
  const sorted = [...events].sort((a, b) => {
    const sa = a.start?.dateTime ? Date.parse(a.start.dateTime) : 0;
    const sb = b.start?.dateTime ? Date.parse(b.start.dateTime) : 0;
    return sa - sb;
  });
  const out: GCalEvent[] = [];
  for (const e of sorted) {
    if (qualifies(e, userEmail)) out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}

export function pickNextQualifying(
  events: GCalEvent[],
  userEmail: string,
): GCalEvent | null {
  // events come back orderBy=startTime ascending — but be defensive.
  const sorted = [...events].sort((a, b) => {
    const sa = a.start?.dateTime ? Date.parse(a.start.dateTime) : 0;
    const sb = b.start?.dateTime ? Date.parse(b.start.dateTime) : 0;
    return sa - sb;
  });
  for (const e of sorted) {
    if (qualifies(e, userEmail)) return e;
  }
  return null;
}

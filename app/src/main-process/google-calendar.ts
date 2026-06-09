// Google Calendar v3 fetch — primary calendar, time-bounded.

import { getAccessToken, forceRefreshAccessToken } from "./google-auth";

export interface GCalDateTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

export interface GCalAttendee {
  email?: string;
  displayName?: string;
  self?: boolean;
  resource?: boolean;
  responseStatus?: "needsAction" | "declined" | "tentative" | "accepted";
  organizer?: boolean;
}

export interface GCalConferenceEntryPoint {
  entryPointType?: string;
  uri?: string;
}

export interface GCalConferenceData {
  entryPoints?: GCalConferenceEntryPoint[];
}

export interface GCalEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: GCalDateTime;
  end?: GCalDateTime;
  attendees?: GCalAttendee[];
  organizer?: { email?: string; self?: boolean };
  status?: string;
  conferenceData?: GCalConferenceData;
}

interface ListResponse {
  items?: GCalEvent[];
}

const BASE = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

async function call(token: string, timeMin: string, timeMax: string): Promise<Response> {
  const url = new URL(BASE);
  url.searchParams.set("timeMin", timeMin);
  url.searchParams.set("timeMax", timeMax);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("maxResults", "20");
  return fetch(url.toString(), {
    headers: { authorization: `Bearer ${token}` },
  });
}

export async function listUpcomingEvents(windowMinutes: number): Promise<GCalEvent[]> {
  const now = new Date();
  const later = new Date(now.getTime() + windowMinutes * 60 * 1000);
  const timeMin = now.toISOString();
  const timeMax = later.toISOString();

  let token = await getAccessToken();
  let resp = await call(token, timeMin, timeMax);
  if (resp.status === 401) {
    token = await forceRefreshAccessToken();
    resp = await call(token, timeMin, timeMax);
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Google Calendar list failed ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = (await resp.json()) as ListResponse;
  return data.items ?? [];
}

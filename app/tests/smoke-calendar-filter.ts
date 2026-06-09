// Table-driven test of calendar-filter.qualifies().
//
// Two-condition filter: video link present + accepted/organizer.
// All-day events are excluded.

import { qualifies, pickNextQualifying, pickUpcomingQualifying } from "../src/main-process/calendar-filter";
import type { GCalEvent } from "../src/main-process/google-calendar";

const USER_EMAIL = "alice@acme.com";

function evt(overrides: Partial<GCalEvent>): GCalEvent {
  const baseStart = "2030-01-01T10:00:00Z";
  const baseEnd = "2030-01-01T10:30:00Z";
  return {
    id: "x",
    summary: "Test event",
    start: { dateTime: baseStart },
    end: { dateTime: baseEnd },
    attendees: [
      { email: USER_EMAIL, self: true, responseStatus: "accepted" },
      { email: "bob@external.io", responseStatus: "accepted" },
    ],
    organizer: { email: USER_EMAIL, self: true },
    location: "https://zoom.us/j/12345",
    ...overrides,
  };
}

interface Case {
  name: string;
  event: GCalEvent;
  expect: boolean;
}

const cases: Case[] = [
  {
    name: "happy path: zoom in location, accepted",
    event: evt({}),
    expect: true,
  },
  {
    name: "video link in description (Meet)",
    event: evt({
      location: undefined,
      description: "Join: https://meet.google.com/abc-defg-hij",
    }),
    expect: true,
  },
  {
    name: "video link in conferenceData.entryPoints (Teams)",
    event: evt({
      location: undefined,
      description: undefined,
      conferenceData: {
        entryPoints: [
          { entryPointType: "video", uri: "https://teams.microsoft.com/meetup-join/xyz" },
        ],
      },
    }),
    expect: true,
  },
  {
    name: "no video link anywhere → fail",
    event: evt({
      location: "Conference room A",
      description: "Quarterly sync",
      conferenceData: undefined,
    }),
    expect: false,
  },
  {
    name: "all-internal attendees still passes (no external requirement)",
    event: evt({
      attendees: [
        { email: USER_EMAIL, self: true, responseStatus: "accepted" },
        { email: "ceo@acme.com", responseStatus: "accepted" },
      ],
    }),
    expect: true,
  },
  {
    name: "solo event still passes (no attendee requirement)",
    event: evt({
      attendees: [{ email: USER_EMAIL, self: true, responseStatus: "accepted" }],
    }),
    expect: true,
  },
  {
    name: "self declined → fail",
    event: evt({
      organizer: { email: "bob@external.io", self: false },
      attendees: [
        { email: USER_EMAIL, self: true, responseStatus: "declined" },
        { email: "bob@external.io", responseStatus: "accepted" },
      ],
    }),
    expect: false,
  },
  {
    name: "self needsAction → fail",
    event: evt({
      organizer: { email: "bob@external.io", self: false },
      attendees: [
        { email: USER_EMAIL, self: true, responseStatus: "needsAction" },
        { email: "bob@external.io", responseStatus: "accepted" },
      ],
    }),
    expect: false,
  },
  {
    name: "self accepted but not organizer → pass",
    event: evt({
      organizer: { email: "bob@external.io", self: false },
      attendees: [
        { email: USER_EMAIL, self: true, responseStatus: "accepted" },
        { email: "bob@external.io", responseStatus: "accepted" },
      ],
    }),
    expect: true,
  },
  {
    name: "organizer self, no responseStatus on self → pass",
    event: evt({
      organizer: { email: USER_EMAIL, self: true },
      attendees: [
        { email: USER_EMAIL, self: true },
        { email: "bob@external.io", responseStatus: "accepted" },
      ],
    }),
    expect: true,
  },
  {
    name: "all-day event (start.date) → fail",
    event: evt({
      start: { date: "2030-01-01" },
      end: { date: "2030-01-02" },
    }),
    expect: false,
  },
  {
    name: "14-minute meeting → pass (no duration requirement)",
    event: evt({
      start: { dateTime: "2030-01-01T10:00:00Z" },
      end: { dateTime: "2030-01-01T10:14:00Z" },
    }),
    expect: true,
  },
  {
    name: "5-minute meeting still passes (no duration requirement)",
    event: evt({
      start: { dateTime: "2030-01-01T10:00:00Z" },
      end: { dateTime: "2030-01-01T10:05:00Z" },
    }),
    expect: true,
  },
  {
    name: "multi-day event with dateTime fields → pass",
    event: evt({
      start: { dateTime: "2030-01-01T10:00:00Z" },
      end: { dateTime: "2030-01-02T10:00:00Z" },
    }),
    expect: true,
  },
];

function check(c: Case): void {
  const got = qualifies(c.event, USER_EMAIL);
  if (got !== c.expect) {
    throw new Error(`expected ${c.expect}, got ${got}`);
  }
}

let failed = 0;
for (const c of cases) {
  try {
    check(c);
    console.log(`  PASS  ${c.name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL  ${c.name} — ${(e as Error).message}`);
  }
}

// pickNextQualifying: picks earliest qualifying (skips no-video-link).
try {
  const e1 = evt({ id: "early-bad", location: "Conference room A", description: "no link", conferenceData: undefined });
  const e2 = evt({
    id: "late-good",
    start: { dateTime: "2030-01-01T11:00:00Z" },
    end: { dateTime: "2030-01-01T11:30:00Z" },
  });
  const e3 = evt({
    id: "later-good",
    start: { dateTime: "2030-01-01T12:00:00Z" },
    end: { dateTime: "2030-01-01T12:30:00Z" },
  });
  const picked = pickNextQualifying([e1, e2, e3], USER_EMAIL);
  if (picked?.id !== "late-good") {
    throw new Error(`expected late-good, got ${picked?.id}`);
  }
  console.log("  PASS  pickNextQualifying picks earliest qualifying");
} catch (e) {
  failed++;
  console.error(`  FAIL  pickNextQualifying — ${(e as Error).message}`);
}

// pickUpcomingQualifying: returns up to N qualifying in order.
try {
  const bad = evt({ id: "bad", location: "Conference room A", description: "no link", conferenceData: undefined });
  const a = evt({ id: "a", start: { dateTime: "2030-01-01T11:00:00Z" }, end: { dateTime: "2030-01-01T11:30:00Z" } });
  const b = evt({ id: "b", start: { dateTime: "2030-01-01T12:00:00Z" }, end: { dateTime: "2030-01-01T12:30:00Z" } });
  const c = evt({ id: "c", start: { dateTime: "2030-01-01T13:00:00Z" }, end: { dateTime: "2030-01-01T13:30:00Z" } });
  const list = pickUpcomingQualifying([bad, a, b, c], USER_EMAIL, 2);
  if (list.length !== 2 || list[0].id !== "a" || list[1].id !== "b") {
    throw new Error(`got ${list.map((e) => e.id).join(",")}`);
  }
  console.log("  PASS  pickUpcomingQualifying respects limit and order");
} catch (e) {
  failed++;
  console.error(`  FAIL  pickUpcomingQualifying — ${(e as Error).message}`);
}

if (failed > 0) {
  console.error(`\n${failed} case(s) failed`);
  process.exit(1);
}
console.log("\nall calendar-filter cases passed");

import { describe, expect, it } from "vitest";
import { chileDateOf, chileDateStart } from "../chile-time.js";
import type { Publication } from "../publication.js";
import { calendarEntries } from "./calendar.js";

// F9-T18: el calendario del panel, puro (lo programado y lo publicado de avisos y posts).

// 2026-10-15 12:00 en Chile.
const NOW = new Date("2026-10-15T15:00:00.000Z");
const hours = (n: number) => new Date(NOW.getTime() + n * 60 * 60_000);

let next = 0;
function publication(extra: Partial<Publication> = {}): Publication {
  next += 1;
  return {
    id: `pub-${String(next).padStart(3, "0")}`,
    listingId: "l1",
    platformAccountId: "acc",
    platform: "instagram",
    format: "post",
    language: "es",
    contentId: "c",
    mediaIds: [],
    status: "approved",
    scheduledAt: null,
    publishedAt: null,
    externalId: null,
    externalUrl: null,
    attempts: 0,
    lastError: null,
    dryRun: true,
    progress: null,
    remoteState: null,
    listingSourceHash: "h",
    relistedFrom: null,
    costUsd: null,
    createdAt: hours(-48),
    updatedAt: hours(-1),
    ...extra,
    subject: { kind: "listing", id: extra.listingId ?? "l1" },
  };
}

function postPublication(postId: string, extra: Partial<Publication> = {}): Publication {
  return {
    ...publication({ listingSourceHash: null, ...extra }),
    listingId: null,
    subject: { kind: "post", id: postId },
  };
}

const listings = [
  { id: "l1", brokerId: "b1", externalRef: "P-001" },
  { id: "l2", brokerId: "b2", externalRef: "P-002" },
];
const posts = [{ id: "post-1", brokerId: "b1", topic: "Bastidores" }];

const run = (publications: Publication[], from = hours(-24), to = hours(24 * 7)) =>
  calendarEntries({ listings, posts, publications, from, to, now: NOW });

describe("calendarEntries", () => {
  it("pone las programadas por su hora y las publicadas por la de salida, avisos y posts juntos", () => {
    const entries = run([
      publication({ status: "scheduled", scheduledAt: hours(5) }),
      postPublication("post-1", {
        platform: "linkedin",
        status: "scheduled",
        scheduledAt: hours(2),
        dryRun: false,
      }),
      publication({
        status: "published",
        publishedAt: hours(-3),
        externalUrl: "https://www.instagram.com/p/x",
      }),
    ]);

    expect(entries.map((e) => [e.kind, e.title, e.platform, e.at.toISOString()])).toEqual([
      ["published", "P-001", "instagram", hours(-3).toISOString()],
      ["scheduled", "Bastidores", "linkedin", hours(2).toISOString()],
      ["scheduled", "P-001", "instagram", hours(5).toISOString()],
    ]);
    const [published, linkedin, instagram] = entries;
    expect(published?.externalUrl).toBe("https://www.instagram.com/p/x");
    expect(published?.schedule).toBeNull();
    expect(linkedin).toMatchObject({ postId: "post-1", listingId: null, brokerId: "b1" });
    expect(linkedin?.dryRun).toBe(false);
    expect(instagram).toMatchObject({ listingId: "l1", postId: null, schedule: "upcoming" });
  });

  it("deja fuera lo que no está programado ni publicado, y lo que cae fuera del rango [from, to)", () => {
    const from = hours(0);
    const to = hours(10);
    const entries = run(
      [
        publication({ status: "approved" }),
        publication({ status: "failed", updatedAt: hours(1) }),
        publication({ status: "publishing" }),
        publication({ status: "scheduled", scheduledAt: from }),
        publication({ status: "scheduled", scheduledAt: to }),
        publication({ status: "published", publishedAt: hours(-1) }),
      ],
      from,
      to,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.at).toEqual(from);
  });

  it("solo muestra lo de los avisos y posts recibidos (el alcance de la sesión)", () => {
    const entries = calendarEntries({
      listings: [listings[0] ?? { id: "", brokerId: "", externalRef: "" }],
      posts: [],
      publications: [
        publication({ status: "scheduled", scheduledAt: hours(1) }),
        publication({ listingId: "l2", status: "scheduled", scheduledAt: hours(1) }),
        postPublication("post-1", { status: "scheduled", scheduledAt: hours(1) }),
      ],
      from: hours(0),
      to: hours(24),
      now: NOW,
    });
    expect(entries.map((e) => e.title)).toEqual(["P-001"]);
  });

  it("no vuelve enlace lo que no es https", () => {
    const [entry] = run([
      publication({ status: "published", publishedAt: hours(1), externalUrl: "javascript:x" }),
    ]);
    expect(entry?.externalUrl).toBeNull();
  });

  it("una atrasada dice overdue", () => {
    const [entry] = run([publication({ status: "scheduled", scheduledAt: hours(-13) })]);
    expect(entry?.schedule).toBe("overdue");
  });
});

describe("los días de Chile del calendario", () => {
  it("el día de un instante y su comienzo, también con el cambio de hora", () => {
    // 2026-10-15 00:30 en Chile (verano, UTC-3) es 03:30 UTC.
    expect(chileDateOf(new Date("2026-10-15T03:30:00.000Z"))).toBe("2026-10-15");
    expect(chileDateOf(new Date("2026-10-15T02:59:00.000Z"))).toBe("2026-10-14");
    expect(chileDateStart("2026-10-15").toISOString()).toBe("2026-10-15T03:00:00.000Z");
    // Invierno (UTC-4).
    expect(chileDateStart("2026-07-01").toISOString()).toBe("2026-07-01T04:00:00.000Z");
    // 2026-09-06: el reloj salta de 00:00 a 01:00; el día empieza a la 01:00 (04:00 UTC).
    expect(chileDateStart("2026-09-06").toISOString()).toBe("2026-09-06T04:00:00.000Z");
    // 2026-04-05: se atrasa de 00:00 a 23:00 del 4; el día 5 empieza a las 00:00 de invierno.
    expect(chileDateStart("2026-04-05").toISOString()).toBe("2026-04-05T04:00:00.000Z");
    expect(() => chileDateStart("2026-4-5")).toThrow(RangeError);
  });
});

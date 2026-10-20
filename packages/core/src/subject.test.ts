import { describe, expect, it } from "vitest";
import { contentRunSchema } from "./content.js";
import {
  listingIdOf,
  listingSubject,
  postSubject,
  sameSubject,
  subjectColumns,
  subjectFieldsFor,
  subjectFieldsOf,
  subjectFromColumns,
  subjectOfInput,
  toSubject,
} from "./subject.js";

// F9-T04 (ADR-0029): el sujeto de una publicación, un aviso o un post, y sus columnas.

describe("sujeto (aviso o post)", () => {
  it("las columnas de la base dan un solo sujeto, y vuelven a las mismas columnas", () => {
    expect(subjectFromColumns({ listingId: "l1", postId: null })).toEqual(listingSubject("l1"));
    expect(subjectFromColumns({ listingId: null, postId: "p1" })).toEqual(postSubject("p1"));
    expect(subjectColumns(listingSubject("l1"))).toEqual({ listingId: "l1", postId: null });
    expect(subjectColumns(postSubject("p1"))).toEqual({ listingId: null, postId: "p1" });
  });

  it("ninguno o los dos no es un sujeto: la entidad no valida (core nunca ve dos campos nulos)", () => {
    expect(subjectFromColumns({ listingId: null, postId: null })).toBeNull();
    expect(subjectFromColumns({ listingId: "l1", postId: "p1" })).toBeNull();
    const row = {
      id: "r1",
      status: "queued",
      texts: true,
      stage: null,
      report: null,
      error: null,
      startedAt: null,
      finishedAt: null,
      createdAt: new Date(),
      llmUsage: null,
    };
    expect(
      contentRunSchema.safeParse({ ...row, ...subjectFieldsOf({ listingId: null, postId: null }) })
        .success,
    ).toBe(false);
    expect(
      contentRunSchema.safeParse({ ...row, ...subjectFieldsOf({ listingId: "l", postId: "p" }) })
        .success,
    ).toBe(false);
    expect(
      contentRunSchema.parse({ ...row, ...subjectFieldsOf({ listingId: null, postId: "p" }) }),
    ).toMatchObject({ subject: postSubject("p"), listingId: null });
  });

  it("un texto es el id de un aviso, como antes de F9", () => {
    expect(toSubject("l1")).toEqual(listingSubject("l1"));
    expect(toSubject(postSubject("p1"))).toEqual(postSubject("p1"));
    expect(subjectOfInput({ listingId: "l1" })).toEqual(listingSubject("l1"));
    expect(subjectOfInput({ postId: "p1" })).toEqual(postSubject("p1"));
  });

  it("sameSubject distingue el tipo aunque el id coincida", () => {
    expect(sameSubject(listingSubject("x"), listingSubject("x"))).toBe(true);
    expect(sameSubject(listingSubject("x"), postSubject("x"))).toBe(false);
    expect(sameSubject(postSubject("x"), postSubject("y"))).toBe(false);
  });

  it("subjectFieldsFor deja listingId como atajo del aviso", () => {
    expect(subjectFieldsFor(listingSubject("l1"))).toEqual({
      subject: listingSubject("l1"),
      listingId: "l1",
    });
    expect(subjectFieldsFor(postSubject("p1"))).toEqual({
      subject: postSubject("p1"),
      listingId: null,
    });
  });

  it("listingIdOf: un post en un camino de avisos es SUBJECT_NOT_LISTING, no reintentable", () => {
    expect(listingIdOf(listingSubject("l1"))).toBe("l1");
    expect(() => listingIdOf(postSubject("p1"))).toThrow(
      expect.objectContaining({ code: "SUBJECT_NOT_LISTING", retriable: false }),
    );
  });
});

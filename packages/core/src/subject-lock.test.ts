import { describe, expect, it } from "vitest";
import { isAppError } from "./errors.js";
import type { ListingLock, LockedRepositories } from "./ports/listing-lock.js";
import type { PostLock, PostLockedRepositories } from "./ports/post-lock.js";
import { listingSubject, postSubject } from "./subject.js";
import { runOnSubject } from "./subject-lock.js";

/** Candados que solo anotan qué se pidió y entregan repositorios marcados. */
function fakeLocks() {
  const calls: string[] = [];
  const listingRepos = { tag: "listing" } as unknown as LockedRepositories;
  const postRepos = { tag: "post" } as unknown as PostLockedRepositories;
  const lock: ListingLock = {
    run: async (id, fn) => {
      calls.push(`listing:${id}`);
      return fn(listingRepos);
    },
  };
  const postLock: PostLock = {
    run: async (id, fn) => {
      calls.push(`post:${id}`);
      return fn(postRepos);
    },
  };
  return { calls, lock, postLock, listingRepos, postRepos };
}

describe("runOnSubject", () => {
  it("un aviso corre en el candado del aviso, con sus repositorios", async () => {
    const t = fakeLocks();
    const seen = await runOnSubject(t, listingSubject("aviso-1"), async (locked) => locked);
    expect(t.calls).toEqual(["listing:aviso-1"]);
    expect(seen.kind).toBe("listing");
    expect(seen.subject).toEqual({ kind: "listing", id: "aviso-1" });
    expect(seen.repos).toBe(t.listingRepos);
  });

  it("un post corre en el candado del post, nunca en el del aviso", async () => {
    const t = fakeLocks();
    const seen = await runOnSubject(t, postSubject("post-1"), async (locked) => locked);
    expect(t.calls).toEqual(["post:post-1"]);
    expect(seen.kind).toBe("post");
    expect(seen.subject).toEqual({ kind: "post", id: "post-1" });
    expect(seen.repos).toBe(t.postRepos);
  });

  it("sin candado de posts, un post es SUBJECT_NOT_LISTING sin tomar ningún candado", async () => {
    const t = fakeLocks();
    let ran = false;
    const error = await runOnSubject({ lock: t.lock }, postSubject("post-1"), async () => {
      ran = true;
    }).catch((caught: unknown) => caught);
    expect(isAppError(error) && [error.code, error.retriable]).toEqual([
      "SUBJECT_NOT_LISTING",
      false,
    ]);
    expect(ran).toBe(false);
    expect(t.calls).toEqual([]);
  });
});

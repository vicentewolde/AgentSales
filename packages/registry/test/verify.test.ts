import { describe, expect, it } from "vitest";
import type { ClaimProposal } from "../src/claims/schema.js";
import {
  DEFAULT_VERIFY,
  type Detection,
  declaredClaims,
  toDetections,
  verifyProposal,
} from "../src/claims/verify.js";

const proposal: ClaimProposal = {
  id: "c1",
  category: "feature",
  statement: "Kitchen has an island",
  concept: "kitchen island",
  t_start: 10,
  t_end: 14,
  subjective: false,
};
const box = { x1: 100, y1: 100, x2: 400, y2: 400, w: 1280, h: 720 };
const det = (t: number, c: number | null = 0.9): Detection => ({
  frame: Math.round(t * 5),
  t_sec: t,
  confidence: c,
  box,
});

describe("verifyProposal: no evidence, no claim", () => {
  it("verifies when SAM sees the object in enough frames inside the window", () => {
    const c = verifyProposal(proposal, [det(11), det(12), det(30)]);
    expect(c.provenance).toBe("visually_verified");
    expect(c.evidence?.frames_detected).toBe(2);
    expect(c.evidence?.concept).toBe("kitchen island");
  });

  it("holds back a claim whose object only appears outside the window", () => {
    const c = verifyProposal(proposal, [det(40), det(41), det(42)]);
    expect(c.provenance).toBe("unverified");
    expect(c.evidence).toBeNull();
    expect(c.note).toMatch(/0 frame/);
  });

  it("ignores low-confidence and tiny detections", () => {
    const tiny = { ...det(11), box: { x1: 0, y1: 0, x2: 5, y2: 5, w: 1280, h: 720 } };
    expect(verifyProposal(proposal, [det(11, 0.2), det(12, 0.3), tiny]).provenance).toBe(
      "unverified",
    );
  });

  it("counts detections without a confidence value", () => {
    expect(verifyProposal(proposal, [det(11, null), det(12, null)]).provenance).toBe(
      "visually_verified",
    );
  });

  it("never asserts taste words, even if something was detected", () => {
    const c = verifyProposal({ ...proposal, subjective: true, statement: "Very bright kitchen" }, [
      det(11),
      det(12),
    ]);
    expect(c.provenance).toBe("subjective");
    expect(c.evidence).toBeNull();
  });

  it("leaves claims with nothing visible to check for the broker to declare", () => {
    expect(verifyProposal({ ...proposal, concept: null }, null).provenance).toBe("unverified");
  });

  it("picks the most confident frame as the evidence", () => {
    const c = verifyProposal(proposal, [det(11, 0.6), det(12, 0.95), det(13, 0.7)]);
    expect(c.evidence?.confidence).toBe(0.95);
  });

  it("respects a custom threshold", () => {
    expect(
      verifyProposal(proposal, [det(11)], { ...DEFAULT_VERIFY, minFrames: 2 }).provenance,
    ).toBe("unverified");
  });
});

describe("toDetections", () => {
  it("maps frame indexes to seconds using the clip fps", () => {
    const d = toDetections(
      [{ frame: 10, objects: [{ id: 1, box, confidence: 0.8, maskToken: null }] }],
      5,
    );
    expect(d[0]?.t_sec).toBe(2);
  });
});

describe("declaredClaims", () => {
  it("labels the broker's own entries as declared, never as verified", () => {
    const cs = declaredClaims(
      {
        title: "t",
        operation: "rent",
        commune: "Nunoa",
        address: null,
        price: { amount: 400000, currency: "CLP" },
        area_m2: 55,
        bedrooms: 2,
        bathrooms: 1,
        pets_allowed: true,
      },
      "broker-1",
      "2026-11-01T00:00:00Z",
    );
    expect(cs.every((c) => c.provenance === "broker_declared")).toBe(true);
    expect(cs.find((c) => c.id === "d-pets")?.statement).toBe("Pets allowed");
    expect(cs.some((c) => c.id === "d-address")).toBe(false);
  });
});

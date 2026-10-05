import { describe, expect, it } from "vitest";
import {
  graphErrorOf,
  INSTAGRAM_ERRORS,
  type InstagramErrorInfo,
  instagramError,
  retryAfterMinutesOf,
} from "./errors.js";

/** La tabla de errores del spec F3 §4.5, fila por fila: lo que llega, el código y si se reintenta. */
const TABLE: [string, InstagramErrorInfo[], boolean][] = [
  ["IG_AUTH_INVALID", [{ code: 190 }, { code: 190, subcode: 463 }, { code: 102 }], false],
  ["IG_PERMISSION_DENIED", [{ code: 10 }, { code: 200 }, { code: 250 }, { code: 299 }], false],
  [
    "IG_MEDIA_REJECTED",
    [
      2207004, 2207005, 2207009, 2207010, 2207023, 2207026, 2207028, 2207035, 2207036, 2207037,
      2207040, 2207057,
    ].map((subcode) => ({ code: 100, subcode })),
    false,
  ],
  [
    "IG_ACCOUNT_RESTRICTED",
    [
      { code: 25, subcode: 2207050 },
      // El código 4 también es el límite de llamadas: el subcódigo manda.
      { code: 4, subcode: 2207051 },
    ],
    false,
  ],
  ["IG_PUBLISH_LIMIT", [{ code: 9 }, { code: 9, subcode: 2207042 }], false],
  ["IG_RATE_LIMITED", [{ code: 4 }, { code: 17 }, { code: 80002 }, { code: 613 }], false],
  [
    "IG_MEDIA_FETCH_FAILED",
    [
      { code: -2, subcode: 2207003 },
      { code: 9004, subcode: 2207052 },
    ],
    true,
  ],
  [
    "IG_UNAVAILABLE",
    [
      { httpStatus: 500 },
      { httpStatus: 503 },
      { code: 1 },
      { code: 2 },
      ...[2207001, 2207032, 2207053, 2207006, 2207020].map((subcode) => ({ code: -1, subcode })),
    ],
    true,
  ],
  [
    "IG_MEDIA_NOT_READY",
    [
      { code: 24, subcode: 2207008 },
      { code: 9007, subcode: 2207027 },
    ],
    true,
  ],
  ["IG_REQUEST_REJECTED", [{ httpStatus: 400, code: 100 }, { httpStatus: 404 }], false],
];

describe("instagramError", () => {
  for (const [code, cases, retriable] of TABLE) {
    it(`${code}: ${retriable ? "se reintenta" : "no se reintenta"}`, () => {
      for (const info of cases) {
        const error = instagramError({ httpStatus: 400, ...info });
        expect(error, JSON.stringify(info)).toMatchObject({ code, retriable });
        expect(error.message).not.toBe(code);
        expect(error.details).toEqual({
          httpStatus: info.httpStatus ?? 400,
          graphCode: info.code ?? null,
          graphSubcode: info.subcode ?? null,
        });
      }
    });
  }

  it("el límite de llamadas dice cuándo reintentar (1 hora si no llegó el dato)", () => {
    expect(instagramError({ code: 17, retryAfterMinutes: 12 }).message).toContain("12 minutos");
    expect(instagramError({ code: 17 }).message).toContain("60 minutos");
  });

  it("los errores que arma el publisher, con su código y si se reintentan", () => {
    expect(INSTAGRAM_ERRORS.containerTimeout()).toMatchObject({
      code: "IG_CONTAINER_TIMEOUT",
      retriable: true,
    });
    expect(INSTAGRAM_ERRORS.publishOutcomeUnknown()).toMatchObject({
      code: "IG_PUBLISH_OUTCOME_UNKNOWN",
      retriable: false,
    });
    expect(INSTAGRAM_ERRORS.unavailable("timeout")).toMatchObject({
      code: "IG_UNAVAILABLE",
      retriable: true,
    });
    expect(INSTAGRAM_ERRORS.aborted()).toMatchObject({ code: "IG_ABORTED", retriable: true });
    expect(INSTAGRAM_ERRORS.unexpectedResponse("me")).toMatchObject({
      code: "IG_UNEXPECTED_RESPONSE",
      retriable: false,
    });
  });
});

describe("graphErrorOf", () => {
  it("lee el error de Graph y el del canje del código, con números como texto", () => {
    expect(graphErrorOf({ error: { code: 190, error_subcode: 463, message: "x" } })).toEqual({
      code: 190,
      subcode: 463,
    });
    expect(graphErrorOf({ error: { code: "4", error_subcode: "2207051" } })).toEqual({
      code: 4,
      subcode: 2207051,
    });
    expect(
      graphErrorOf({ error_type: "OAuthException", code: 400, error_message: "Invalid code" }),
    ).toEqual({ code: 400 });
  });

  it("un cuerpo sin error es null", () => {
    for (const body of [null, "texto", { id: "1" }, { data: [] }]) {
      expect(graphErrorOf(body)).toBeNull();
    }
  });
});

describe("retryAfterMinutesOf", () => {
  it("toma la mayor espera de X-Business-Use-Case-Usage", () => {
    const header = JSON.stringify({
      "1789": [
        { type: "instagram", call_count: 100, estimated_time_to_regain_access: 5 },
        { type: "instagram", estimated_time_to_regain_access: 30 },
      ],
    });
    expect(retryAfterMinutesOf(header)).toBe(30);
  });

  it("sin dato, en cero o ilegible es null", () => {
    for (const header of [
      null,
      "no es json",
      "[]",
      JSON.stringify({ "1": [{ estimated_time_to_regain_access: 0 }] }),
    ]) {
      expect(retryAfterMinutesOf(header)).toBeNull();
    }
  });
});

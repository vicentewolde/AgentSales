import { AppError, type EnsureAccessTokenOptions } from "@agentsales/core";
import { describe, expect, it } from "vitest";
import { isRejectedAfterRefresh, withMercadoLibreToken } from "./token.js";

const rejected = () =>
  new AppError("ML_AUTH_INVALID", "token rechazado", { details: { httpStatus: 401 } });

function provider() {
  const calls: EnsureAccessTokenOptions[] = [];
  return {
    calls,
    ctx: {
      accessToken: async (options: EnsureAccessTokenOptions = {}) => {
        calls.push(options);
        return `token-${calls.length}`;
      },
    },
  };
}

describe("withMercadoLibreToken", () => {
  it("con un 401, pide otro token con el rechazado y repite una vez", async () => {
    const { calls, ctx } = provider();
    const used: string[] = [];

    const result = await withMercadoLibreToken(ctx, async (token) => {
      used.push(token);
      if (used.length === 1) throw rejected();
      return "ok";
    });

    expect(result).toBe("ok");
    expect(used).toEqual(["token-1", "token-2"]);
    expect(calls).toEqual([{}, { rejectedToken: "token-1" }]);
  });

  it("un segundo 401 sube marcado, y ya no se reconoce como para refrescar", async () => {
    const { calls, ctx } = provider();

    const error = await withMercadoLibreToken(ctx, async () => {
      throw rejected();
    }).catch((caught: unknown) => caught);

    expect(isRejectedAfterRefresh(error)).toBe(true);
    expect(error).toMatchObject({ retriable: false, details: { httpStatus: 401 } });
    expect(calls).toHaveLength(2);
    expect(isRejectedAfterRefresh(rejected())).toBe(false);
  });

  it("otro error sube tal cual, sin pedir otro token", async () => {
    const { calls, ctx } = provider();
    const other = new AppError("ML_UNAVAILABLE", "caído", { retriable: true });

    await expect(
      withMercadoLibreToken(ctx, async () => {
        throw other;
      }),
    ).rejects.toBe(other);
    expect(calls).toHaveLength(1);
  });
});

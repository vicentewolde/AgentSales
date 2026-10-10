import { describe, expect, it } from "vitest";
import type { UfValue, UfValueSource } from "../ports/uf-value-source.js";
import { marketplacePrice, ufToClp } from "./price.js";

const NOW = new Date("2026-10-09T18:00:00Z");
const source = (values: UfValue[]): UfValueSource => ({
  async valuesBetween(from, to) {
    return values.filter((value) => value.date >= from && value.date <= to);
  },
});
const TODAY = { date: "2026-10-09", value: "41130.94" };
const YESTERDAY = { date: "2026-10-08", value: "41126.12" };

describe("ufToClp", () => {
  it.each([
    [5800, "41130.94", 238_559_452],
    [5800.5, "41130.94", 238_580_017],
    [1, "41130.945", 41_131],
    [0, "41130.94", 0],
    [12.25, "39000", 477_750],
  ])("%s UF a %s = %s pesos (enteros, sin flotantes)", (amount, value, expected) => {
    expect(ufToClp(amount, value)).toBe(expected);
  });

  it("rechaza un valor de la UF mal formado y un monto negativo", () => {
    expect(() => ufToClp(1, "41.130,94")).toThrow(
      expect.objectContaining({ code: "UF_VALUE_INVALID" }),
    );
    expect(() => ufToClp(-1, "41130.94")).toThrow(
      expect.objectContaining({ code: "PRICE_INVALID" }),
    );
  });
});

describe("marketplacePrice", () => {
  it("en CLP va tal cual, sin consultar la UF", async () => {
    await expect(
      marketplacePrice({ priceAmount: 650_000, priceCurrency: "CLP" }, { uf: null, now: NOW }),
    ).resolves.toEqual({ priceClp: 650_000, uf: null });
  });

  it("en UF usa el valor del día de Santiago y pide ayer y hoy", async () => {
    const calls: string[] = [];
    const uf: UfValueSource = {
      async valuesBetween(from, to) {
        calls.push(`${from}..${to}`);
        return [YESTERDAY, TODAY];
      },
    };
    await expect(
      marketplacePrice({ priceAmount: 5800, priceCurrency: "UF" }, { uf, now: NOW }),
    ).resolves.toEqual({ priceClp: 238_559_452, uf: TODAY });
    expect(calls).toEqual(["2026-10-08..2026-10-09"]);
  });

  it("sin fuente, sin el valor de hoy o con un salto de más de 1 %, no hay precio", async () => {
    const uf = { priceAmount: 5800, priceCurrency: "UF" as const };
    await expect(marketplacePrice(uf, { uf: null, now: NOW })).rejects.toMatchObject({
      code: "UF_SOURCE_NOT_CONFIGURED",
    });
    await expect(marketplacePrice(uf, { uf: source([YESTERDAY]), now: NOW })).rejects.toMatchObject(
      { code: "UF_VALUE_MISSING", retriable: false },
    );
    await expect(
      marketplacePrice(uf, {
        uf: source([{ date: "2026-10-08", value: "40000.00" }, TODAY]),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "UF_VALUE_SUSPICIOUS", retriable: false });
    // Solo el de hoy (sin el de ayer para comparar) sirve.
    await expect(marketplacePrice(uf, { uf: source([TODAY]), now: NOW })).resolves.toMatchObject({
      priceClp: 238_559_452,
    });
  });
});

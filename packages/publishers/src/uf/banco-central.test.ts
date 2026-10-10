import { delay, HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { usePlatformServer } from "../../test/msw-server.js";
import { BANCO_CENTRAL_API_URL, createBancoCentralUf, UF_SERIES } from "./banco-central.js";

const TOKEN = "token-bde-secreto-123";
const { server, requests } = usePlatformServer();

/** Una respuesta de `GetSeries` como la de la doc (nota §3.3), con valores inventados. */
const series = (obs: Array<{ indexDateString: string; value: string; statusCode?: string }>) => ({
  Codigo: 0,
  Descripcion: "Success",
  Series: { descripEsp: "Unidad de fomento (UF)", seriesId: UF_SERIES, Obs: obs },
  SeriesInfos: [],
});

const respond = (body: unknown, init?: ResponseInit) =>
  server.use(http.get(BANCO_CENTRAL_API_URL, () => HttpResponse.json(body as object, init)));

const errorText = (error: unknown) =>
  error instanceof Error
    ? `${error.message} ${error.stack ?? ""} ${JSON.stringify(error)}`
    : String(error);

describe("createBancoCentralUf", () => {
  it("pide la serie de la UF entre dos fechas y devuelve los días con valor, en AAAA-MM-DD", async () => {
    respond(
      series([
        { indexDateString: "08-10-2026", value: "41126.12", statusCode: "OK" },
        { indexDateString: "09-10-2026", value: "41130.94", statusCode: "OK" },
      ]),
    );
    const uf = createBancoCentralUf({ token: TOKEN });

    await expect(uf.valuesBetween("2026-10-08", "2026-10-09")).resolves.toEqual([
      { date: "2026-10-08", value: "41126.12" },
      { date: "2026-10-09", value: "41130.94" },
    ]);
    expect(requests).toHaveLength(1);
    const url = requests[0]?.url;
    expect(url?.searchParams.get("timeseries")).toBe("F073.UFF.PRE.Z.D");
    expect(url?.searchParams.get("function")).toBe("GetSeries");
    expect(url?.searchParams.get("firstdate")).toBe("2026-10-08");
    expect(url?.searchParams.get("lastdate")).toBe("2026-10-09");
    expect(url?.searchParams.get("token")).toBe(TOKEN);
  });

  it("guarda lo leído por fecha: la segunda consulta del mismo rango no sale", async () => {
    respond(
      series([
        { indexDateString: "08-10-2026", value: "41126.12" },
        { indexDateString: "09-10-2026", value: "41130.94" },
      ]),
    );
    const uf = createBancoCentralUf({ token: TOKEN });
    await uf.valuesBetween("2026-10-08", "2026-10-09");

    await expect(uf.valuesBetween("2026-10-09", "2026-10-09")).resolves.toEqual([
      { date: "2026-10-09", value: "41130.94" },
    ]);
    expect(requests).toHaveLength(1);
  });

  it("un día sin dato (NaN o ND) no viene ni se guarda: se vuelve a preguntar", async () => {
    respond(
      series([
        { indexDateString: "08-10-2026", value: "41126.12", statusCode: "OK" },
        { indexDateString: "09-10-2026", value: "NaN", statusCode: "ND" },
      ]),
    );
    const uf = createBancoCentralUf({ token: TOKEN });

    await expect(uf.valuesBetween("2026-10-08", "2026-10-09")).resolves.toEqual([
      { date: "2026-10-08", value: "41126.12" },
    ]);
    await uf.valuesBetween("2026-10-08", "2026-10-09");
    expect(requests).toHaveLength(2);
  });

  it("sin resultados (otro Codigo) devuelve la lista vacía", async () => {
    respond({ Codigo: -1, Descripcion: "Sin datos para el periodo", Series: null });
    const uf = createBancoCentralUf({ token: TOKEN });

    await expect(uf.valuesBetween("2026-10-08", "2026-10-09")).resolves.toEqual([]);
  });

  it.each([
    ["un 401", () => respond({}, { status: 401 })],
    ["un 403", () => respond({}, { status: 403 })],
    [
      "un Codigo que habla del token",
      () => respond({ Codigo: -5, Descripcion: "Invalid username or password / token" }),
    ],
  ])("%s es UF_SOURCE_AUTH_INVALID, sin el token ni la URL", async (_name, arrange) => {
    arrange();
    const uf = createBancoCentralUf({ token: TOKEN });

    const error = await uf.valuesBetween("2026-10-08", "2026-10-09").catch((caught) => caught);

    expect(error).toMatchObject({ code: "UF_SOURCE_AUTH_INVALID", retriable: false });
    expect(errorText(error)).not.toContain(TOKEN);
    expect(errorText(error)).not.toContain("si3.bcentral.cl");
  });

  it.each([
    ["un 500", () => respond({}, { status: 500 })],
    ["un 429", () => respond({}, { status: 429 })],
    ["sin red", () => server.use(http.get(BANCO_CENTRAL_API_URL, () => HttpResponse.error()))],
  ])("%s es UF_VALUE_UNAVAILABLE, reintentable, sin el token", async (_name, arrange) => {
    arrange();
    const uf = createBancoCentralUf({ token: TOKEN });

    const error = await uf.valuesBetween("2026-10-08", "2026-10-09").catch((caught) => caught);

    expect(error).toMatchObject({ code: "UF_VALUE_UNAVAILABLE", retriable: true });
    expect(errorText(error)).not.toContain(TOKEN);
  });

  it("el tope de tiempo corta la consulta (reintentable)", async () => {
    server.use(
      http.get(BANCO_CENTRAL_API_URL, async () => {
        await delay("infinite");
        return HttpResponse.json({});
      }),
    );
    const uf = createBancoCentralUf({ token: TOKEN, timeoutMs: 50 });

    await expect(uf.valuesBetween("2026-10-08", "2026-10-09")).rejects.toMatchObject({
      code: "UF_VALUE_UNAVAILABLE",
      retriable: true,
    });
  });

  it("otra forma de respuesta es UF_UNEXPECTED_RESPONSE; un valor con coma no se acepta", async () => {
    respond({ Codigo: 0, Series: {} });
    await expect(
      createBancoCentralUf({ token: TOKEN }).valuesBetween("2026-10-08", "2026-10-09"),
    ).rejects.toMatchObject({ code: "UF_UNEXPECTED_RESPONSE" });

    respond(series([{ indexDateString: "09-10-2026", value: "41.130,94" }]));
    await expect(
      createBancoCentralUf({ token: TOKEN }).valuesBetween("2026-10-09", "2026-10-09"),
    ).resolves.toEqual([]);
  });
});

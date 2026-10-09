// @vitest-environment jsdom
import {
  AppError,
  type PlatformContext,
  type Publication,
  type PublicationOperations,
  type RemoteStatus,
} from "@agentsales/core";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type HarnessOptions, publicationSetup } from "../../../test/harness.js";
import { ApiError } from "../../api/client.js";
import { SYNC_REFRESH_MS } from "../../queries/publications.js";
import { ErrorAlert } from "../ErrorAlert.js";

// F4-T22: la pestaña Portal en Contenido (spec F4 §4.12), sobre la API en proceso con operaciones
// dobles (nunca Mercado Libre).

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const PORTAL = "portal_inmobiliario";
const ITEM_URL = "https://www.portalinmobiliario.com/MLC-1234567890";
// A media mañana en Chile: el mismo día en cualquier zona horaria razonable.
const STOP_TIME = "2027-04-07T09:00:00.000-03:00";

const status = (value: string, extra: Partial<RemoteStatus> = {}): RemoteStatus => ({
  status: value,
  subStatus: [],
  stopTime: STOP_TIME,
  expirationTime: null,
  ...extra,
});

/** Operaciones de Portal guionadas: cada llamada se registra. */
function fakeOperations(
  respond: (operation: string) => Promise<RemoteStatus> = async (operation) =>
    status({ pause: "paused", resume: "active", close: "closed" }[operation] ?? "active"),
) {
  const calls: string[] = [];
  const make = (operation: string) => async (_ref: unknown, ctx: PlatformContext) => {
    await ctx.accessToken();
    calls.push(operation);
    return respond(operation);
  };
  const operations: PublicationOperations = {
    pause: make("pause"),
    resume: make("resume"),
    close: make("close"),
    getStatus: make("getStatus"),
  };
  return { operations, calls };
}

async function setup(
  options: {
    publishMode?: "dry-run" | "live";
    approve?: boolean;
    operations?: PublicationOperations;
    intercept?: HarnessOptions["intercept"];
  } = {},
) {
  const fake = fakeOperations();
  // Lo que el panel mandó en cada POST (el cuerpo), para afirmar `confirmed`.
  const bodies: Array<{ path: string; body: unknown }> = [];
  const s = await publicationSetup({
    platform: PORTAL,
    publishMode: options.publishMode ?? "live",
    approve: options.approve ?? true,
    operations: options.operations ?? fake.operations,
    intercept: (method, path, init) => {
      if (method === "POST" && typeof init?.body === "string") {
        bodies.push({ path, body: JSON.parse(init.body) });
      }
      return options.intercept?.(method, path, init);
    },
  });
  return { ...s, calls: fake.calls, bodies };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** El aviso de Portal publicado (en vivo o en simulación), como lo deja el worker. */
async function published(
  t: Setup["t"],
  options: { live: boolean; remote?: RemoteStatus },
): Promise<Publication> {
  const id = t.publications.all()[0]?.id ?? "";
  await t.publications.transition(
    id,
    {
      from: "approved",
      to: "publishing",
      changes: { dryRun: !options.live, incrementAttempts: true },
    },
    { actor: "system" },
  );
  if (options.live) await t.listings.changeStatus(t.listingId, "ready", "active");
  return t.publications.transition(
    id,
    {
      from: "publishing",
      to: "published",
      changes: {
        externalId: options.live ? "MLC1234567890" : `dry-run:${id}`,
        ...(options.live
          ? {
              externalUrl: ITEM_URL,
              remoteState: {
                ...(options.remote ?? status("active")),
                checkedAt: new Date().toISOString(),
              },
            }
          : {}),
      },
    },
    { actor: "system" },
  );
}

/** Abre la sección Contenido y la pestaña Portal; devuelve su panel. */
async function portalTab(s: Setup) {
  const section = await s.open();
  fireEvent.click(await within(section).findByRole("tab", { name: /Portal Inmobiliario/ }));
  return within(section).getByRole("tabpanel");
}

const aviso = (panel: HTMLElement) =>
  within(panel).findByRole("article", { name: "Publicación aviso" });

/** Le quita el WhatsApp al corredor (Portal lo exige). */
async function withoutWhatsapp(t: Setup["t"]) {
  const listing = await t.listings.get(t.listingId);
  const broker = listing === null ? null : await t.brokers.findById(listing.brokerId);
  if (broker === null) throw new Error("falta el corredor");
  const { id, logoMediaId: _logo, autoPublish: _auto, ...data } = broker;
  await t.brokers.update(id, { ...data, whatsapp: null });
}

describe("panel: Portal en Contenido", () => {
  it("en simulación: listo para Portal, publica el aviso y dice que no se creó nada", async () => {
    const s = await setup({ publishMode: "dry-run" });
    const panel = await portalTab(s);

    expect(within(panel).getByText("El aviso tiene lo que pide Portal Inmobiliario.")).toBeTruthy();
    fireEvent.click(
      await within(panel).findByRole("button", {
        name: "Publicar en Portal Inmobiliario (simulación)",
      }),
    );
    expect(await within(await aviso(panel)).findByText("publicando")).toBeTruthy();
    expect(s.t.queue.jobs.map((job) => job.name)).toContain("publication.publish");
    expect(s.requests).toContain(`POST /listings/${s.t.listingId}/publish`);
  });

  it("publicado en simulación: Pausar y Cerrar sin Actualizar (no hay nada que leer)", async () => {
    const s = await setup({ publishMode: "dry-run" });
    await published(s.t, { live: false });
    const item = await aviso(await portalTab(s));

    expect(item.textContent).toContain("Simulación: no se creó ni cambió nada en Mercado Libre.");
    expect(within(item).getByRole("button", { name: "Pausar el aviso" })).toBeTruthy();
    expect(within(item).getByRole("button", { name: "Cerrar el aviso" })).toBeTruthy();
    expect(within(item).queryByRole("button", { name: /Actualizar/ })).toBeNull();
    expect(within(item).queryByRole("button", { name: /retirad/ })).toBeNull();
  });

  it("lo que falta para Portal se lista solo en su pestaña y bloquea Publicar", async () => {
    const s = await setup({ publishMode: "dry-run" });
    await withoutWhatsapp(s.t);
    const panel = await portalTab(s);

    const missing = within(panel).getByRole("region", { name: "Lo que falta para Portal" });
    expect(missing.textContent).toContain("WhatsApp");
    const publish = within(panel).getByRole("button", {
      name: "Publicar en Portal Inmobiliario (simulación)",
    }) as HTMLButtonElement;
    expect(publish.disabled).toBe(true);
    expect(panel.textContent).toContain("Falta información para Portal (arriba)");

    fireEvent.click(screen.getByRole("tab", { name: /Instagram/ }));
    expect(screen.queryByRole("region", { name: "Lo que falta para Portal" })).toBeNull();
  });

  it("un texto aprobado cuya revisión tiene errores: Publicar desactivado, con Quitar aprobación", async () => {
    const s = await setup({ publishMode: "dry-run" });
    await s.t.contents.update(await s.t.portalId(), {
      body: "Departamento con 99 estacionamientos",
      status: "approved",
    });
    const panel = await portalTab(s);

    const publish = (await within(panel).findByRole("button", {
      name: "Publicar en Portal Inmobiliario (simulación)",
    })) as HTMLButtonElement;
    expect(publish.disabled).toBe(true);
    expect(panel.textContent).toContain("quita la aprobación, corrígelo y vuelve a aprobarlo");
    expect(
      within(panel).getByRole("button", { name: "Quitar aprobación de Portal Inmobiliario" }),
    ).toBeTruthy();
  });

  it("en vivo: confirma que usa un cupo antes de publicar", async () => {
    const s = await setup();
    const panel = await portalTab(s);

    fireEvent.click(
      await within(panel).findByRole("button", {
        name: "Publicar en Portal Inmobiliario (en vivo)",
      }),
    );
    expect(within(panel).getByRole("alert").textContent).toContain(
      "se publicará de verdad en Portal Inmobiliario y usará un cupo de tu paquete",
    );
    expect(s.requests.some((request) => request.endsWith("/publish"))).toBe(false);
  });

  it("muestra el estado en Mercado Libre, el vencimiento y el motivo si lo pausó Mercado Libre", async () => {
    const s = await setup();
    const publication = await published(s.t, { live: true });
    const remote = {
      ...status("paused", {
        reason: {
          code: "PAUSED_PREVENTION_PRICE",
          message: "Mercado Libre la pausó por el precio",
        },
      }),
      checkedAt: new Date().toISOString(),
    };
    await s.t.publications.transition(
      publication.id,
      { from: "published", to: "paused", changes: { remoteState: remote } },
      { actor: "system", payload: { mode: "live", sync: true, remoteStatus: "paused" } },
    );
    const item = await aviso(await portalTab(s));

    expect(item.textContent).toContain("En Mercado Libre: pausado por Mercado Libre");
    expect(item.textContent).toContain("vence el 7 de abril de 2027");
    expect(item.textContent).toContain("Mercado Libre la pausó por el precio");
    expect(within(item).getByRole("link", { name: "Ver en Portal Inmobiliario" })).toBeTruthy();
    expect(within(item).getByRole("button", { name: "Reactivar el aviso" })).toBeTruthy();
    expect(within(item).queryByRole("button", { name: "Pausar el aviso" })).toBeNull();

    fireEvent.click(within(item).getByRole("button", { name: "Bitácora del aviso" }));
    expect(
      await within(item).findByText(/publicada → pausada · leído de Mercado Libre: pausado/),
    ).toBeTruthy();
  });

  it("Pausar y Reactivar llaman a Mercado Libre y muestran el estado nuevo", async () => {
    const s = await setup();
    await published(s.t, { live: true });
    const panel = await portalTab(s);
    expect(within(await aviso(panel)).queryByRole("button", { name: /retirad/ })).toBeNull();

    fireEvent.click(within(await aviso(panel)).getByRole("button", { name: "Pausar el aviso" }));
    expect(await within(await aviso(panel)).findByText("pausada")).toBeTruthy();
    expect((await aviso(panel)).textContent).toContain("En Mercado Libre: pausado");

    fireEvent.click(
      await within(await aviso(panel)).findByRole("button", { name: "Reactivar el aviso" }),
    );
    expect(await within(await aviso(panel)).findByText("publicada")).toBeTruthy();
    expect(s.calls).toEqual(["pause", "resume"]);
  });

  it("Cerrar en vivo pide confirmación (irreversible); al cerrar, la propiedad vuelve a lista", async () => {
    const s = await setup();
    const publication = await published(s.t, { live: true });
    const panel = await portalTab(s);

    fireEvent.click(within(await aviso(panel)).getByRole("button", { name: "Cerrar el aviso" }));
    expect((await aviso(panel)).textContent).toContain(
      "Es irreversible: volver a publicar crea un aviso nuevo y usa otro cupo.",
    );
    fireEvent.click(within(await aviso(panel)).getByRole("button", { name: "Cancelar" }));
    expect(s.calls).toEqual([]);

    fireEvent.click(within(await aviso(panel)).getByRole("button", { name: "Cerrar el aviso" }));
    fireEvent.click(within(await aviso(panel)).getByRole("button", { name: "Sí, cerrar" }));

    // La publicación pasa a "Descartadas y retiradas" y el aviso sigue a la vista (lo muestra el panel).
    expect(await within(panel).findByText("Descartadas y retiradas (1)")).toBeTruthy();
    expect(within(panel).getByText(/la propiedad volvió a lista/)).toBeTruthy();
    expect(s.calls).toEqual(["close"]);
    expect(s.bodies).toContainEqual({
      path: `/publications/${publication.id}/close`,
      body: { confirmed: true },
    });
    expect((await s.t.publications.get(publication.id))?.status).toBe("unpublished");
  });

  it("Actualizar pide la lectura; si ya había una, lo dice", async () => {
    const s = await setup();
    await published(s.t, { live: true });
    const panel = await portalTab(s);

    fireEvent.click(
      within(await aviso(panel)).getByRole("button", { name: "Actualizar el estado del aviso" }),
    );
    expect(await within(panel).findByText(/Se pidió leer el estado en Mercado Libre/)).toBeTruthy();
    expect(s.t.queue.jobs.filter((job) => job.name === "publication.sync")).toHaveLength(1);

    vi.spyOn(s.t.deps.queue, "enqueue").mockResolvedValueOnce(null);
    fireEvent.click(
      within(await aviso(panel)).getByRole("button", { name: "Actualizar el estado del aviso" }),
    );
    expect(await within(panel).findByText(/Ya hay una lectura programada/)).toBeTruthy();
  });

  it("un acceso rechazado enlaza a Cuentas; un corte sugiere Actualizar", async () => {
    for (const [error, text] of [
      [
        new AppError("ML_AUTH_INVALID", "El acceso de Mercado Libre no es válido"),
        "Reconecta la cuenta de Mercado Libre",
      ],
      [new AppError("ML_ABORTED", "Se cortó", { retriable: true }), "Usa Actualizar en un momento"],
    ] as const) {
      const fake = fakeOperations(async () => {
        throw error;
      });
      const s = await setup({ operations: fake.operations });
      await published(s.t, { live: true });
      const panel = await portalTab(s);

      fireEvent.click(within(await aviso(panel)).getByRole("button", { name: "Pausar el aviso" }));
      expect(await within(panel).findByText(new RegExp(text))).toBeTruthy();
      if (error.code === "ML_AUTH_INVALID") {
        expect(within(panel).getByRole("link", { name: "Cuentas" }).getAttribute("href")).toBe(
          "/cuentas",
        );
      }
      cleanup();
    }
  });
  it("Cerrar en simulación pregunta sin decir irreversible y no manda confirmed", async () => {
    const s = await setup({ publishMode: "dry-run" });
    const publication = await published(s.t, { live: false });
    const panel = await portalTab(s);

    fireEvent.click(within(await aviso(panel)).getByRole("button", { name: "Cerrar el aviso" }));
    expect((await aviso(panel)).textContent).toContain("Es una simulación");
    fireEvent.click(within(await aviso(panel)).getByRole("button", { name: "Sí, cerrar" }));

    expect(await within(panel).findByText("Descartadas y retiradas (1)")).toBeTruthy();
    expect(s.bodies).toContainEqual({ path: `/publications/${publication.id}/close`, body: {} });
    expect(s.calls).toEqual([]);
  });

  it("si el pedido se corta, no invita a repetir: pudo haberse aplicado", async () => {
    const s = await setup({
      intercept: (method, path) => {
        if (method === "POST" && path.endsWith("/pause")) throw new Error("red caída");
        return undefined;
      },
    });
    await published(s.t, { live: true });
    const panel = await portalTab(s);

    fireEvent.click(within(await aviso(panel)).getByRole("button", { name: "Pausar el aviso" }));
    const alert = await within(panel).findByRole("alert");
    expect(alert.textContent).toContain("Pudo haberse aplicado en Mercado Libre");
    expect(alert.textContent).not.toContain("vuelve a intentar");
  });

  it("una en vivo con la API en simulación: lo explica sin dar por hecho cuál está mal", async () => {
    const s = await setup({ publishMode: "dry-run" });
    await published(s.t, { live: true });
    const panel = await portalTab(s);

    fireEvent.click(within(await aviso(panel)).getByRole("button", { name: "Pausar el aviso" }));
    const alert = await within(panel).findByRole("alert");
    expect(alert.textContent).toContain("PUBLISH_MODE_MISMATCH");
    expect(alert.textContent).toContain("no están en el mismo modo");
    expect(s.calls).toEqual([]);
  });

  it("Actualizar vuelve a pedir el listado a los 8 s, una vez; pedirlo de nuevo reprograma, no suma", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const s = await setup();
      await published(s.t, { live: true });
      const panel = await portalTab(s);
      const listed = () =>
        s.requests.filter((r) => r === `GET /listings/${s.t.listingId}/publications`).length;
      const update = async () => {
        fireEvent.click(
          within(await aviso(panel)).getByRole("button", {
            name: "Actualizar el estado del aviso",
          }),
        );
        await within(panel).findByText(/Se pidió leer el estado/);
        // Lo que se vuelve a pedir al terminar la acción (no es el temporizador).
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1_000);
        });
      };

      await update();
      const before = listed();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SYNC_REFRESH_MS);
      });
      expect(listed()).toBe(before + 1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SYNC_REFRESH_MS * 2);
      });
      expect(listed()).toBe(before + 1);

      // Dos pedidos seguidos: el segundo reprograma (el primer temporizador se cancela).
      await update();
      await update();
      const twice = listed();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SYNC_REFRESH_MS * 2);
      });
      expect(listed()).toBe(twice + 1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ErrorAlert con PORTAL_NOT_READY", () => {
  it("muestra la lista con un encabezado corto, no además el mensaje que repite los motivos", () => {
    const error = new ApiError(
      "PORTAL_NOT_READY: Falta información para publicar en Portal Inmobiliario: Falta el WhatsApp",
      "PORTAL_NOT_READY",
      409,
      [{ code: "PORTAL_WHATSAPP_MISSING", field: null, message: "Falta el WhatsApp" }],
    );
    render(<ErrorAlert error={error} />);

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Falta información para publicar en Portal:");
    expect(
      within(alert)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Falta el WhatsApp"]);
    expect(alert.textContent?.match(/Falta el WhatsApp/g)).toHaveLength(1);
    expect(alert.textContent).toContain("hoja Corredor");
  });
});

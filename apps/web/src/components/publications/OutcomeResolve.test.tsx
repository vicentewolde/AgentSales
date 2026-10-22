// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { type HarnessOptions, publicationSetup } from "../../../test/harness.js";

// F9.5-T04b: «Salió / No salió» de una publicación de un aviso con resultado dudoso, en la sección
// Contenido de la propiedad, sobre la API en proceso (nunca Instagram ni Mercado Libre).

afterEach(cleanup);

const PORTAL = "portal_inmobiliario";
const MANY_MESSAGE =
  "Hay más de un aviso de esta publicación en Mercado Libre: cierra a mano los que sobren. Si dejas uno, di que salió con su enlace o su número MLC; si los cierras todos, di que no salió";

async function setup(
  options: {
    platform?: "instagram" | typeof PORTAL;
    publishMode?: "dry-run" | "live";
    intercept?: HarnessOptions["intercept"];
  } = {},
) {
  // Lo que el panel mandó en cada POST (el cuerpo), para afirmar el enlace.
  const bodies: Array<{ path: string; body: unknown }> = [];
  const s = await publicationSetup({
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    publishMode: options.publishMode ?? "live",
    intercept: (method, path, init) => {
      if (method === "POST" && typeof init?.body === "string") {
        bodies.push({ path, body: JSON.parse(init.body) });
      }
      return options.intercept?.(method, path, init);
    },
  });
  return { ...s, bodies };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** Deja una publicación en `outcome_unknown`, como el intento que se cortó justo al enviar. */
async function doubtful(
  t: Setup["t"],
  options: { live: boolean; format?: "post" | "reel"; code: string; message: string },
) {
  const id = (options.format === undefined ? t.publications.all()[0] : t.byFormat(options.format))
    ?.id;
  if (id === undefined) throw new Error("falta la publicación");
  await t.publications.transition(
    id,
    {
      from: "approved",
      to: "publishing",
      changes: { dryRun: !options.live, incrementAttempts: true },
    },
    { actor: "system" },
  );
  await t.publications.transition(
    id,
    {
      from: "publishing",
      to: "outcome_unknown",
      changes: { lastError: { code: options.code, message: options.message, retriable: false } },
    },
    { actor: "system" },
  );
  return id;
}

/** Abre Contenido (y la pestaña Portal si hace falta) y devuelve el bloque «Decir si salió». */
async function outcomeBox(s: Setup, format: "carrusel" | "aviso") {
  const section = await s.open();
  if (format === "aviso") {
    fireEvent.click(await within(section).findByRole("tab", { name: /Portal Inmobiliario/ }));
  }
  const item = await within(section).findByRole("article", { name: `Publicación ${format}` });
  return { item, box: within(item).getByRole("group", { name: "Decir si salió" }) };
}

describe("panel: salió / no salió en una propiedad", () => {
  it("Instagram: «Sí, salió» con el enlace la deja publicada, con su enlace", async () => {
    const s = await setup();
    const id = await doubtful(s.t, {
      live: true,
      format: "post",
      code: "IG_PUBLISH_OUTCOME_UNKNOWN",
      message: "No se sabe si salió en Instagram",
    });
    const { item, box } = await outcomeBox(s, "carrusel");

    expect(within(box).getByText(/No se sabe si salió: se cortó justo al enviar/)).toBeTruthy();
    expect(within(box).getByText("No se sabe si salió en Instagram")).toBeTruthy();
    fireEvent.change(within(box).getByLabelText("Enlace de la publicación"), {
      target: { value: "https://www.instagram.com/p/abc123/" },
    });
    fireEvent.click(within(box).getByRole("button", { name: "Sí, salió" }));

    await waitFor(() => expect(s.requests).toContain(`POST /publications/${id}/resolve`));
    expect(s.bodies.find((b) => b.path === `/publications/${id}/resolve`)?.body).toEqual({
      outcome: "published",
      url: "https://www.instagram.com/p/abc123/",
    });
    expect(await within(item).findByText("publicada")).toBeTruthy();
    expect(within(item).getByRole("link", { name: "Ver en Instagram" })).toBeTruthy();
    expect(within(item).queryByRole("group", { name: "Decir si salió" })).toBeNull();
    expect(s.t.publications.all().find((p) => p.id === id)?.status).toBe("published");
  });

  it("Instagram: «No salió» la deja fallida, para reintentarla, sin pedir confirmación", async () => {
    const s = await setup();
    const id = await doubtful(s.t, {
      live: true,
      format: "post",
      code: "IG_PUBLISH_OUTCOME_UNKNOWN",
      message: "No se sabe si salió en Instagram",
    });
    const { item, box } = await outcomeBox(s, "carrusel");

    fireEvent.click(within(box).getByRole("button", { name: "No salió" }));

    await waitFor(() => expect(s.requests).toContain(`POST /publications/${id}/resolve`));
    expect(s.bodies.find((b) => b.path === `/publications/${id}/resolve`)?.body).toEqual({
      outcome: "not_published",
    });
    expect(
      await within(item).findByRole("button", { name: "Reintentar el carrusel" }),
    ).toBeTruthy();
    expect(s.t.publications.all().find((p) => p.id === id)?.status).toBe("failed");
  });

  it("Portal en vivo: el enlace o el número MLC es obligatorio; con él queda publicada y pide leer su estado", async () => {
    const s = await setup({ platform: PORTAL });
    const id = await doubtful(s.t, {
      live: true,
      code: "ML_PUBLISH_OUTCOME_UNKNOWN",
      message: "No se sabe si el aviso se creó en Mercado Libre",
    });
    const { item, box } = await outcomeBox(s, "aviso");

    const salio = within(box).getByRole("button", { name: "Sí, salió" }) as HTMLButtonElement;
    expect(salio.disabled).toBe(true);
    const field = within(box).getByLabelText("Enlace del aviso o su número (MLC…)");
    expect(field.getAttribute("aria-describedby")).toBeTruthy();
    expect(within(box).getByText(/Con el sistema en vivo es obligatorio/)).toBeTruthy();

    fireEvent.change(field, { target: { value: "MLC1234567890" } });
    expect(salio.disabled).toBe(false);
    fireEvent.click(salio);

    await waitFor(() => expect(s.requests).toContain(`POST /publications/${id}/resolve`));
    expect(await within(item).findByText("publicada")).toBeTruthy();
    expect(
      await within(item).findByText(
        "Quedó publicada: en unos segundos se lee su estado en Mercado Libre.",
      ),
    ).toBeTruthy();
    const resolved = s.t.publications.all().find((p) => p.id === id);
    expect(resolved?.externalId).toBe("MLC1234567890");
    expect(s.t.queue.jobs.map((job) => job.name)).toContain("publication.sync");
  });

  it("Portal en simulación: el enlace no hace falta ni se confirma «No salió»", async () => {
    const s = await setup({ platform: PORTAL, publishMode: "dry-run" });
    await doubtful(s.t, {
      live: false,
      code: "ML_PUBLISH_OUTCOME_UNKNOWN",
      message: "No se sabe si el aviso se creó en Mercado Libre",
    });
    const { box } = await outcomeBox(s, "aviso");

    expect(within(box).getByText(/en simulación no hace falta/)).toBeTruthy();
    expect(
      (within(box).getByRole("button", { name: "Sí, salió" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(within(box).queryByText(/Con el sistema en vivo es obligatorio/)).toBeNull();
  });

  it("Portal en vivo con varios avisos («many»): «No salió» pide cerrar a mano los sobrantes antes", async () => {
    const s = await setup({ platform: PORTAL });
    const id = await doubtful(s.t, {
      live: true,
      code: "ML_PUBLISH_OUTCOME_UNKNOWN",
      message: MANY_MESSAGE,
    });
    const { item, box } = await outcomeBox(s, "aviso");

    expect(within(box).getByText(MANY_MESSAGE)).toBeTruthy();
    fireEvent.click(within(box).getByRole("button", { name: "No salió" }));
    const confirm = within(box).getByRole("alert");
    expect(confirm.textContent).toContain("ciérralos a mano todos");
    expect(s.requests).not.toContain(`POST /publications/${id}/resolve`);

    // Cancelar vuelve a los dos botones sin pedir nada.
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancelar" }));
    expect(within(box).queryByRole("alert")).toBeNull();
    expect(s.requests).not.toContain(`POST /publications/${id}/resolve`);

    fireEvent.click(within(box).getByRole("button", { name: "No salió" }));
    fireEvent.click(within(box).getByRole("button", { name: "Sí, no quedó ninguno" }));
    await waitFor(() => expect(s.requests).toContain(`POST /publications/${id}/resolve`));
    expect(await within(item).findByText("Dijiste que no salió", { exact: false })).toBeTruthy();
    expect(s.t.publications.all().find((p) => p.id === id)?.status).toBe("failed");
  });

  it("Portal en vivo: un enlace que no es de un aviso muestra el error de la API en el mismo bloque", async () => {
    const s = await setup({ platform: PORTAL });
    const id = await doubtful(s.t, {
      live: true,
      code: "ML_PUBLISH_OUTCOME_UNKNOWN",
      message: "No se sabe si el aviso se creó en Mercado Libre",
    });
    const { item, box } = await outcomeBox(s, "aviso");

    fireEvent.change(within(box).getByLabelText("Enlace del aviso o su número (MLC…)"), {
      target: { value: "https://example.com/aviso" },
    });
    fireEvent.click(within(box).getByRole("button", { name: "Sí, salió" }));

    expect(
      (await within(box).findByRole("alert")).textContent?.includes(
        "No es el enlace de un aviso de Portal Inmobiliario o Mercado Libre",
      ),
    ).toBe(true);
    // Una sola vez: el error no se repite al pie de la tarjeta.
    expect(within(item).getAllByRole("alert")).toHaveLength(1);
    expect(s.t.publications.all().find((p) => p.id === id)?.status).toBe("outcome_unknown");
  });

  it("Portal en vivo: el aviso de otra publicación (PORTAL_ITEM_IN_USE) se dice en el bloque", async () => {
    const s = await setup({
      platform: PORTAL,
      intercept: (method, path) =>
        method === "POST" && path.endsWith("/resolve")
          ? Response.json(
              {
                error: {
                  code: "PORTAL_ITEM_IN_USE",
                  message:
                    "Ese aviso de Mercado Libre ya es de otra publicación de esta propiedad (por ejemplo, el aviso anterior a republicar): pega el enlace o el número del aviso que salió ahora",
                },
              },
              { status: 409 },
            )
          : undefined,
    });
    await doubtful(s.t, {
      live: true,
      code: "ML_PUBLISH_OUTCOME_UNKNOWN",
      message: "No se sabe si el aviso se creó en Mercado Libre",
    });
    const { box } = await outcomeBox(s, "aviso");

    fireEvent.change(within(box).getByLabelText("Enlace del aviso o su número (MLC…)"), {
      target: { value: "MLC1111111111" },
    });
    fireEvent.click(within(box).getByRole("button", { name: "Sí, salió" }));

    expect((await within(box).findByRole("alert")).textContent).toContain(
      "ya es de otra publicación de esta propiedad",
    );
  });
});

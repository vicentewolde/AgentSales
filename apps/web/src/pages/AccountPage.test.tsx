// @vitest-environment jsdom
import { TEST_ADMIN } from "@agentsales/api/testing";
import { fakeTotpCode, fakeTotpStep } from "@agentsales/core/testing";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { harness } from "../../test/harness.js";

// F8-T16 (spec F8 §4.8): el doble factor en el panel, sobre la API en proceso: activar en Mi
// cuenta (la clave, el enlace y los códigos una vez, fuera de la caché) y entrar en dos pasos.

afterEach(cleanup);

const nowCode = (offset = 0) => fakeTotpCode(fakeTotpStep(new Date()) + offset);

/** Lo que guarda la caché del panel (consultas y mutaciones), como texto. */
function cached(h: ReturnType<typeof harness>) {
  return JSON.stringify([
    h.queryClient
      .getMutationCache()
      .getAll()
      .map((mutation) => mutation.state.data),
    h.queryClient
      .getQueryCache()
      .getAll()
      .map((query) => query.state.data),
  ]);
}

describe("Mi cuenta: el doble factor", () => {
  it("activar muestra la clave y el enlace; confirmar muestra los códigos una vez, fuera de la caché", async () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    const h = harness();
    h.renderApp("/cuenta");

    const section = await screen.findByRole("region", { name: "Doble factor" });
    expect(await within(section).findByText(/Recomendado para el administrador/)).toBeTruthy();
    fireEvent.click(
      await within(section).findByRole("button", { name: "Activar el doble factor" }),
    );

    const key = (await within(section).findByLabelText("Clave")) as HTMLInputElement;
    const secret = key.value.replaceAll(" ", "");
    expect(secret).toBe("CLAVEA");
    const link = within(section).getByRole("link", { name: "este enlace en tu app de claves" });
    expect(link.getAttribute("href")).toMatch(/^otpauth:\/\/totp\/AgentSales/);
    expect(cached(h)).not.toContain(secret);

    fireEvent.change(within(section).getByLabelText("Código de la app"), {
      target: { value: nowCode() },
    });
    fireEvent.click(within(section).getByRole("button", { name: "Confirmar" }));

    const done = await within(section).findByText("El doble factor quedó activo.");
    const box = done.closest("[role=status]") as HTMLElement;
    const codes = within(box)
      .getAllByRole("listitem")
      .map((item) => item.textContent ?? "");
    expect(codes).toHaveLength(10);
    fireEvent.click(within(box).getByRole("button", { name: "Copiar los códigos" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(codes.join("\n")));
    // Ni la clave ni los códigos quedan en la caché del panel.
    const text = cached(h);
    expect(text).not.toContain(secret);
    for (const recovery of codes) expect(text).not.toContain(recovery);

    fireEvent.click(within(box).getByRole("button", { name: "Ya los guardé, ocultarlos" }));
    expect(within(section).queryByText(codes[0] ?? "?")).toBeNull();
    expect(await within(section).findByText(/Te quedan 10 códigos de recuperación/)).toBeTruthy();
  });

  it("un código equivocado no lo activa y dice por qué", async () => {
    const h = harness();
    h.renderApp("/cuenta");
    const section = await screen.findByRole("region", { name: "Doble factor" });
    fireEvent.click(
      await within(section).findByRole("button", { name: "Activar el doble factor" }),
    );
    await within(section).findByLabelText("Clave");

    fireEvent.change(within(section).getByLabelText("Código de la app"), {
      target: { value: nowCode(5) },
    });
    fireEvent.click(within(section).getByRole("button", { name: "Confirmar" }));

    expect((await within(section).findByRole("alert")).textContent).toContain(
      "El código no es correcto",
    );
    expect(h.auth.repos.users.all()[0]?.totpEnabledAt).toBeNull();
  });
});

describe("entrar con el doble factor", () => {
  /** El administrador con el doble factor activo (la clave sellada como la sella el doble). */
  async function withTotp(h: ReturnType<typeof harness>) {
    await h.auth.repos.users.startTotp(TEST_ADMIN.id, `sellado:totp:${TEST_ADMIN.id}:CLAVEA`);
    await h.auth.repos.users.enableTotp(TEST_ADMIN.id, {
      at: new Date(),
      step: 0,
      recoveryCodeHashes: [],
    });
  }

  async function enterPassword() {
    fireEvent.change(screen.getByLabelText("Correo"), { target: { value: TEST_ADMIN.email } });
    fireEvent.change(screen.getByLabelText("Contraseña"), {
      target: { value: TEST_ADMIN.password },
    });
    fireEvent.click(screen.getByRole("button", { name: "Entrar" }));
  }

  it("tras la contraseña pide el código; uno malo dice por qué y el bueno entra", async () => {
    const h = harness({ session: "none" });
    await withTotp(h);
    h.renderApp("/propiedades");
    expect(await screen.findByRole("heading", { name: "Entrar" })).toBeTruthy();
    await enterPassword();

    const code = await screen.findByLabelText("Código");
    fireEvent.change(code, { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Verificar" }));
    expect((await screen.findByRole("alert")).textContent).toContain("El código no es correcto");

    fireEvent.change(screen.getByLabelText("Código"), { target: { value: nowCode() } });
    fireEvent.click(screen.getByRole("button", { name: "Verificar" }));
    expect(await screen.findByRole("heading", { name: "Propiedades" })).toBeTruthy();
  });

  it("Volver a la contraseña deja el primer paso", async () => {
    const h = harness({ session: "none" });
    await withTotp(h);
    h.renderApp("/entrar");
    await enterPassword();
    await screen.findByLabelText("Código");

    fireEvent.click(screen.getByRole("button", { name: "Volver a la contraseña" }));
    expect(screen.getByLabelText("Contraseña")).toBeTruthy();
    expect(screen.queryByLabelText("Código")).toBeNull();
  });
});

// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "../api/client.js";
import { ErrorAlert } from "./ErrorAlert.js";
import { ErrorLine } from "./ErrorLine.js";
import { ERROR_MESSAGES, errorLineText, errorTextOf, GENERIC_ERROR } from "./error-messages.js";

// F5-T13: lo que `ErrorAlert` dice de los errores de Marketplace.

afterEach(cleanup);

const PUBLICATION_ID = "7f1c2a4e-9b3d-4f6a-8c2e-1d5b9a7e3f10";

describe("ErrorAlert · Marketplace", () => {
  it("MANUAL_CONFIRM_PENDING con la publicación: los dos comandos para cerrarla", () => {
    render(
      <ErrorAlert
        error={
          new ApiError(
            "MANUAL_CONFIRM_PENDING: espera",
            "MANUAL_CONFIRM_PENDING",
            409,
            undefined,
            PUBLICATION_ID,
          )
        }
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(
      `pbpaste | pnpm -s cli publications confirm ${PUBLICATION_ID} --url-stdin`,
    );
    expect(alert.textContent).toContain(`pnpm -s cli publications not-published ${PUBLICATION_ID}`);
  });

  it("sin la publicación, solo la sugerencia", () => {
    render(<ErrorAlert error={new ApiError("x", "MARKETPLACE_FORM_OPEN", 409)} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Primero di si se publicó");
    expect(alert.textContent).not.toContain("publications confirm");
  });

  it("MARKETPLACE_NOT_READY lista lo que falta con su encabezado y qué hacer", () => {
    render(
      <ErrorAlert
        error={
          new ApiError("MARKETPLACE_NOT_READY: falta", "MARKETPLACE_NOT_READY", 409, [
            { code: "MARKETPLACE_PHOTOS_MISSING", field: null, message: "Faltan fotos" },
            { code: "MARKETPLACE_FIELD_MISSING", field: "banos", message: "Falta baños" },
          ])
        }
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Falta información para publicar en Marketplace:");
    expect(alert.textContent).toContain("Falta baños (banos)");
    expect(alert.textContent).toContain("Complétalo en la planilla");
    expect(alert.textContent).toContain("prepara el contenido");
  });

  it("MARKETPLACE_DAILY_LIMIT: sigue mañana", () => {
    render(<ErrorAlert error={new ApiError("x", "MARKETPLACE_DAILY_LIMIT", 409)} />);
    expect(screen.getByRole("alert").textContent).toContain("sigue mañana");
  });
});

// F9.5-T16: los campos de la marca que no sirven (`BROKER_INVALID`) no son de una plataforma.
describe("ErrorAlert · la marca", () => {
  it("BROKER_INVALID con issues: el mensaje, sin el encabezado de Portal", () => {
    render(
      <ErrorAlert
        error={
          new ApiError(
            "La hoja Corredor tiene valores que no sirven: Color primario: «azul» no es un color HEX (#RRGGBB)",
            "BROKER_INVALID",
            400,
            [
              {
                code: "BROKER_FIELD_INVALID",
                field: "primaryColor",
                message: "Color primario: «azul» no es un color HEX (#RRGGBB)",
              },
            ],
          )
        }
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Color primario: «azul» no es un color HEX");
    expect(alert.textContent).not.toContain("Falta información para publicar");
  });
});

describe("ErrorAlert · en simple (F9.5-T20)", () => {
  it("ACCOUNT_NOT_CONNECTED y USER_EMAIL_TAKEN: el mensaje en simple y el código chico al final", () => {
    const { rerender } = render(
      <ErrorAlert
        error={
          new ApiError(
            "ACCOUNT_NOT_CONNECTED: No hay una cuenta conectada…",
            "ACCOUNT_NOT_CONNECTED",
            409,
          )
        }
      />,
    );
    let alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Conecta tu cuenta en Cuentas para poder publicar.");
    expect(alert.textContent).not.toContain("ACCOUNT_NOT_CONNECTED:");
    expect(alert.textContent).not.toContain("No hay una cuenta conectada");
    expect(alert.textContent).toContain("código: ACCOUNT_NOT_CONNECTED");

    rerender(
      <ErrorAlert
        error={
          new ApiError(
            "USER_EMAIL_TAKEN: Ya existe un usuario con ese correo",
            "USER_EMAIL_TAKEN",
            409,
          )
        }
      />,
    );
    alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Ese correo ya tiene un usuario en AgentSales.");
    expect(alert.textContent).not.toContain("USER_EMAIL_TAKEN:");
  });

  it("un código que no está en el mapa: mensaje general, el de la API debajo y el código al final", () => {
    render(
      <ErrorAlert error={new ApiError("COSA_RARA: El dato tal no sirve", "COSA_RARA", 400)} />,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(GENERIC_ERROR);
    expect(alert.textContent).toContain("El dato tal no sirve");
    expect(alert.textContent).not.toContain("COSA_RARA:");
    expect(alert.textContent).toMatch(/código: COSA_RARA$/);
  });

  it("un error sin código muestra su mensaje y nada más", () => {
    render(<ErrorAlert error={new Error("algo se cortó")} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("algo se cortó");
    expect(alert.textContent).not.toContain("código:");
  });

  it("recorre el mapa: ningún código sale pelado, todos con su explicación y su código al final", () => {
    for (const [code, message] of Object.entries(ERROR_MESSAGES)) {
      // Una frase en simple: sin el código técnico ni MAYÚSCULAS_CON_GUION.
      expect(message, code).not.toContain(code);
      expect(message, code).not.toMatch(/[A-Z]{2,}_[A-Z_]+/);
      expect(message.trim().length, code).toBeGreaterThan(10);
      cleanup();
      render(<ErrorAlert error={new ApiError(`${code}: texto técnico de la API`, code, 409)} />);
      const text = screen.getByRole("alert").textContent ?? "";
      expect(text, code).toContain(message);
      expect(text, code).not.toContain(`${code}: `);
      expect(text, code).not.toContain("texto técnico de la API");
      expect(text, code).toContain(`código: ${code}`);
    }
  });
});

describe("los errores guardados fuera de ErrorAlert (F9.5-T20)", () => {
  // `ErrorLine` y `errorLineText` muestran el `last_error` de una publicación, el de una corrida y
  // el de un intento (Seguimiento, Contenido, los eventos y los posts).
  it("recorre el mapa: la frase simple con el código chico al final, sin el mensaje técnico", () => {
    for (const [code, message] of Object.entries(ERROR_MESSAGES)) {
      const stored = { code, message: "texto técnico guardado" };
      expect(errorTextOf(stored), code).toEqual({ title: message, detail: null, code });
      expect(errorLineText(stored), code).toBe(`${message} (código: ${code})`);
      cleanup();
      render(
        <p data-testid="linea">
          <ErrorLine error={stored} />
        </p>,
      );
      const text = screen.getByTestId("linea").textContent ?? "";
      expect(text, code).toBe(`${message}(código: ${code})`);
    }
  });

  it("un código fuera del mapa: el mensaje guardado (ya está en español) y el código al final", () => {
    const stored = { code: "IG_MEDIA_REJECTED", message: "Instagram rechazó una imagen" };
    expect(errorLineText(stored)).toBe("Instagram rechazó una imagen (código: IG_MEDIA_REJECTED)");
    render(
      <p data-testid="linea">
        <ErrorLine error={stored} />
      </p>,
    );
    expect(screen.getByTestId("linea").textContent).toBe(
      "Instagram rechazó una imagen(código: IG_MEDIA_REJECTED)",
    );
  });

  it("un mensaje con el código por delante no lo repite", () => {
    expect(errorLineText({ code: "COSA_RARA", message: "COSA_RARA: el dato no sirve" })).toBe(
      `${GENERIC_ERROR} el dato no sirve (código: COSA_RARA)`,
    );
  });

  it("ACCOUNT_NOT_CONNECTED trae el enlace a Cuentas en el mismo aviso", () => {
    render(
      <ErrorAlert error={new ApiError("ACCOUNT_NOT_CONNECTED: x", "ACCOUNT_NOT_CONNECTED", 409)} />,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent?.match(/Conecta tu cuenta/g)).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Ir a Cuentas" }).getAttribute("href")).toBe(
      "/cuentas",
    );
  });
});

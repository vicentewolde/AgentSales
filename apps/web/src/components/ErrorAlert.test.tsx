// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "../api/client.js";
import { ErrorAlert } from "./ErrorAlert.js";

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

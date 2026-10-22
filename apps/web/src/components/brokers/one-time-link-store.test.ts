// @vitest-environment jsdom
import type { UserLinkResponse } from "@agentsales/api/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearAllOneTimeLinks,
  clearOneTimeLink,
  loadOneTimeLink,
  ONE_TIME_LINK_KEEP_MS,
  saveOneTimeLink,
} from "./one-time-link-store.js";

// F9.5-T20: el enlace de invitación vive solo en sessionStorage, con su vencimiento, y todo el
// acceso al almacenamiento es a prueba de fallos.

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  localStorage.clear();
});

const NOW = new Date("2026-10-23T12:00:00Z");

const link = (expiresAt: Date): UserLinkResponse => ({
  user: {
    id: "u-1",
    email: "ana@ejemplo.cl",
    name: "Ana",
    role: "broker",
    brokerId: "b-1",
    hasPassword: false,
    disabled: false,
    locked: false,
    lastLoginAt: null,
    totpEnabled: false,
  },
  invitationUrl: "https://panel.ejemplo.cl/invitacion#secreto-de-prueba",
  expiresAt,
});

const inTwoHours = new Date(NOW.getTime() + 2 * 60 * 60 * 1000);

describe("el enlace guardado", () => {
  it("se guarda en sessionStorage y vuelve igual, con su fecha, mientras no venza", () => {
    saveOneTimeLink("b-1", { link: link(inTwoHours), kind: "reset" }, NOW);

    const loaded = loadOneTimeLink("b-1", NOW);
    expect(loaded?.kind).toBe("reset");
    expect(loaded?.link.invitationUrl).toBe(
      "https://panel.ejemplo.cl/invitacion#secreto-de-prueba",
    );
    expect(loaded?.link.expiresAt).toEqual(inTwoHours);
    // Nunca en localStorage.
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(1);
  });

  it("guardado, dura como mucho 2 horas aunque la invitación venza después", () => {
    const inThreeDays = new Date(NOW.getTime() + 72 * 60 * 60 * 1000);
    saveOneTimeLink("b-1", { link: link(inThreeDays), kind: "invitation" }, NOW);

    expect(
      loadOneTimeLink("b-1", new Date(NOW.getTime() + ONE_TIME_LINK_KEEP_MS - 1)),
    ).not.toBeNull();
    expect(loadOneTimeLink("b-1", new Date(NOW.getTime() + ONE_TIME_LINK_KEEP_MS))).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  it("es de cada corredor", () => {
    saveOneTimeLink("b-1", { link: link(inTwoHours), kind: "invitation" }, NOW);
    expect(loadOneTimeLink("b-2", NOW)).toBeNull();
  });

  it("uno vencido no vuelve y se borra", () => {
    saveOneTimeLink("b-1", { link: link(inTwoHours), kind: "invitation" }, NOW);
    const later = new Date(inTwoHours.getTime() + 1);
    expect(loadOneTimeLink("b-1", later)).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  it("uno ilegible o con otra forma no vuelve y se borra", () => {
    sessionStorage.setItem("agentsales.enlace-unico.b-1", "no es json");
    expect(loadOneTimeLink("b-1", NOW)).toBeNull();
    expect(sessionStorage.length).toBe(0);

    sessionStorage.setItem("agentsales.enlace-unico.b-1", JSON.stringify({ link: { x: 1 } }));
    expect(loadOneTimeLink("b-1", NOW)).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  it("clearOneTimeLink borra el de un corredor y clearAllOneTimeLinks todos, sin tocar lo demás", () => {
    saveOneTimeLink("b-1", { link: link(inTwoHours), kind: "invitation" }, NOW);
    saveOneTimeLink("b-2", { link: link(inTwoHours), kind: "invitation" }, NOW);
    sessionStorage.setItem("otra-cosa", "x");

    clearOneTimeLink("b-1");
    expect(loadOneTimeLink("b-1", NOW)).toBeNull();
    expect(loadOneTimeLink("b-2", NOW)).not.toBeNull();

    clearAllOneTimeLinks();
    expect(loadOneTimeLink("b-2", NOW)).toBeNull();
    expect(sessionStorage.getItem("otra-cosa")).toBe("x");
  });

  it("si el almacenamiento falla (ventana privada, datos bloqueados), nada lanza", () => {
    const boom = () => {
      throw new DOMException("bloqueado", "SecurityError");
    };
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(boom);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(boom);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(boom);
    vi.spyOn(Storage.prototype, "key").mockImplementation(boom);

    expect(() =>
      saveOneTimeLink("b-1", { link: link(inTwoHours), kind: "invitation" }, NOW),
    ).not.toThrow();
    expect(loadOneTimeLink("b-1", NOW)).toBeNull();
    expect(() => clearOneTimeLink("b-1")).not.toThrow();
    expect(() => clearAllOneTimeLinks()).not.toThrow();
  });
});

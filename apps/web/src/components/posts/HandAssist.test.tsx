// @vitest-environment jsdom
import type { ContentMedia } from "@agentsales/api/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HandAssist } from "./HandAssist.js";
import { handOpenTarget, X_COMPOSE_URL, X_SHARE_URL_MAX } from "./hand.js";
import {
  confirmedWithoutLink,
  LINKEDIN_EDITOR_URL,
  LINKEDIN_SHARE_URL_MAX,
  linkedinDownloads,
  linkedinOpenTarget,
} from "./linkedin.js";

// LinkedIn a mano al mínimo trabajo (F9.5): el botón abre el editor con el texto ya puesto (un
// enlace normal) y lo copia de respaldo; con un texto largo abre vacío; los medios se bajan; y se
// reconoce lo confirmado sin enlace. Sin red y sin navegador real.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const media = (extra: Partial<ContentMedia>): ContentMedia => ({
  id: "m1",
  variant: "ig_4x5",
  mime: "image/jpeg",
  width: 1080,
  height: 1350,
  durationS: null,
  url: "https://r2.test/ig_4x5.jpg?firma",
  ...extra,
});

describe("linkedinOpenTarget", () => {
  it("abre el editor con el texto codificado (saltos de línea, hashtags y tildes)", () => {
    const text = "Hola: ¿qué tal?\n\n#agentpey";
    const target = linkedinOpenTarget(text);
    expect(target).toEqual({
      href: `https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent(text)}`,
      withText: true,
    });
    expect(target.href).toContain("%0A%0A%23agentpey");
  });

  it("con un enlace de más de 1.800 caracteres abre el editor vacío y no lleva el texto", () => {
    const long = "a".repeat(LINKEDIN_SHARE_URL_MAX);
    expect(linkedinOpenTarget(long)).toEqual({ href: LINKEDIN_EDITOR_URL, withText: false });
    // Justo en el borde: el enlace entero mide 1.800 y todavía lleva el texto.
    const base = linkedinOpenTarget("").href.length;
    const edge = linkedinOpenTarget("a".repeat(LINKEDIN_SHARE_URL_MAX - base));
    expect(edge.withText).toBe(true);
    expect(edge.href.length).toBe(LINKEDIN_SHARE_URL_MAX);
    expect(linkedinOpenTarget("a".repeat(LINKEDIN_SHARE_URL_MAX - base + 1)).withText).toBe(false);
  });
});

describe("linkedinDownloads", () => {
  it("toma los medios de la publicación tal cual, en su orden, y distingue foto de video", () => {
    const downloads = linkedinDownloads([
      media({ id: "a", url: "https://r2.test/a.jpg?firma" }),
      media({
        id: "v",
        variant: "ig_reel",
        mime: "video/mp4",
        url: "https://r2.test/reel.mp4?firma",
      }),
    ]);
    expect(downloads).toEqual([
      { id: "a", kind: "image", url: "https://r2.test/a.jpg?firma" },
      { id: "v", kind: "video", url: "https://r2.test/reel.mp4?firma" },
    ]);
    expect(linkedinDownloads([])).toEqual([]);
  });
});

describe("confirmedWithoutLink", () => {
  const base = {
    platform: "linkedin",
    status: "published",
    dryRun: false,
    externalUrl: null,
  } as const;

  it("LinkedIn publicada en vivo sin enlace", () => {
    expect(confirmedWithoutLink(base)).toBe(true);
    expect(confirmedWithoutLink({ ...base, externalUrl: "https://www.linkedin.com/x" })).toBe(
      false,
    );
    expect(confirmedWithoutLink({ ...base, dryRun: true })).toBe(false);
    expect(confirmedWithoutLink({ ...base, status: "awaiting_manual_confirm" })).toBe(false);
    expect(confirmedWithoutLink({ ...base, platform: "tiktok" })).toBe(false);
  });
});

describe("HandAssist · LinkedIn", () => {
  const clipboard = () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    return writeText;
  };

  it("abre el editor con el texto puesto en otra pestaña y lo copia de respaldo", async () => {
    const writeText = clipboard();
    render(
      <HandAssist
        platform="linkedin"
        content={{ body: "Hola LinkedIn", hashtags: ["#agentpey"] }}
      />,
    );
    const link = screen.getByRole("link", { name: "Copiar texto y abrir LinkedIn" });
    expect(link.getAttribute("href")).toBe(
      `https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent("Hola LinkedIn\n\n#agentpey")}`,
    );
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    fireEvent.click(link);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Hola LinkedIn\n\n#agentpey"));
    expect(
      await screen.findByText(/Texto copiado también por si LinkedIn no lo trae/),
    ).toBeTruthy();
    // Los tres pasos, en simple.
    expect(
      screen.getByRole("region", { name: "Publicar en LinkedIn a mano" }).textContent,
    ).toContain("3. Vuelve y toca «Ya lo publiqué»");
  });

  it("un texto muy largo abre el editor vacío, lo dice y lo deja en el portapapeles", async () => {
    const writeText = clipboard();
    const body = "palabra ".repeat(400);
    render(<HandAssist platform="linkedin" content={{ body, hashtags: [] }} />);
    const link = screen.getByRole("link", { name: "Copiar texto y abrir LinkedIn" });
    expect(link.getAttribute("href")).toBe(LINKEDIN_EDITOR_URL);
    expect(screen.getByText(/El texto es largo para ir en el enlace/)).toBeTruthy();
    fireEvent.click(link);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(body));
    expect(await screen.findByText(/pégalo en el editor de LinkedIn/)).toBeTruthy();
  });

  it("si el portapapeles falla, lo dice (el texto igual viaja en el enlace)", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn(async () => Promise.reject(new Error("no"))) },
      configurable: true,
    });
    render(<HandAssist platform="linkedin" content={{ body: "Hola", hashtags: [] }} />);
    fireEvent.click(screen.getByRole("button", { name: "Solo copiar el texto" }));
    expect(await screen.findByText(/No se pudo copiar/)).toBeTruthy();
  });

  it("con imágenes: «Descargar imágenes», la foto procesada arrastrable y un enlace que abre en otra pestaña", () => {
    const downloads = linkedinDownloads([
      media({ id: "a", url: "https://r2.test/a.jpg?firma" }),
      media({ id: "b", url: "https://r2.test/b.jpg?firma" }),
    ]);
    render(
      <HandAssist
        platform="linkedin"
        content={{ body: "Hola", hashtags: [] }}
        downloads={downloads}
      />,
    );
    const group = screen.getByRole("group", { name: "Descargar imágenes" });
    const images = within(group).getAllByRole("img");
    expect(images).toHaveLength(2);
    // Se arrastra la foto procesada (la misma que se enviaría), no una miniatura.
    expect(images[0]?.getAttribute("src")).toBe("https://r2.test/a.jpg?firma");
    expect(images[0]?.getAttribute("draggable")).toBe("true");
    const first = within(group).getByRole("link", { name: "Descargar imagen 1" });
    expect(first.getAttribute("href")).toBe("https://r2.test/a.jpg?firma");
    expect(first.getAttribute("target")).toBe("_blank");
    expect(first.hasAttribute("download")).toBe(false);
    expect(group.textContent).toContain("Guardar imagen como");
    expect(within(group).getByRole("link", { name: "Descargar imagen 2" })).toBeTruthy();
  });

  it("un video: enlace para abrirlo y guardarlo, sin arrastre ni miniatura", () => {
    const downloads = linkedinDownloads([
      media({ id: "v", variant: "ig_reel", mime: "video/mp4", url: "https://r2.test/r.mp4?firma" }),
    ]);
    render(
      <HandAssist
        platform="linkedin"
        content={{ body: "Hola", hashtags: [] }}
        downloads={downloads}
      />,
    );
    const group = screen.getByRole("group", { name: "Descargar imágenes" });
    expect(within(group).queryByRole("img")).toBeNull();
    expect(group.textContent).not.toContain("arrastra");
    expect(within(group).getByRole("link", { name: "Descargar video" })).toBeTruthy();
  });

  it("sin medios no hay descargas; una sola imagen dice «Descargar imagen»", () => {
    const { rerender } = render(
      <HandAssist platform="linkedin" content={{ body: "Hola", hashtags: [] }} />,
    );
    expect(screen.queryByRole("group", { name: "Descargar imágenes" })).toBeNull();
    rerender(
      <HandAssist
        platform="linkedin"
        content={{ body: "Hola", hashtags: [] }}
        downloads={linkedinDownloads([media({})])}
      />,
    );
    expect(screen.getByRole("link", { name: "Descargar imagen" })).toBeTruthy();
  });

  it("sin el texto avisa que no lo encontró, sin botón de copiar", () => {
    render(<HandAssist platform="linkedin" content={undefined} />);
    expect(screen.getByRole("status").textContent).toContain(
      "No encontré el texto aprobado de esta publicación",
    );
    expect(screen.queryByRole("link", { name: "Copiar texto y abrir LinkedIn" })).toBeNull();
  });
});

describe("handOpenTarget (F9.6)", () => {
  it("LinkedIn es el de LinkedIn; X abre el editor de X con el texto codificado; Instagram no tiene enlace", () => {
    const text = "Hola: ¿qué tal?\n\n#agentpey";
    expect(handOpenTarget("linkedin", text)).toEqual(linkedinOpenTarget(text));
    expect(handOpenTarget("x", text)).toEqual({
      href: `${X_COMPOSE_URL}?text=${encodeURIComponent(text)}`,
      withText: true,
    });
    expect(handOpenTarget("instagram", text)).toEqual({ href: null, withText: false });
  });

  it("X con un enlace de más de 1.800 caracteres abre el editor vacío", () => {
    const base = handOpenTarget("x", "").href?.length ?? 0;
    const edge = handOpenTarget("x", "a".repeat(X_SHARE_URL_MAX - base));
    expect(edge.withText).toBe(true);
    expect(edge.href?.length).toBe(X_SHARE_URL_MAX);
    expect(handOpenTarget("x", "a".repeat(X_SHARE_URL_MAX - base + 1))).toEqual({
      href: X_COMPOSE_URL,
      withText: false,
    });
  });
});

describe("HandAssist · X e Instagram (F9.6, ADR-0041)", () => {
  const clipboard = () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    return writeText;
  };

  it("X: «Copiar texto y abrir X» abre el editor con el texto puesto y lo copia de respaldo", async () => {
    const writeText = clipboard();
    render(<HandAssist platform="x" content={{ body: "Hola X", hashtags: [] }} />);
    const link = screen.getByRole("link", { name: "Copiar texto y abrir X" });
    expect(link.getAttribute("href")).toBe(`${X_COMPOSE_URL}?text=${encodeURIComponent("Hola X")}`);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    fireEvent.click(link);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Hola X"));
    expect(await screen.findByText(/Texto copiado también por si X no lo trae/)).toBeTruthy();
    expect(screen.getByRole("region", { name: "Publicar en X a mano" }).textContent).toContain(
      "3. Vuelve y toca «Ya lo publiqué»",
    );
  });

  it("Instagram: solo «Copiar texto» (sin enlace), con las imágenes para bajar", async () => {
    const writeText = clipboard();
    const downloads = linkedinDownloads([
      media({ id: "a", url: "https://r2.test/a.jpg?firma" }),
      media({ id: "b", url: "https://r2.test/b.jpg?firma" }),
    ]);
    render(
      <HandAssist
        platform="instagram"
        content={{ body: "Hola Instagram", hashtags: ["#agentpey"] }}
        downloads={downloads}
      />,
    );
    // No hay enlace que abra Instagram con nada puesto.
    expect(screen.queryByRole("link", { name: /Copiar texto y abrir/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copiar texto" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Hola Instagram\n\n#agentpey"));
    expect(await screen.findByText(/pégalo en la descripción de Instagram/)).toBeTruthy();
    const region = screen.getByRole("region", { name: "Publicar en Instagram a mano" });
    expect(region.textContent).toContain("Abre Instagram, crea la publicación");
    const group = within(region).getByRole("group", { name: "Descargar imágenes" });
    expect(within(group).getByRole("link", { name: "Descargar imagen 2" })).toBeTruthy();
    expect(group.textContent).toContain("Instagram no las trae solas");
  });

  it("sin el texto avisa en qué red publicarlo a mano", () => {
    render(<HandAssist platform="instagram" content={undefined} />);
    expect(screen.getByRole("status").textContent).toContain("publícalo a mano en Instagram");
  });
});

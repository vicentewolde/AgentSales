// @vitest-environment jsdom
import type { PostMediaItem } from "@agentsales/api/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LinkedInAssist } from "./LinkedInAssist.js";
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

const media = (extra: Partial<PostMediaItem>): PostMediaItem => ({
  id: "m1",
  kind: "image",
  mime: "image/jpeg",
  bytes: 10,
  sortOrder: 0,
  isCover: false,
  url: "https://r2.test/original.jpg?firma",
  thumbUrl: "https://r2.test/thumb.jpg?firma",
  width: 1080,
  height: 1350,
  durationS: null,
  variants: ["thumb", "ig_4x5"],
  downloadUrl: "https://r2.test/ig_4x5.jpg?firma",
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
  it("un post de imagen o carrusel: todas las fotos procesadas, en orden; las sin procesar no entran", () => {
    const items = [
      media({ id: "a", sortOrder: 0 }),
      media({ id: "v", kind: "video", downloadUrl: "https://r2.test/reel.mp4?firma" }),
      media({ id: "b", sortOrder: 1, downloadUrl: null }),
      media({ id: "c", sortOrder: 2 }),
    ];
    expect(linkedinDownloads(items, "carousel").map((item) => item.id)).toEqual(["a", "c"]);
    expect(linkedinDownloads(items, "image").map((item) => item.id)).toEqual(["a", "c"]);
  });

  it("un post de video: solo el primer video procesado; un texto solo, ninguno", () => {
    const items = [
      media({ id: "a" }),
      media({ id: "v1", kind: "video", downloadUrl: "https://r2.test/1.mp4?firma" }),
      media({ id: "v2", kind: "video", downloadUrl: "https://r2.test/2.mp4?firma" }),
    ];
    expect(linkedinDownloads(items, "video").map((item) => item.id)).toEqual(["v1"]);
    expect(linkedinDownloads(items, "text")).toEqual([]);
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

describe("LinkedInAssist", () => {
  const clipboard = () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    return writeText;
  };

  it("abre el editor con el texto puesto en otra pestaña y lo copia de respaldo", async () => {
    const writeText = clipboard();
    render(<LinkedInAssist content={{ body: "Hola LinkedIn", hashtags: ["#agentpey"] }} />);
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
    render(<LinkedInAssist content={{ body, hashtags: [] }} />);
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
    render(<LinkedInAssist content={{ body: "Hola", hashtags: [] }} />);
    fireEvent.click(screen.getByRole("button", { name: "Solo copiar el texto" }));
    expect(await screen.findByText(/No se pudo copiar/)).toBeTruthy();
  });

  it("con imágenes: «Descargar imágenes» con su miniatura y un enlace de descarga por imagen", () => {
    const downloads = linkedinDownloads(
      [
        media({ id: "a", downloadUrl: "https://r2.test/a.jpg?firma" }),
        media({ id: "b", downloadUrl: "https://r2.test/b.jpg?firma" }),
      ],
      "carousel",
    );
    render(<LinkedInAssist content={{ body: "Hola", hashtags: [] }} downloads={downloads} />);
    const group = screen.getByRole("group", { name: "Descargar imágenes" });
    expect(within(group).getAllByRole("img")).toHaveLength(2);
    const first = within(group).getByRole("link", { name: "Descargar imagen 1" });
    expect(first.getAttribute("href")).toBe("https://r2.test/a.jpg?firma");
    expect(first.hasAttribute("download")).toBe(true);
    expect(within(group).getByRole("link", { name: "Descargar imagen 2" })).toBeTruthy();
  });

  it("sin medios no hay descargas; una sola imagen dice «Descargar imagen»", () => {
    const { rerender } = render(<LinkedInAssist content={{ body: "Hola", hashtags: [] }} />);
    expect(screen.queryByRole("group", { name: "Descargar imágenes" })).toBeNull();
    rerender(
      <LinkedInAssist
        content={{ body: "Hola", hashtags: [] }}
        downloads={linkedinDownloads([media({})], "image")}
      />,
    );
    expect(screen.getByRole("link", { name: "Descargar imagen" })).toBeTruthy();
  });

  it("sin el texto avisa que no lo encontró, sin botón de copiar", () => {
    render(<LinkedInAssist content={undefined} />);
    expect(screen.getByRole("status").textContent).toContain(
      "No encontré el texto aprobado de esta publicación",
    );
    expect(screen.queryByRole("link", { name: "Copiar texto y abrir LinkedIn" })).toBeNull();
  });
});

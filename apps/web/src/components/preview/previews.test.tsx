// @vitest-environment jsdom
import type { PostMediaItem } from "@agentsales/api/contracts";
import type { PostKind, PostPlatform } from "@agentsales/core";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MarketplacePreview } from "./MarketplacePreview.js";
import { PortalPreview } from "./PortalPreview.js";
import { PostPreview } from "./PostPreview.js";

// F9.5-T07: cada red con su forma (D5): el texto como se envía y cortado donde la red lo corta, la
// cuenta y los medios que lleva.

afterEach(cleanup);

const item = (id: string, kind: "image" | "video"): PostMediaItem => ({
  id,
  kind,
  mime: kind === "image" ? "image/jpeg" : "video/mp4",
  bytes: 10,
  sortOrder: 0,
  isCover: false,
  url: `https://r2.example/${id}`,
  thumbUrl: `https://r2.example/${id}-thumb.jpg`,
  width: null,
  height: null,
  durationS: null,
  variants: kind === "image" ? ["thumb", "ig_4x5"] : ["thumb", "ig_reel", "x_video"],
  cardLanguages: null,
});

const images = ["i1", "i2", "i3", "i4", "i5"].map((id) => item(id, "image"));
const video = item("v1", "video");

const LONG = `${"Una idea concreta sobre cómo trabajamos. ".repeat(8).trim()}`;

function preview(
  platform: PostPlatform,
  kind: PostKind,
  text: { body: string; hashtags: string[] },
  media: readonly PostMediaItem[] = [...images, video],
) {
  render(
    <PostPreview
      label={`Vista previa de ${platform}`}
      platform={platform}
      kind={kind}
      media={media}
      language="es"
      text={text}
      accountName="@marca"
    />,
  );
  return screen.getByRole("figure", { name: `Vista previa de ${platform}` });
}

const srcs = (figure: HTMLElement) =>
  within(figure)
    .getAllByRole("img")
    .map((img) => img.getAttribute("src"));

describe("vista previa por red", () => {
  it("Instagram, carrusel: la cuenta, las imágenes con su indicador y el caption con «… más»", () => {
    const figure = preview("instagram", "carousel", { body: LONG, hashtags: ["#equipo"] });
    // En la cabecera y antes del caption.
    expect(within(figure).getAllByText("@marca")).toHaveLength(2);
    const carousel = within(figure).getByRole("list", { name: "Carrusel de Instagram" });
    expect(within(carousel).getAllByRole("img")).toHaveLength(5);
    expect(within(figure).getByText("1/5")).toBeTruthy();
    const caption = within(figure).getByRole("region", { name: "Caption de Instagram" });
    // 125 caracteres visibles y «… más»; los hashtags quedan para después.
    expect(caption.textContent).toBe(`@marca ${LONG.slice(0, 125).trimEnd()}… más`);
    const more = within(caption).getByRole("button", { name: "más: mostrar el caption completo" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    expect(caption.textContent).toBe(`@marca ${LONG}\n\n#equipo ver menos`);
  });

  it("Instagram, imagen: una sola foto; de video, el reel vertical", () => {
    const image = preview("instagram", "image", { body: "Hola", hashtags: [] });
    expect(srcs(image)).toEqual(["https://r2.example/i1-thumb.jpg"]);
    expect(within(image).queryByRole("list", { name: "Carrusel de Instagram" })).toBeNull();
    cleanup();
    const reel = preview("instagram", "video", { body: "Hola", hashtags: [] });
    expect(within(reel).getByRole("img", { name: "Reel de Instagram" })).toBeTruthy();
    expect(within(reel).getByText("Hola")).toBeTruthy();
    cleanup();
    preview("instagram", "text", { body: "Hola", hashtags: [] });
    expect(screen.getByRole("note").textContent).toBe("Instagram necesita una imagen o un video.");
  });

  it("la vista previa de un texto muestra las tarjetas de su idioma, no las del otro", () => {
    const card = (id: string, cardLanguages: PostMediaItem["cardLanguages"]) => ({
      ...item(id, "image"),
      cardLanguages,
    });
    const cards = [card("es1", ["es"]), card("es2", ["es"]), card("en1", ["en"])];
    const figure = preview("instagram", "carousel", { body: "Hola", hashtags: [] }, cards);
    expect(srcs(figure)).toEqual([
      "https://r2.example/es1-thumb.jpg",
      "https://r2.example/es2-thumb.jpg",
    ]);
    cleanup();
    render(
      <PostPreview
        label="Vista previa en inglés"
        platform="x"
        kind="carousel"
        media={cards}
        language="en"
        text={{ body: "Hello", hashtags: [] }}
        accountName="@marca"
      />,
    );
    expect(srcs(screen.getByRole("figure", { name: "Vista previa en inglés" }))).toEqual([
      "https://r2.example/en1-thumb.jpg",
    ]);
  });

  it("X: el texto entero con los hashtags y hasta 4 imágenes en grilla", () => {
    const figure = preview("x", "carousel", { body: LONG, hashtags: ["#equipo"] });
    expect(within(figure).getByText(`${LONG} #equipo`)).toBeTruthy();
    expect(within(figure).queryByRole("button")).toBeNull();
    expect(srcs(figure)).toEqual(images.slice(0, 4).map((image) => image.thumbUrl));
    cleanup();
    const withVideo = preview("x", "video", { body: "Mira", hashtags: [] });
    expect(within(withVideo).getByRole("img", { name: "Video del post en X" })).toBeTruthy();
  });

  it("LinkedIn: el texto cortado con «…ver más» y las imágenes, con +N si son más de 4", () => {
    const figure = preview("linkedin", "carousel", { body: LONG, hashtags: ["#equipo"] });
    const more = within(figure).getByRole("button", { name: "ver más: mostrar el texto completo" });
    const text = more.parentElement;
    expect(text?.textContent).toBe(`${LONG.slice(0, 210).trimEnd()}…ver más`);
    fireEvent.click(more);
    expect(text?.textContent).toBe(`${LONG}\n\n#equipo ver menos`);
    expect(
      within(figure)
        .getByRole("button", { name: "ver menos: acortar el texto" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(within(figure).getAllByRole("img")).toHaveLength(4);
    expect(within(figure).getByText("+1")).toBeTruthy();
  });

  it("LinkedIn: los caracteres que LinkedIn escapa se ven sin escapar", () => {
    const figure = preview("linkedin", "text", {
      body: "Precio (sin IVA) para @equipo",
      hashtags: [],
    });
    expect(within(figure).getByText("Precio (sin IVA) para @equipo")).toBeTruthy();
    expect(within(figure).queryByRole("img")).toBeNull();
  });

  it("Discord: el nombre del webhook, el texto sin hashtags y los adjuntos", () => {
    const figure = preview("discord", "carousel", { body: "Novedades", hashtags: ["#equipo"] });
    expect(within(figure).getByText("@marca")).toBeTruthy();
    expect(within(figure).getByText("APP")).toBeTruthy();
    expect(within(figure).getByText("Novedades")).toBeTruthy();
    expect(figure.textContent).not.toContain("#equipo");
    expect(within(figure).getAllByRole("img", { name: /Imagen adjunta/ })).toHaveLength(5);
  });

  it("TikTok: el video vertical, y el texto aparte porque va como borrador", () => {
    const figure = preview("tiktok", "video", {
      body: "Un día en la oficina",
      hashtags: ["#equipo"],
    });
    expect(within(figure).getByRole("img", { name: "Video para TikTok" })).toBeTruthy();
    expect(
      within(figure).getByText(/TikTok no recibe el texto: el video llega como borrador/),
    ).toBeTruthy();
    expect(within(figure).getByText("Texto para pegar en la app")).toBeTruthy();
    expect(within(figure).getByText("Un día en la oficina #equipo")).toBeTruthy();
    cleanup();
    const noVideo = preview("tiktok", "video", { body: "Hola", hashtags: [] }, images);
    expect(within(noVideo).getByText("Sin video todavía.")).toBeTruthy();
    expect(screen.queryByRole("note")).toBeNull();
    cleanup();
    // Un post de imágenes en TikTok: el publisher lo rechazaría, y se avisa.
    const image = preview("tiktok", "image", { body: "Hola", hashtags: [] });
    expect(screen.getByRole("note").textContent).toBe(
      "TikTok publica solo video: cambia el tipo del post y súbelo.",
    );
    expect(within(image).queryByRole("img")).toBeNull();
  });

  it("un medio sin la versión de la red dice «procesando…»; un carrusel de 1 se avisa", () => {
    const pending = { ...item("p1", "image"), variants: ["thumb" as const] };
    const figure = preview("instagram", "carousel", { body: "Hola", hashtags: [] }, [pending]);
    expect(within(figure).getByRole("img", { name: "Imagen del post, procesando…" })).toBeTruthy();
    expect(screen.getByRole("note").textContent).toBe(
      "Un carrusel lleva de 2 a 10 imágenes y este post tiene 1.",
    );
    cleanup();
    const reelOnly = { ...item("v2", "video"), variants: ["thumb" as const, "ig_reel" as const] };
    const x = preview("x", "video", { body: "Mira", hashtags: [] }, [reelOnly]);
    expect(within(x).getByRole("img", { name: "Video del post en X, procesando…" })).toBeTruthy();
  });

  it("el borrador sin guardar se dice en la leyenda", () => {
    render(
      <PostPreview
        label="Vista previa"
        platform="x"
        kind="text"
        media={[]}
        language="es"
        text={{ body: "Hola", hashtags: [] }}
        accountName="@marca"
        draft
      />,
    );
    expect(screen.getByRole("figure").textContent).toContain("con tu borrador, sin guardar");
  });

  const photos = [
    { id: "p1", src: "https://r2.example/p1.jpg" },
    { id: "p2", src: "https://r2.example/p2.jpg" },
  ];

  it("Portal: las fotos con la portada grande, el título, el precio y la descripción entera", () => {
    render(
      <PortalPreview
        label="Vista previa de Portal"
        title="Departamento en venta 3 dormitorios en Ñuñoa"
        price="UF 5.800"
        photos={photos}
        description={LONG}
      />,
    );
    const figure = screen.getByRole("figure", { name: "Vista previa de Portal" });
    expect(within(figure).getByRole("heading").textContent).toBe(
      "Departamento en venta 3 dormitorios en Ñuñoa",
    );
    expect(within(figure).getByText("UF 5.800")).toBeTruthy();
    expect(within(figure).getByText(LONG)).toBeTruthy();
    expect(srcs(figure)).toEqual(photos.map((photo) => photo.src));
  });

  it("Marketplace: la foto, el título con su advertencia, el precio y la descripción", () => {
    render(
      <MarketplacePreview
        label="Vista previa de Marketplace"
        title="Departamento en arriendo en Ñuñoa"
        price="$650.000/mes"
        photos={photos.slice(0, 1)}
        description="Luminoso y cerca del metro."
      />,
    );
    const figure = screen.getByRole("figure", { name: "Vista previa de Marketplace" });
    expect(within(figure).getByRole("heading").textContent).toBe(
      "Departamento en arriendo en Ñuñoa",
    );
    expect(within(figure).getByText(/no tiene título/)).toBeTruthy();
    expect(within(figure).getByText("$650.000/mes")).toBeTruthy();
    expect(within(figure).getByText("Luminoso y cerca del metro.")).toBeTruthy();
    expect(srcs(figure)).toEqual(["https://r2.example/p1.jpg"]);
  });

  it("sin fotos, Portal lo dice", () => {
    render(
      <PortalPreview label="Portal" title={null} price={null} photos={[]} description={null} />,
    );
    expect(screen.getByText("Sin fotos todavía.")).toBeTruthy();
  });
});

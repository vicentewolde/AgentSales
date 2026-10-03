import { describe, expect, it } from "vitest";
import { createInMemoryMediaProcessor } from "./media-processor.js";

const bytes = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));
async function* stream(text: string) {
  yield bytes(text);
}

describe("createInMemoryMediaProcessor", () => {
  it("las mismas entradas dan las mismas salidas, y registra las llamadas", async () => {
    const processor = createInMemoryMediaProcessor();
    const first = await processor.processImage(bytes("foto-1"), {
      mime: "image/jpeg",
      variants: ["thumb", "ig_4x5"],
    });
    const again = await processor.processImage(bytes("foto-1"), {
      mime: "image/jpeg",
      variants: ["thumb", "ig_4x5"],
    });
    const other = await processor.processImage(bytes("foto-2"), {
      mime: "image/jpeg",
      variants: ["thumb"],
    });

    expect(first.outputs.map((o) => o.sha256)).toEqual(again.outputs.map((o) => o.sha256));
    expect(first.outputs[0]?.sha256).not.toBe(other.outputs[0]?.sha256);
    expect(first.outputs.map((o) => [o.variant, o.width, o.height])).toEqual([
      ["thumb", 800, 600],
      ["ig_4x5", 1080, 1350],
    ]);
    expect(first.measurements).toEqual({ width: 2000, height: 1500, durationS: null });
    expect(processor.calls).toHaveLength(3);
  });

  it("una entrada CORRUPTO… es MEDIA_DECODE_FAILED, y con signal disparado MEDIA_ABORTED", async () => {
    const processor = createInMemoryMediaProcessor();
    await expect(
      processor.processImage(bytes("CORRUPTO"), { mime: "image/jpeg", variants: ["thumb"] }),
    ).rejects.toMatchObject({ code: "MEDIA_DECODE_FAILED" });
    const signal = { aborted: true, addEventListener() {}, removeEventListener() {} };
    await expect(
      processor.processImage(bytes("foto"), { mime: "image/jpeg", variants: ["thumb"] }, signal),
    ).rejects.toMatchObject({ code: "MEDIA_ABORTED", retriable: true });
  });

  it("un video da medidas y thumb; con reel, además un reel que se puede leer", async () => {
    const processor = createInMemoryMediaProcessor({ version: "9" });
    const plain = await processor.processVideo(stream("video-1"), { reel: null });
    const withReel = await processor.processVideo(stream("video-1"), {
      reel: { overlayPng: bytes("png") },
    });

    expect(plain.reel).toBeNull();
    expect(plain.thumb.variant).toBe("thumb");
    expect(withReel.reel).toMatchObject({ width: 1080, height: 1920, durationS: 30 });
    const chunks: Uint8Array[] = [];
    for await (const chunk of withReel.reel?.open() ?? []) chunks.push(chunk);
    expect(chunks[0]?.length).toBe(withReel.reel?.size);
    expect(processor.calls.map((call) => call.kind === "video" && call.reel)).toEqual([
      false,
      true,
    ]);
  });

  it("como el adaptador: un video de menos de 3 s no da reel, y uno de más de 90 s se corta a 90 s", async () => {
    const measure = (duration: number) => () => ({
      width: 1920,
      height: 1080,
      durationS: duration,
    });
    const reel = { overlayPng: bytes("png") };
    const short = await createInMemoryMediaProcessor({ measure: measure(2) }).processVideo(
      stream("corto"),
      { reel },
    );
    const long = await createInMemoryMediaProcessor({ measure: measure(100) }).processVideo(
      stream("largo"),
      { reel },
    );

    expect(short.reel).toBeNull();
    expect(long.reel?.durationS).toBe(90);
  });
});

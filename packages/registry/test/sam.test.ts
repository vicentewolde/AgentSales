import { describe, expect, it } from "vitest";
import { boxAreaRatio, parseSamLine, parseSamOutput } from "../src/claims/sam.js";

const line =
  "<3f>0<|box;x1=10;y1=20;x2=110;y2=220;w=1280;h=720;c=0.91|><|mask;x=0;y=0;data=46,101,~abc,def|>,4<|box;x1=1;y1=2;x2=3;y2=4;w=1280;h=720;c=0.3|><|mask;x=0;y=0;data=2,2,!zz|>";

describe("parseSamLine", () => {
  it("reads the frame marker, ids, boxes and confidence", () => {
    const f = parseSamLine(line);
    expect(f?.frame).toBe(3);
    expect(f?.objects.map((o) => o.id)).toEqual([0, 4]);
    expect(f?.objects[0]?.box).toEqual({ x1: 10, y1: 20, x2: 110, y2: 220, w: 1280, h: 720 });
    expect(f?.objects[0]?.confidence).toBe(0.91);
    expect(f?.objects[1]?.confidence).toBe(0.3);
  });

  it("keeps the raw mask token, even though its header contains commas", () => {
    expect(parseSamLine(line)?.objects[0]?.maskToken).toBe("<|mask;x=0;y=0;data=46,101,~abc,def|>");
  });

  it("works without confidence and ignores lines that are not frames", () => {
    const f = parseSamLine("<0f>7<|box;x1=0;y1=0;x2=10;y2=10;w=100;h=100|>");
    expect(f?.objects[0]?.confidence).toBeNull();
    expect(parseSamLine("hello")).toBeNull();
  });

  it("treats zero matches as a valid empty result and skips frames it cannot read", () => {
    expect(parseSamOutput("")).toEqual([]);
    expect(
      parseSamOutput(`${line}\nnot a frame\n<9f>1<|box;x1=a;y1=0;x2=1;y2=1;w=1;h=1|>`).map(
        (x) => x.frame,
      ),
    ).toEqual([3, 9]);
    expect(parseSamOutput("<9f>1<|box;x1=a;y1=0;x2=1;y2=1;w=1;h=1|>")[0]?.objects).toEqual([]);
  });

  it("computes the area share of a box", () => {
    expect(boxAreaRatio({ x1: 0, y1: 0, x2: 50, y2: 50, w: 100, h: 100 })).toBe(0.25);
  });
});

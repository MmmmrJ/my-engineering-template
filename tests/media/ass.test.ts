import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { validateAss } from "../../src/media/ass.js";

const validUrl = new URL("./fixtures/delivery-valid.ass", import.meta.url);
const invalidUrl = new URL("./fixtures/delivery-invalid.ass", import.meta.url);

describe("ASS validation", () => {
  it("parses formatted dialogue rows and preserves commas in text", async () => {
    const source = `${await readFile(validUrl, "utf8")}\nDialogue: 0,0:01:11.00,0:01:12.00,Default,,0,0,0,,最后，回家。\n`;
    const report = validateAss(source);
    expect(report.valid).toBe(true);
    expect(report.cues).toHaveLength(4);
    expect(report.cues.at(-1)?.text).toBe("最后，回家。");
    expect(report.durationMs).toBe(72_000);
  });

  it("rejects backward dialogue order", async () => {
    const report = validateAss(await readFile(invalidUrl, "utf8"));
    expect(report.valid).toBe(false);
    expect(report.errors.map((issue) => issue.code)).toContain("ass.timing.order");
  });
});

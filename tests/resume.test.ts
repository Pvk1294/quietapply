import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractResumeText } from "../src/resume/extract.js";
import { mergeProfiles, parseResumeText } from "../src/resume/parse.js";
import { minimalPdf } from "./helpers/pdf.js";

const resume = join(import.meta.dirname, "../fixtures/persona/jane-doe-resume.txt");

describe("resume parsing", () => {
  it("builds a profile from plain text", async () => {
    const text = await extractResumeText(resume);
    const p = parseResumeText(text, new Date("2026-10-26"));
    expect(p.name).toBe("Jane Doe");
    expect(p.email).toBe("jane.doe@example.com");
    expect(p.phone).toBe("+1 555 010 0199");
    expect(p.location).toBe("Springfield, Oregon");
    expect(p.links.linkedin).toBe("https://linkedin.com/in/jane-doe-example");
    expect(p.links.github).toBe("https://github.com/janedoe-example");
    expect(p.experience).toHaveLength(2);
    expect(p.experience[0]).toMatchObject({ title: "Software Engineer", company: "Initech", end: "Present" });
    expect(p.experience[0]!.highlights).toHaveLength(2);
    expect(p.totalYears).toBe(6);
    expect(p.education[0]).toMatchObject({ degree: "B.S.", end: "2020" });
    expect(p.skills.map((s) => s.name)).toEqual(
      expect.arrayContaining(["typescript", "react", "postgresql"]),
    );
  });

  it("reads text out of a PDF", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-pdf-"));
    const file = join(dir, "resume.pdf");
    writeFileSync(file, minimalPdf(["Jane Doe", "jane.doe@example.com"]));
    const text = await extractResumeText(file);
    expect(text).toContain("Jane Doe");
    expect(parseResumeText(text).email).toBe("jane.doe@example.com");
  });

  it("lets the agent's profile fill in what the rules missed", () => {
    const base = parseResumeText("Jane Doe\njane.doe@example.com");
    const merged = mergeProfiles(base, {
      location: "Springfield, Oregon",
      skills: [{ name: "rust", years: 2 }],
    });
    expect(merged).toMatchObject({ name: "Jane Doe", location: "Springfield, Oregon" });
    expect(merged.skills).toEqual([{ name: "rust", years: 2 }]);
  });
});

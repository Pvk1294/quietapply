import { readFile } from "node:fs/promises";
import { extname } from "node:path";

/** Plain text of a resume. PDF via pdf.js (unpdf), DOCX via mammoth, anything else read as text. */
export async function extractResumeText(file: string): Promise<string> {
  const ext = extname(file).toLowerCase();
  const buf = await readFile(file);
  if (ext === ".pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await extractText(pdf, { mergePages: true });
    return tidy(text);
  }
  if (ext === ".docx") {
    const mammoth = await import("mammoth");
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return tidy(value);
  }
  if (ext === ".doc") throw new Error("Old .doc files are not supported. Save the resume as PDF or DOCX.");
  return tidy(buf.toString("utf8"));
}

function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

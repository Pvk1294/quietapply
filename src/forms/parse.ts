import { type HTMLElement, parse } from "node-html-parser";
import type { FieldType, FormField, FormInfo } from "../sources/types.js";

const SKIP_INPUT = new Set(["hidden", "submit", "button", "reset", "image", "search"]);

/**
 * Read an application form out of HTML: every question with its label, type, whether it is required and
 * its options. Works on the server-rendered Greenhouse and Lever forms and on a rendered Ashby page; the
 * agent does the same in the live browser, this is what tests and the prompt's "expected questions" use.
 */
export function parseForm(html: string): FormInfo {
  const root = parse(html, { comment: false });
  const form =
    root.querySelector("form#application-form, form#application_form, form.application-form, form") ?? root;
  const fields: FormField[] = [];
  const seen = new Set<string>();

  for (const el of form.querySelectorAll("input, select, textarea")) {
    const tag = el.tagName.toLowerCase();
    const inputType = (el.getAttribute("type") ?? "text").toLowerCase();
    if (tag === "input" && SKIP_INPUT.has(inputType)) continue;
    if (el.getAttribute("aria-hidden") === "true" || el.getAttribute("tabindex") === "-1") continue;
    const name = el.getAttribute("name") ?? el.getAttribute("id") ?? "";
    if (!name || seen.has(name)) continue;
    seen.add(name);

    let type: FieldType = "text";
    let options: string[] | undefined;
    let label = "";
    if (tag === "select") {
      type = el.hasAttribute("multiple") ? "multiselect" : "select";
      options = el
        .querySelectorAll("option")
        .filter((o) => (o.getAttribute("value") ?? o.text).trim() !== "")
        .map((o) => clean(o.text));
    } else if (tag === "textarea") type = "textarea";
    else if (inputType === "radio" || inputType === "checkbox") {
      const group = form.querySelectorAll(`input[name="${cssEscape(name)}"]`);
      type = inputType === "radio" ? "radio" : group.length > 1 ? "multiselect" : "checkbox";
      options = group.map((g) => optionLabel(form, g)).filter(Boolean);
      label = groupLabel(el);
      if (type === "checkbox" && !label) label = options[0] ?? "";
    } else if (inputType === "file") type = "file";
    else if (inputType === "date") type = "date";
    else if (inputType === "number") type = "number";

    label ||= fieldLabel(form, el);
    if (!label) continue;
    const required =
      el.hasAttribute("required") ||
      el.getAttribute("aria-required") === "true" ||
      /\*\s*$|\(required\)/i.test(label);
    fields.push({
      label: label.replace(/\s*\*\s*$|\s*\(required\)\s*$/i, "").trim(),
      name,
      type,
      required,
      ...(options?.length ? { options } : {}),
    });
  }

  const text = root.innerHTML;
  const captcha =
    /class="[^"]*\b(h-captcha|g-recaptcha|cf-turnstile)\b[^"]*"(?![^>]*data-size="invisible")/i.test(text) ||
    /data-captcha="visible"/i.test(text);
  const accountRequired = form.querySelectorAll('input[type="password"]').length > 0;
  return { fields, captcha, accountRequired };
}

function clean(s: string): string {
  return s.replace(/\s+/g, " ").replace(/✱/g, "*").trim();
}

function cssEscape(s: string): string {
  return s.replace(/["\\]/g, "\\$&");
}

function fieldLabel(form: HTMLElement, el: HTMLElement): string {
  const id = el.getAttribute("id");
  if (id) {
    const forLabel = form.querySelector(`label[for="${cssEscape(id)}"]`);
    if (forLabel) return clean(forLabel.text);
  }
  const aria = el.getAttribute("aria-label");
  if (aria) return clean(aria);
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const t = labelledBy
      .split(/\s+/)
      .map((x) => form.querySelector(`#${x}`)?.text ?? "")
      .join(" ");
    if (t.trim()) return clean(t);
  }
  // Wrapping <label>, or the question title inside the field's own container (Lever, Ashby).
  // Stop at the first container that also holds other questions, so no label is borrowed from a neighbour.
  const name = el.getAttribute("name");
  for (
    let node = el.parentNode as HTMLElement | null, depth = 0;
    node && depth < 4;
    node = node.parentNode, depth++
  ) {
    if (!holdsOnly(node, name)) break;
    if (node.tagName?.toLowerCase() === "label") {
      const own = node.querySelector(".application-label, .label, span");
      return clean(own?.text ?? node.text);
    }
    const title = node.querySelector(
      ".application-label, .ashby-application-form-question-title, .field-label, legend, label",
    );
    if (title) return clean(title.text);
  }
  return clean(el.getAttribute("placeholder") ?? "");
}

function holdsOnly(node: HTMLElement, name: string | undefined): boolean {
  const names = new Set(
    node
      .querySelectorAll("input, select, textarea")
      .map((c) => c.getAttribute("name") ?? c.getAttribute("id")),
  );
  return names.size <= 1 && (!name || names.has(name) || names.size === 0);
}

function groupLabel(el: HTMLElement): string {
  const name = el.getAttribute("name");
  for (
    let node = el.parentNode as HTMLElement | null, depth = 0;
    node && depth < 5;
    node = node.parentNode, depth++
  ) {
    if (!holdsOnly(node, name)) break;
    const legend = node.querySelector(
      ":scope > legend, :scope > .application-label, :scope > .ashby-application-form-question-title, :scope > .field-label",
    );
    if (legend) return clean(legend.text);
  }
  return "";
}

function optionLabel(form: HTMLElement, input: HTMLElement): string {
  const id = input.getAttribute("id");
  if (id) {
    const l = form.querySelector(`label[for="${cssEscape(id)}"]`);
    if (l) return clean(l.text);
  }
  const parent = input.parentNode as HTMLElement | null;
  if (parent?.tagName?.toLowerCase() === "label") return clean(parent.text);
  return clean(input.getAttribute("value") ?? "");
}

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
    // Ashby's Yes/No questions are two buttons over a hidden checkbox.
    const yesNo = el.closest(".ashby-application-form-input-yesno");
    // File inputs are usually hidden behind an "Attach" button (Lever sets tabindex -1), but are real fields.
    if (
      inputType !== "file" &&
      !yesNo &&
      (el.getAttribute("aria-hidden") === "true" || el.getAttribute("tabindex") === "-1")
    )
      continue;
    const name = el.getAttribute("name") ?? el.getAttribute("id") ?? "";
    if (!name || seen.has(name)) continue;
    seen.add(name);

    let type: FieldType = "text";
    let options: string[] | undefined;
    let label = "";
    if (el.getAttribute("role") === "combobox") {
      // A custom dropdown (Greenhouse's React select): the options only exist once it is opened.
      type = name.endsWith("[]") ? "multiselect" : "select";
    } else if (yesNo) {
      type = "radio";
      options = yesNo.querySelectorAll("button").map((b) => clean(b.text));
    } else if (tag === "select") {
      type = el.hasAttribute("multiple") ? "multiselect" : "select";
      options = el
        .querySelectorAll("option")
        .filter((o) => (o.getAttribute("value") ?? o.text).trim() !== "")
        .map((o) => clean(o.text));
    } else if (tag === "textarea") type = "textarea";
    else if (inputType === "radio" || inputType === "checkbox") {
      const group = form
        .querySelectorAll(`input[name="${cssEscape(name)}"]`)
        .filter((g) => !SKIP_INPUT.has((g.getAttribute("type") ?? "").toLowerCase()));
      type = inputType === "radio" ? "radio" : group.length > 1 ? "multiselect" : "checkbox";
      options = group.map((g) => optionLabel(form, g)).filter(Boolean);
      label = groupLabel(el);
      if (type === "checkbox" && !label) label = options[0] ?? "";
    } else if (inputType === "file") type = "file";
    else if (inputType === "date") type = "date";
    else if (inputType === "number") type = "number";

    label ||= fieldLabel(form, el);
    // "Attach" / "Upload" is the button text; the question is the upload group's own label ("Resume/CV").
    let group: HTMLElement | undefined;
    if (type === "file" && (!label || GENERIC_FILE_LABEL.test(label))) {
      group = uploadGroup(form, el);
      if (group) label = groupTitle(form, group) || label;
    }
    if (!label) continue;
    const required =
      el.hasAttribute("required") ||
      el.getAttribute("aria-required") === "true" ||
      group?.getAttribute("aria-required") === "true" ||
      /_required_/.test(ashbyTitle(el)?.getAttribute("class") ?? "") ||
      /\*\s*$|\(required\)/i.test(label);
    fields.push({
      label: label.replace(/\s*\*\s*$|\s*\(required\)\s*$/i, "").trim(),
      name,
      type,
      required,
      ...(options?.length ? { options } : {}),
    });
  }

  const captcha =
    root
      .querySelectorAll(".h-captcha, .g-recaptcha, .cf-turnstile")
      .some((w) => w.getAttribute("data-size") !== "invisible" && !isLeverSubmitCaptcha(w)) ||
    root.querySelector('[data-captcha="visible"]') !== null;
  const accountRequired = form.querySelectorAll('input[type="password"]').length > 0;
  return { fields, captcha, accountRequired };
}

const GENERIC_FILE_LABEL = /^(attach|upload|choose( a)? file|browse|select file|drop files? here)\b/i;

/**
 * Lever puts `<div id="h-captcha" class="h-captcha">` on every apply form and renders it invisible: it only
 * challenges on Submit, if at all. A challenge that does appear is handled live (`mark_blocked`).
 */
function isLeverSubmitCaptcha(w: HTMLElement): boolean {
  return w.getAttribute("id") === "h-captcha" && w.closest("form") !== null;
}

/** Ashby marks a required question on its title (`class="… _required_xyz …"`), not on the input. */
function ashbyTitle(el: HTMLElement): HTMLElement | null | undefined {
  return el
    .closest(".ashby-application-form-field-entry")
    ?.querySelector(".ashby-application-form-question-title");
}

/** The container of an upload question (Greenhouse: `div[role=group][aria-labelledby]`). */
function uploadGroup(form: HTMLElement, el: HTMLElement): HTMLElement | undefined {
  for (
    let node = el.parentNode as HTMLElement | null, depth = 0;
    node && depth < 6;
    node = node.parentNode, depth++
  ) {
    if (node.getAttribute?.("role") === "group" || node.tagName?.toLowerCase() === "fieldset") return node;
    if (node === form) break;
  }
  return undefined;
}

function groupTitle(form: HTMLElement, group: HTMLElement): string {
  const by = group.getAttribute("aria-labelledby");
  const title = by ? form.querySelector(`#${by}`) : group.querySelector("legend, .label, .upload-label");
  return clean(title?.text ?? "");
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
      .filter((c) => !SKIP_INPUT.has((c.getAttribute("type") ?? "").toLowerCase()))
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

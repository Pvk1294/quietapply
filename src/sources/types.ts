import type { Ats } from "./detect.js";

export interface JobListing {
  ats: Ats;
  company: string;
  externalId: string;
  title: string;
  url: string;
  location: string;
  remote?: boolean;
  description: string;
  /** The posting itself says it does not want AI-assisted applications. */
  noAi?: boolean;
}

export type FieldType =
  | "text"
  | "textarea"
  | "select"
  | "multiselect"
  | "radio"
  | "checkbox"
  | "file"
  | "date"
  | "number";

export interface FormField {
  label: string;
  name: string;
  type: FieldType;
  required: boolean;
  options?: string[];
}

export interface FormInfo {
  fields: FormField[];
  /** A visible CAPTCHA challenge is on the page (invisible ones are left to the site). */
  captcha: boolean;
  /** The form wants a password or an account first. */
  accountRequired: boolean;
}

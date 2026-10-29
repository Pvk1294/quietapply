import type { Config } from "../core/config.js";
import type { DB } from "../core/db.js";
import { startOfToday } from "../core/limits.js";
import type { Paths } from "../core/paths.js";
import { emailsEverSent, emailsSentSince } from "./apply.js";
import { forgetPassword, readPassword, type SecretDeps } from "./secret.js";

/** Asked in setup and on the Email card, before anything can be sent. */
export const EMAIL_QUESTION = "May QuietApply send application emails from your account?";

/** What saying yes means, in plain words. */
export const EMAIL_RISK = [
  "Some postings ask you to apply by email. With this on, QuietApply writes a short email from your profile and saved answers (no AI writes it), attaches your resume and sends it from your own account.",
  "Mail providers watch for automated sending. Too much mail, or mail that people mark as spam, can get your account limited. QuietApply sends at most 10 a day by default, never twice to the same address in 30 days, and never to anyone on your do-not-contact list.",
  "Your first 10 emails wait for your OK in the dashboard, where you see the exact email. Turn this off any time in Settings. Nothing is sent while dry run is on.",
];

/** SMTP settings for common providers, from the address. Others are typed in by hand. */
export function smtpPreset(address: string): { host: string; port: number; secure: boolean } | undefined {
  const domain = address.split("@")[1]?.toLowerCase() ?? "";
  if (["gmail.com", "googlemail.com"].includes(domain))
    return { host: "smtp.gmail.com", port: 465, secure: true };
  if (["outlook.com", "hotmail.com", "live.com", "msn.com"].includes(domain))
    return { host: "smtp-mail.outlook.com", port: 587, secure: false };
  if (["yahoo.com", "ymail.com"].includes(domain))
    return { host: "smtp.mail.yahoo.com", port: 465, secure: true };
  if (["icloud.com", "me.com", "mac.com"].includes(domain))
    return { host: "smtp.mail.me.com", port: 587, secure: false };
  if (["zoho.com", "zohomail.com"].includes(domain))
    return { host: "smtp.zoho.com", port: 465, secure: true };
  if (domain === "fastmail.com") return { host: "smtp.fastmail.com", port: 465, secure: true };
  return undefined;
}

export function emailEnabled(config: Config): boolean {
  return config.email.enabled && !!config.email.acceptedAt;
}

/** Your yes, stored with its time (like LinkedIn mode). Without `accept` nothing changes. */
export function turnOnEmail(config: Config, opts: { accept: boolean; at?: Date }): Config {
  if (!opts.accept) return config;
  return {
    ...config,
    email: {
      ...config.email,
      enabled: true,
      acceptedAt: (opts.at ?? new Date()).toISOString(),
      declinedAt: undefined,
    },
  };
}

/** Your no, stored with its time, so setup does not ask again. Nothing is ever sent. */
export function declineEmail(config: Config, at = new Date()): Config {
  return {
    ...config,
    email: { ...config.email, enabled: false, acceptedAt: undefined, declinedAt: at.toISOString() },
  };
}

/** Off at once: no more mail, and the stored app password is removed. */
export function turnOffEmail(config: Config, p: Paths, deps: SecretDeps = {}): Config {
  forgetPassword(p, config.email.smtp.user, deps);
  return { ...config, email: { ...config.email, enabled: false, acceptedAt: undefined } };
}

export function emailStatus(db: DB, config: Config, p: Paths, deps: SecretDeps = {}) {
  const sent = emailsEverSent(db);
  return {
    enabled: emailEnabled(config),
    acceptedAt: config.email.acceptedAt ?? null,
    declinedAt: config.email.declinedAt ?? null,
    from: config.email.from ?? "",
    smtp: {
      host: config.email.smtp.host ?? "",
      port: config.email.smtp.port,
      secure: config.email.smtp.secure,
      user: config.email.smtp.user ?? "",
    },
    // Only whether a password is stored, never the password.
    hasPassword: !!config.email.smtp.user && !!readPassword(p, config.email.smtp.user, deps),
    perDay: config.email.perDay,
    sentToday: emailsSentSince(db, startOfToday()),
    reviewLeft: Math.max(0, config.limits.reviewFirst - sent),
    doNotContact: config.doNotContact,
    question: EMAIL_QUESTION,
    risk: EMAIL_RISK,
  };
}

import { readFileSync } from "node:fs";
import { join } from "node:path";
import nodemailer from "nodemailer";
import type { Config } from "../core/config.js";
import type { Paths } from "../core/paths.js";
import type { ApplicationEmail } from "./compose.js";

export interface SendResult {
  messageId: string;
}

/** Sends one email and returns its Message-ID. */
export type Sender = (
  email: ApplicationEmail,
  opts: { from: string; attachmentPath?: string },
) => Promise<SendResult>;

/**
 * The real sender: SMTP with your app password, STARTTLS on 587 or TLS from the start on 465. `plainLocal`
 * is for tests only: it talks to a fake SMTP server on 127.0.0.1 without TLS, and refuses any other host.
 */
export function smtpSender(config: Config, password: string, opts: { plainLocal?: boolean } = {}): Sender {
  const { smtp } = config.email;
  if (!smtp.host || !smtp.user)
    throw new Error("Email is not set up: add the SMTP server and login in Settings");
  if (opts.plainLocal && smtp.host !== "127.0.0.1")
    throw new Error("plainLocal is only for a local test server");
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    // Never log in without encryption on a real server.
    requireTLS: !smtp.secure && !opts.plainLocal,
    ignoreTLS: !!opts.plainLocal,
    auth: { user: smtp.user, pass: password },
    logger: false,
    debug: false,
    // The message is built from strings and a file read here, never from paths or URLs nodemailer opens.
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return async (email, o) => {
    const info = await transport.sendMail({
      from: o.from,
      to: email.to,
      subject: email.subject,
      text: email.body,
      attachments:
        o.attachmentPath && email.attachment
          ? [{ filename: email.attachment, content: readFileSync(o.attachmentPath) }]
          : [],
    });
    transport.close();
    return { messageId: String(info.messageId ?? "") };
  };
}

/** Where the resume file for an email lives. */
export function attachmentPath(p: Paths, email: ApplicationEmail): string | undefined {
  return email.attachment ? join(p.resumeDir, email.attachment) : undefined;
}

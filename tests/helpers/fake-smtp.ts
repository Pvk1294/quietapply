import { createServer, type Server } from "node:net";

export interface CaughtMail {
  from: string;
  to: string[];
  auth: string;
  data: string;
}

/**
 * A tiny SMTP server on 127.0.0.1 that accepts every message and keeps it in memory. It speaks just
 * enough SMTP for nodemailer (EHLO, AUTH PLAIN/LOGIN, MAIL, RCPT, DATA, QUIT). No mail leaves the test.
 */
export async function fakeSmtp(opts: { reject?: boolean } = {}): Promise<{
  port: number;
  mails: CaughtMail[];
  close: () => Promise<void>;
}> {
  const mails: CaughtMail[] = [];
  const server: Server = createServer((sock) => {
    let buf = "";
    let inData = false;
    let loginStep = 0;
    let cur: CaughtMail = { from: "", to: [], auth: "", data: "" };
    const say = (line: string) => sock.write(`${line}\r\n`);
    say("220 fake.smtp ESMTP ready");
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      for (;;) {
        if (inData) {
          const end = buf.indexOf("\r\n.\r\n");
          if (end < 0) return;
          cur.data = buf.slice(0, end).replace(/\r\n\.\./g, "\r\n.");
          buf = buf.slice(end + 5);
          inData = false;
          mails.push(cur);
          say("250 2.0.0 Ok: queued as FAKE1");
          cur = { from: "", to: [], auth: cur.auth, data: "" };
          continue;
        }
        const nl = buf.indexOf("\r\n");
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const cmd = line.toUpperCase();
        if (loginStep === 1) {
          cur.auth = Buffer.from(line, "base64").toString();
          loginStep = 2;
          say("334 UGFzc3dvcmQ6");
        } else if (loginStep === 2) {
          cur.auth += `:${Buffer.from(line, "base64").toString()}`;
          loginStep = 0;
          say(opts.reject ? "535 5.7.8 Authentication failed" : "235 2.7.0 Authentication successful");
        } else if (cmd.startsWith("EHLO") || cmd.startsWith("HELO"))
          sock.write("250-fake.smtp\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n");
        else if (cmd.startsWith("AUTH PLAIN")) {
          const [, user, pass] = Buffer.from(line.slice(11), "base64").toString().split("\0");
          cur.auth = `${user}:${pass}`;
          say(opts.reject ? "535 5.7.8 Authentication failed" : "235 2.7.0 Authentication successful");
        } else if (cmd.startsWith("AUTH LOGIN")) {
          loginStep = 1;
          say("334 VXNlcm5hbWU6");
        } else if (cmd.startsWith("MAIL FROM")) {
          cur.from = line.slice(10).replace(/[<>]/g, "").split(" ")[0]!;
          say("250 2.1.0 Ok");
        } else if (cmd.startsWith("RCPT TO")) {
          cur.to.push(line.slice(8).replace(/[<>]/g, ""));
          say("250 2.1.5 Ok");
        } else if (cmd === "DATA") {
          inData = true;
          say("354 End data with <CR><LF>.<CR><LF>");
        } else if (cmd === "QUIT") {
          say("221 2.0.0 Bye");
          sock.end();
        } else if (cmd === "RSET" || cmd === "NOOP") say("250 Ok");
        else say("502 5.5.2 Not implemented");
      }
    });
    sock.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return { port, mails, close: () => new Promise((r) => server.close(() => r())) };
}

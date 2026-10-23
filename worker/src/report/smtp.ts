import { withTimeout } from "./pdf.ts";

export interface SmtpSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  opened: Promise<unknown>;
  closed: Promise<unknown>;
  close(): Promise<unknown>;
  startTls?(): SmtpSocket;
}
export type SmtpConnect = (address: { hostname: string; port: number }, options: { secureTransport: "on" | "starttls" }) => SmtpSocket;
export interface SmtpConfig { hostname: string; username: string; password: string; from: string; clientHostname: string; port?: 465 | 587; timeoutMs?: number }
export interface ReportMail { to: string; reportId: string; pdf: ArrayBuffer; downloadUrl: string; now: number }
export type MailOutcome = { status: "sent" | "failed" | "unknown"; error?: string };
export interface MailTransport { send(message: ReportMail): Promise<MailOutcome> }

/** Deliberately accepts ASCII mailbox syntax only; CRLF and SMTPUTF8 cannot be smuggled into commands. */
export function validateMailbox(value: string): boolean {
  const parts = value.split("@");
  return value.length <= 254 && parts.length === 2 && parts[0]!.length <= 64 &&
    /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(parts[0]!) &&
    /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(parts[1]!);
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}
function encodeText(text: string): string { return base64(new TextEncoder().encode(text)); }
function wrap64(encoded: string): string { return encoded.match(/.{1,76}/g)?.join("\r\n") ?? ""; }

export function buildMime(config: Pick<SmtpConfig, "from" | "clientHostname">, message: ReportMail): string {
  if (!validateMailbox(config.from) || !validateMailbox(message.to)) throw new Error("SMTP_INVALID_ADDRESS");
  if (!/^[a-zA-Z0-9.-]+$/.test(config.clientHostname)) throw new Error("SMTP_INVALID_CLIENT_HOSTNAME");
  const url = new URL(message.downloadUrl);
  if (url.protocol !== "https:") throw new Error("SMTP_INVALID_REPORT_URL");
  const boundary = `pixelplus-${crypto.randomUUID()}`;
  const body = `Ваш предварительный аудит приложен к письму.\nСкачать отчёт: ${url.href}\nСсылка действует в пределах срока хранения отчёта.\nЭто предварительный аудит по предоставленным вами сведениям.`;
  return [
    `From: <${config.from}>`, `To: <${message.to}>`,
    `Subject: =?UTF-8?B?${encodeText("ПРЕДВАРИТЕЛЬНЫЙ АУДИТ")}?=`,
    `Date: ${new Date(message.now).toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${config.clientHostname}>`,
    "MIME-Version: 1.0", `Content-Type: multipart/mixed; boundary="${boundary}"`, "",
    `--${boundary}`, 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", wrap64(encodeText(body)),
    `--${boundary}`, 'Content-Type: application/pdf; name="preliminary-audit.pdf"', "Content-Transfer-Encoding: base64",
    'Content-Disposition: attachment; filename="preliminary-audit.pdf"', "", wrap64(base64(new Uint8Array(message.pdf))), `--${boundary}--`, "",
  ].join("\r\n");
}

/** TLS submission only (implicit 465 or STARTTLS 587). AUTH PLAIN/LOGIN is negotiated after TLS. Provider text is never logged. */
export class SmtpTransport implements MailTransport {
  private readonly config: SmtpConfig;
  private readonly connect: SmtpConnect;
  constructor(config: SmtpConfig, connect: SmtpConnect) { this.config = config; this.connect = connect; }

  async send(message: ReportMail): Promise<MailOutcome> {
    let socket: SmtpSocket | undefined;
    let accepted = false;
    let dataStarted = false;
    let explicitFailure = false;
    try {
      const mime = buildMime(this.config, message);
      if (!/^[A-Za-z0-9.-]+$/.test(this.config.hostname) || /[\r\n\0]/.test(this.config.username + this.config.password)) {
        return { status: "failed", error: "SMTP_INVALID_CONFIG" };
      }
      const port = this.config.port ?? 465;
      socket = this.connect({ hostname: this.config.hostname, port }, { secureTransport: port === 587 ? "starttls" : "on" });
      // Observe the close rejection even when the handshake fails first.
      void socket.closed.catch(() => undefined);
      let connection = socket;
      await withTimeout((async () => {
        await connection.opened;
        let reader = connection.readable.getReader();
        let writer = connection.writable.getWriter();
        let locked = true;
        let buffer = "";
        const decoder = new TextDecoder();
        const readReply = async (): Promise<{ code: number; lines: string[] }> => {
          const lines: string[] = [];
          let code: number | undefined;
          for (;;) {
            while (!buffer.includes("\r\n")) {
              const part = await reader.read();
              if (part.done) throw new Error("SMTP_EOF");
              buffer += decoder.decode(part.value, { stream: true });
              if (buffer.length > 16_384) throw new Error("SMTP_REPLY_TOO_LARGE");
            }
            const offset = buffer.indexOf("\r\n");
            const line = buffer.slice(0, offset); buffer = buffer.slice(offset + 2);
            const match = /^(\d{3})([ -])(.*)$/.exec(line);
            if (!match || line.length > 512 || lines.length >= 32) throw new Error("SMTP_INVALID_REPLY");
            const nextCode = Number(match[1]);
            if (code !== undefined && code !== nextCode) throw new Error("SMTP_INVALID_MULTILINE");
            code = nextCode; lines.push(match[3]!);
            if (match[2] === " ") return { code, lines };
          }
        };
        const requireCode = (reply: { code: number }, expected: number[]) => {
          if (!expected.includes(reply.code)) { explicitFailure = reply.code >= 400 && reply.code <= 599; throw new Error("SMTP_REJECTED"); }
        };
        const command = async (text: string, expected: number[]) => {
          await writer.write(new TextEncoder().encode(text + "\r\n"));
          const reply = await readReply(); requireCode(reply, expected); return reply;
        };
        try {
          requireCode(await readReply(), [220]);
          let hello = await command(`EHLO ${this.config.clientHostname}`, [250]);
          if (port === 587) {
            if (!hello.lines.some((line) => /^STARTTLS(?:\s|$)/i.test(line)) || !connection.startTls) throw new Error("SMTP_STARTTLS_UNAVAILABLE");
            await command("STARTTLS", [220]);
            if (buffer) throw new Error("SMTP_UNEXPECTED_PLAINTEXT");
            reader.releaseLock(); writer.releaseLock(); locked = false;
            const secure = connection.startTls();
            connection = secure; socket = secure;
            void secure.closed.catch(() => undefined);
            await secure.opened;
            reader = secure.readable.getReader(); writer = secure.writable.getWriter(); locked = true;
            hello = await command(`EHLO ${this.config.clientHostname}`, [250]);
          }
          const auth = hello.lines.find((line) => /^AUTH(?:=| )/i.test(line))?.toUpperCase().split(/[ =]+/).slice(1) ?? [];
          if (auth.includes("PLAIN")) {
            await command(`AUTH PLAIN ${encodeText(`\0${this.config.username}\0${this.config.password}`)}`, [235]);
          } else if (auth.includes("LOGIN")) {
            await command("AUTH LOGIN", [334]);
            await command(encodeText(this.config.username), [334]);
            await command(encodeText(this.config.password), [235]);
          } else throw new Error("SMTP_AUTH_UNSUPPORTED");
          await command(`MAIL FROM:<${this.config.from}>`, [250]);
          await command(`RCPT TO:<${message.to}>`, [250, 251]);
          await command("DATA", [354]);
          dataStarted = true;
          await writer.write(new TextEncoder().encode(mime.replace(/(^|\r\n)\./g, "$1..") + ".\r\n"));
          requireCode(await readReply(), [250]);
          accepted = true;
          // Acceptance is authoritative; a failed QUIT never changes it to an uncertain delivery.
          await command("QUIT", [221]).catch(() => undefined);
        } finally { if (locked) { reader.releaseLock(); writer.releaseLock(); } }
      })(), this.config.timeoutMs ?? 20_000, "SMTP_TIMEOUT");
      return { status: "sent" };
    } catch {
      if (accepted) return { status: "sent" };
      return { status: dataStarted && !explicitFailure ? "unknown" : "failed", error: dataStarted && !explicitFailure ? "SMTP_DELIVERY_UNKNOWN" : "SMTP_SEND_FAILED" };
    } finally { if (socket) void socket.close().catch(() => undefined); }
  }
}

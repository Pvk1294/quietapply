import * as p from "@clack/prompts";

export interface Choice<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

/**
 * The questions the setup wizard can ask. The terminal version uses @clack/prompts; tests use a scripted
 * version, so every step can be checked without a terminal.
 */
export interface Prompter {
  readonly interactive: boolean;
  intro(title: string): void;
  outro(message: string): void;
  note(body: string, title?: string): void;
  info(message: string): void;
  warn(message: string): void;
  success(message: string): void;
  step(message: string): void;
  /** Free text. `initial` is pre-filled and editable; an empty answer returns "". */
  text(o: {
    message: string;
    initial?: string;
    placeholder?: string;
    validate?: (v: string) => string | undefined;
  }): Promise<string>;
  select<T extends string>(o: { message: string; options: Choice<T>[]; initial?: T }): Promise<T>;
  multiselect<T extends string>(o: {
    message: string;
    options: Choice<T>[];
    initial?: T[];
    required?: boolean;
  }): Promise<T[]>;
  confirm(o: { message: string; initial?: boolean }): Promise<boolean>;
  /** Run slow work behind a spinner; `done` turns the result into the line shown afterwards. */
  spin<R>(label: string, work: () => Promise<R>, done?: (r: R) => string): Promise<R>;
}

/** Thrown when the person quits (Ctrl-C / Esc). Everything saved by finished steps is kept. */
export class SetupCancelled extends Error {
  constructor() {
    super("Setup stopped");
  }
}

function check<T>(v: T): Exclude<T, symbol> {
  if (p.isCancel(v)) throw new SetupCancelled();
  return v as Exclude<T, symbol>;
}

export const terminalPrompter: Prompter = {
  interactive: true,
  intro: (t) => p.intro(t),
  outro: (m) => p.outro(m),
  note: (b, t) => p.note(b, t),
  info: (m) => p.log.info(m),
  warn: (m) => p.log.warn(m),
  success: (m) => p.log.success(m),
  step: (m) => p.log.step(m),
  async text(o) {
    const v = check(
      await p.text({
        message: o.message,
        initialValue: o.initial,
        placeholder: o.placeholder,
        validate: o.validate ? (x) => o.validate?.(x ?? "") : undefined,
      }),
    );
    return (v ?? "").trim();
  },
  async select(o) {
    return check(
      await p.select({
        message: o.message,
        options: o.options as { value: string; label: string; hint?: string }[],
        initialValue: o.initial,
        maxItems: 12,
      }),
    ) as typeof o.initial & string;
  },
  async multiselect(o) {
    return check(
      await p.multiselect({
        message: o.message,
        options: o.options as { value: string; label: string; hint?: string }[],
        initialValues: o.initial,
        required: o.required ?? false,
        maxItems: 14,
      }),
    ) as NonNullable<typeof o.initial>;
  },
  async confirm(o) {
    return check(await p.confirm({ message: o.message, initialValue: o.initial ?? true }));
  },
  async spin(label, work, done) {
    const s = p.spinner();
    s.start(label);
    try {
      const r = await work();
      s.stop(done ? done(r) : label);
      return r;
    } catch (err) {
      s.stop(`${label}: failed`);
      throw err;
    }
  },
};

/**
 * Answers every question with its pre-filled value. Used by `quietapply init --yes`: nothing is asked, the
 * defaults (and anything already saved) are kept.
 */
export function defaultsPrompter(log: (line: string) => void = () => {}): Prompter {
  return {
    interactive: false,
    intro: (t) => log(t),
    outro: (m) => log(m),
    note: (b, t) => log(t ? `${t}\n${b}` : b),
    info: log,
    warn: log,
    success: log,
    step: log,
    text: async (o) => o.initial ?? "",
    select: async (o) => o.initial ?? o.options[0]!.value,
    multiselect: async (o) => o.initial ?? [],
    confirm: async (o) => o.initial ?? true,
    spin: async (_label, work, done) => {
      const r = await work();
      if (done) log(done(r));
      return r;
    },
  };
}

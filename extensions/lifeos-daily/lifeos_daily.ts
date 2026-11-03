/**
 * @skunk-ape/lifeos-daily — the day's journal file in a LifeOS vault, already
 * filled with what shipped yesterday and what is on the plate.
 *
 * `journal` renders the `mine` record of an `@skunk-ape/swamp-lab` behavior,
 * passed in by the workflow, into the vault's own template, and writes it to
 * `<journalRoot>/YYYY/MM/YYYY-MM-DD.md`. It never overwrites: if the day's
 * file exists, someone has started it, and the run says so and leaves it.
 *
 * Deterministic: no model writes any of it. The only side effect is that one
 * new file.
 */
import { z } from "npm:zod@4";
import {
  DEFAULT_TEMPLATE,
  journalPath,
  type Lab,
  renderJournal,
  today,
} from "./_lib/journal.ts";

// deno-lint-ignore no-explicit-any
type Ctx = any;

const GlobalArgsSchema = z.object({
  journalRoot: z.string().min(1).describe(
    "The vault's journal directory. A leading ~ is the home directory.",
  ),
  template: z.string().default("").describe(
    "A Markdown file laying out the page, with {{heading}}, {{date}}, {{tomorrow}}, {{shipped}} and {{plate}} filled in. A leading ~ is the home directory. Empty uses a minimal built-in page.",
  ),
  timezone: z.string().default("UTC").describe(
    "IANA timezone that decides which day 'today' is.",
  ),
  maxLabAgeHours: z.number().default(3).describe(
    "A `mine` record older than this is from an earlier run, not this one: the page says the Lab could not be read instead of repeating it.",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const LabSchema = z.object({
  generatedAt: z.string(),
  window: z.object({ start: z.string(), end: z.string(), from: z.string() }),
  coverage: z.object({ ok: z.boolean(), note: z.string() }),
  shipped: z.array(z.object({
    number: z.number(),
    title: z.string(),
    status: z.string(),
    prs: z.array(z.object({ repo: z.string(), number: z.number() })),
  })),
  plate: z.array(z.object({
    number: z.number(),
    title: z.string(),
    status: z.string(),
    since: z.string(),
    sinceSource: z.string(),
  })),
});

const JournalSchema = z.object({
  date: z.string(),
  path: z.string(),
  written: z.boolean(),
  reason: z.enum(["written", "exists"]),
  labUsed: z.boolean(),
  shipped: z.number(),
  plate: z.number(),
  at: z.string(),
});

function expandHome(p: string): string {
  if (p !== "~" && !p.startsWith("~/")) return p;
  const home = Deno.env.get("HOME");
  if (!home) throw new Error("HOME is not set; cannot expand ~");
  return home + p.slice(1);
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
}

/** The `@skunk-ape/lifeos-daily` behavior type. */
export const behavior = {
  type: "@skunk-ape/lifeos-daily",
  version: "2026.11.03.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    journal: {
      description:
        "The last journal run: which file, and whether it was written or found already there.",
      schema: JournalSchema,
      lifetime: "infinite",
      garbageCollection: 30,
    },
  },
  methods: {
    journal: {
      description:
        "Write the day's journal file from the vault's template (or a minimal built-in one), with 'Shipped yesterday' and 'On my plate' filled from a swamp-lab `mine` record. Never overwrites: an existing file is left as it is and reported. A missing or stale `mine` record still writes the page, saying the Lab could not be read.",
      arguments: z.object({
        lab: z.unknown().optional().describe(
          "The `attributes` of a swamp-lab `mine` record, from this run.",
        ),
        date: z.string().default("").describe(
          "YYYY-MM-DD to write. Empty is today in `timezone`.",
        ),
        output: z.string().default("").describe(
          "Write here instead of under `journalRoot`, for a trial run. Still never overwrites.",
        ),
      }),
      execute: async (
        args: { lab?: unknown; date: string; output: string },
        ctx: Ctx,
      ) => {
        const g = ctx.globalArgs as GlobalArgs;
        const date = args.date || today(g.timezone);
        const path = expandHome(
          args.output || journalPath(g.journalRoot, date),
        );

        let lab: Lab | null = null;
        const parsed = LabSchema.safeParse(args.lab);
        if (!parsed.success) {
          ctx.logger.warning("No usable swamp-lab record; Lab sections say so");
        } else {
          const age = (Date.now() - Date.parse(parsed.data.generatedAt)) /
            3600000;
          if (age > g.maxLabAgeHours) {
            ctx.logger.warning(
              "swamp-lab record is {h} hours old, from an earlier run; not used",
              { h: Math.round(age) },
            );
          } else {
            lab = parsed.data;
          }
        }

        const record = (written: boolean) =>
          ctx.writeResource("journal", "journal", {
            date,
            path,
            written,
            reason: written ? "written" : "exists",
            labUsed: lab !== null,
            shipped: lab?.shipped.length ?? 0,
            plate: lab?.plate.length ?? 0,
            at: new Date().toISOString(),
          });

        if (await exists(path)) {
          ctx.logger.info("{path} exists, skipped", { path });
          return { dataHandles: [await record(false)] };
        }

        // A template that is named but missing fails the run: a page in the
        // wrong layout would look written and be wrong.
        const template = g.template
          ? await Deno.readTextFile(expandHome(g.template))
          : DEFAULT_TEMPLATE;
        const text = renderJournal(date, lab, g.timezone, template);
        await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), {
          recursive: true,
        });
        try {
          // createNew: the check above and this write race nothing else, but
          // an exclusive create keeps "never overwrite" true even if they did.
          await Deno.writeTextFile(path, text, { createNew: true });
        } catch (e) {
          if (!(e instanceof Deno.errors.AlreadyExists)) throw e;
          ctx.logger.info("{path} exists, skipped", { path });
          return { dataHandles: [await record(false)] };
        }
        ctx.logger.info("Wrote {path}", { path });
        return { dataHandles: [await record(true)] };
      },
    },
  },
};

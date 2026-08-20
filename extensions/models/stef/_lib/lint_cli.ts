// Thin CLI shim mirroring simple_english_lint.py, used to diff the TS port
// against the Python original. Same arguments, same output, same exit codes.
import { formatFinding, lint, type TextType } from "./lint.ts";

const args = [...Deno.args];
let textType: TextType = "descriptive";
let maxWords: number | undefined;
let path = "-";

// Parity mode keeps a leading YAML block in scope, matching the Python
// original, so the two implementations can be diffed check-for-check.
let frontmatter = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--type") textType = args[++i] as TextType;
  else if (args[i] === "--max-words") maxWords = Number(args[++i]);
  else if (args[i] === "--strip-frontmatter") frontmatter = true;
  else path = args[i];
}

const text = path === "-"
  ? new TextDecoder().decode(
    await new Response(Deno.stdin.readable).arrayBuffer(),
  )
  : await Deno.readTextFile(path);

const findings = lint(text, { maxWords, textType, frontmatter });
for (const f of findings) console.log(formatFinding(f));
Deno.exit(findings.length > 0 ? 1 : 0);

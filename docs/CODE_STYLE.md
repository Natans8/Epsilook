# Code style and documentation

Applies to every language in this repository. Where this document is silent, follow the relevant Google style guide:
[TypeScript](https://google.github.io/styleguide/tsguide.html) ·
[Python](https://google.github.io/styleguide/pyguide.html) ·
[HTML/CSS](https://google.github.io/styleguide/htmlcssguide.html) ·
[Markdown](https://google.github.io/styleguide/docguide/style.html).

Enforced by `npx oxlint --type-aware` (TypeScript), `mypy` and `pyflakes` (Python). `python tools/check.py` runs all
three. Rules that a linter can decide belong in `.oxlintrc.json`, not in this document.

## Documentation

Documentation is written **for a developer reading the code, or a user reading the docs**. It is not a changelog, not a
discussion, and not a record of how the code came to look the way it does.

### Required

- **Every exported symbol carries a JSDoc block** (`/** … */`). Non-exported helpers carry one when the name alone does
  not explain them.
- **State what the thing IS and what it GUARANTEES.** Preconditions, postconditions, invariants, units, and what a
  return value of `null`/`undefined` means.
- **Document the non-obvious `why`** when a reader would otherwise be tempted to "fix" correct code: a deliberate
  refusal, a measured constraint, an ordering that matters.
- **Keep it current.** When you touch a function whose documentation is wrong or stale, correct it in the same change.
  An outdated comment is worse than none, because it gets acted on.

### Forbidden

| never | instead |
|---|---|
| Quoting a person, or attributing a decision to one | State the rule. The reasoning belongs in `docs/DECISIONS.md` |
| Dates, session references, "corrected on", "as of" | Describe the code as it is now |
| Emoji, and decorative rules such as `═══` or `⭐` | Plain prose and standard JSDoc |
| Justifying something that is **not** implemented | Delete it, or write `TODO:` with what is required |
| Referring to the chat, a plan document section, or a phase number | Name the concept; link a doc only for a real cross-reference |
| Restating a measurement as an argument for the code | Keep the number only where it constrains the implementation |
| ALL-CAPS sentences for emphasis | Ordinary sentences |

**A comment describing work that was not done is a defect.** If future work is required, it is a `TODO:` naming the
condition that unblocks it. If it is not required, it does not belong in the file at all.

### Tone

Neutral and technical. The code has no author in its own comments; nothing should read as one side of a conversation.

## TypeScript

- `strict` everywhere. No `any`; `unknown` plus a narrowing check instead.
- `import type` for type-only imports (`verbatimModuleSyntax` enforces it).
- Named exports. No default exports.
- Explicit return types on exported functions.
- `readonly` on declarative records and array parameters that are not mutated.
- Prefer a discriminated union over an optional-field bag.
- File names are lowercase; use a dash between words (`text-folding.ts`) rather than running them together. Clarity
  beats brevity: a one-word name that needs a comment to explain it is the wrong name.

## Python

- `build/build_data.py` is standard library only. `tools/` and exploration code may take dependencies.
- Type annotations on every function signature; `mypy` must pass.

## Markdown

- Wrap at 120 columns. Reference links for anything cited more than once.
- Tables for enumerable facts; prose for everything else.

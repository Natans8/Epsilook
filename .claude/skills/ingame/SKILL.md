---
name: ingame
description: The protocol for asking the user to test or compare spells inside Epsilon. Use whenever a decision depends on what a spell actually DOES in game — an attribute flag's effect, whether a visual reads, how two spells differ — and the answer cannot be read from the data. Also use when the user invokes /ingame.
---

# Asking for an in-game test

The user plays Epsilon; you do not. This is the fixed shape of that exchange, so it costs one round trip instead of
four. **It is a message format, not a tool.** Nothing is generated, nothing is installed. You write a block in chat,
they test, they answer by number.

## 1. First, don't ask

**Split the question into a DATA half and a BEHAVIOUR half. Only the behaviour half goes to the user.** This is where
the round trips are actually saved.

| the question is…                                   | answer it yourself with…                  |
|----------------------------------------------------|-------------------------------------------|
| which spells carry this flag / effect / visual     | `mcp__duckdb__execute_query`              |
| what IS this spell, every route to its leaves      | `python tools/dossier.py <id\|name>`      |
| how do two spells differ in the data               | `python tools/dossier.py <a> <b> --diff`  |
| what the client calls this flag, and its cast time | `wowhead.com/spell=<id>` — it prints both |
| **what Epsilon DOES with it on screen**            | **the user, in game — this protocol**     |

Pick the spells FROM that query. Never from memory: a spell id or name you recalled rather than looked up is this
project's most repeated error. Same rule for what a flag does — if you are about to write "this makes the beam follow
its target", either verify it or write the uncertainty (`TrackTargetInChannel` was wrong in three files exactly that
way).

**If you cannot write the "Unblocks" line below, you do not need the test.** Curiosity is not a reason to spend
someone's evening.

## 2. The block

**Every command gets its own fenced code block — that is the only thing with a copy button.** Inline backticks have
none, and a multi-line fence copies all its lines at once, which is useless when Epsilon takes one command at a time.

**Leave the fences untagged.** A ```bash tag adds a Run button that would execute `.cast 133` in PowerShell.

Emit exactly this shape:

````markdown
## 🧪 <The question the experiment answers>

**Unblocks:** <the one development decision that changes with the answer>
**Setup:** <anything to do first — omit the line if there is none>

### A · subject — <what these share>
**Look for:** <the observable, stated so a "no" is as clear as a "yes">

**Permanent Feign Death**
```
.aura 131041
```
**Health Funnel**
```
.aura 755
```

### B · control — <what differs, and why these are otherwise comparable>
**Look for:** <usually "the same thing, absent">

**Fireball**
```
.aura 133
```

### Questions
1. **(yes/no)** <…>
2. **(which)** a) <…>  b) <…>  c) no difference
3. **(what happened)** <…>

*Answer by number — `1 yes`, `2 b`, `3 <a sentence>`. Say `skip` for anything you didn't get to.*
````

## 3. The rules that make it work

- **One block per command the user will actually run.** Both `.cast` and `.aura` only when the test needs both; a
  cleanup `.unaura <id>` only where state would otherwise leak. Do not dump all four commands per spell — the block
  count is what makes a sheet unusable.
- **If the blocks make it long, cut SPELLS, not commands.** A row missing the command it needs is a failed test; a sheet
  with two fewer rows is still a test.
- **A control group is mandatory.** If there genuinely is not one, say so on its own line and name what you are
  comparing against instead (a different pack, the same spell without the aura, nothing at all). A test with no control
  produces an anecdote.
- **Name the spell, not the id.** The id is already inside the command; printing it twice is noise. Every name comes
  from the query you just ran.
- **Cap it: ~6 spells, ~4 questions.** A sheet nobody finishes is worse than a smaller one that gets answered. More than
  that is two experiments — send the one that unblocks the most.
- **Every question is typed** — `(yes/no)`, `(which)` with lettered options, or `(what happened)`. Untyped questions
  come back as prose you then have to re-interrogate.
- **Ask only what you cannot infer.** "Did the border turn red" is a question. "How many spells carry this flag" is a
  `SELECT` you should have run.
- **State the "look for" as an observable, not a mechanism.** "Does the caster stay facing the target while
  channelling" — not "does TrackTargetInChannel work".
- Only ask for a spawned NPC, a second character or a specific zone when the question needs one — and then say so
  explicitly in Setup.

## 4. Then stop

Post the block and **end the turn**. They are about to alt-tab into a game. Do not carry on with the work that depends
on the answer, and do not guess the answer to keep moving.

When they come back:

- **A closed question that came back ambiguous → `AskUserQuestion`.** Clickable options resolve
  "which one" far cheaper than another paragraph. One call, up to 4 questions.
- **Anything unanswered stays unanswered.** Carry it forward; never quietly assume the likely value.

## 5. Close it out — the step that stops this repeating

In the same breath as acting on the answer:

1. **`docs/DECISIONS.md` → "EPSILON BEHAVIOUR — tested in game by the user"**, a new entry at the top of that group: the
   date, the question, the verdict **in the user's own words where they gave one**, and which spells it was tested on.
   That group exists precisely so a verdict is never re-litigated or re-tested.
2. **Record the NEGATIVE and UNANSWERED results too.** A dropped idea with a reason is worth as much as a shipped one,
   and a question re-asked because nobody wrote down that it went unanswered is the exact failure this protocol exists
   to stop.
3. **CLAUDE.md's feature queue** — move the item or strike it, in the same change.

**A verdict that lives only in this transcript is lost.** That is the whole reason for step 1.

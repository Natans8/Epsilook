#!/usr/bin/env python3
"""COOK A SPELL DESCRIPTION INTO PLACEHOLDER-FREE PROSE.

The client stores a description as a TEMPLATE, not as text. Spell 11 ships
`Deals $s1 Frost damage to the target.`, spell 158986 ships literally
`$@spelldesc159001`, and 19,807 spells on 9.2.7 ship nothing BUT a redirect.
The game resolves the template at tooltip time against the caster's own state;
Wowhead resolves it server-side for display. Neither result is searchable,
which is the whole gap this fills — see docs/DATA_ROUTES.md.

WHAT THIS IS FOR DECIDES HOW EXACT IT HAS TO BE. The cooked string is SEARCH
TEXT (and the hover that shows why a row matched): a roleplayer types "blood
pool" or "kneel", never a number. So the rule is not "reproduce Wowhead" — it
is:

    NEVER PRINT A NUMBER THIS DATA CANNOT JUSTIFY, and never leave a `$`.

Which splits every code into two kinds, and the split is the whole design:

  RESOLVED   the value is in a db2 we already read — effect points, duration,
             tick period, radius, range, stack cap, charges, chain targets.
             Substituted for real.
  ELIDED     the value depends on the CASTER (attack power, spell power, the
             primary stat, versatility, player level) or on the UI ($z, an
             icon). Removed, leaving prose: "Sears an enemy, causing Nature
             damage" rather than "causing ${$M1+($SP*.168)} Nature damage".

Eliding reads naturally because these templates are written as English
sentences with a number slotted in; take the number out and the sentence
survives. Printing a fabricated 0 does not.

⚠ WOWHEAD IS AN ORACLE FOR THE PROSE AND **NOT** FOR THE NUMBERS, and it is
worth knowing before anyone re-runs that comparison. Retail Wowhead renders
every spell at the CURRENT retail patch — Midnight as of 2026-08 — and spell
scaling is re-tuned every expansion, so its figure for a 9.2.7 spell is
computed against a curve our pack does not use (Chained Bolt: the 9.2.7 db2
says 5.19, retail Wowhead shows 427). There is no Wowhead for Shadowlands, so
for nine of our eleven packs no external oracle for the numbers exists at all.
The values here are the BUILD'S OWN, which is the right answer for a
build-pinned pack even where it disagrees with the site. A structural diff
against Wowhead is still worth running — it is what caught the case-insensitive
texture bug and the conditional-chain bug below.

⚠ AN EXPRESSION IS ALL-OR-NOTHING. `${$s1*$<mult>}` resolves only if every
operand does; one caster-dependent term elides the whole `${...}`. Half an
arithmetic expression is not a smaller answer, it is a wrong one.

⚠ THE CONTEXT SPELL CHANGES ON A REDIRECT. `$@spelldesc159001` inserts 159001's
template, and the `$s1` inside it means 159001's first effect — not the
original spell's. Resolution is therefore a recursion carrying the context
spell, not a substitution pass over one string.

Stdlib only, like build_data.py, and no knowledge of the pack: it takes lookup
dicts and returns strings.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# ---------------------------------------------------------------- the codes
#
# Derived from a census of every `$` token in 9.2.7's 129,050 descriptions plus
# its 63,788 aura descriptions (see docs/DATA_ROUTES.md §3x). Frequency drove
# the coverage: `s` alone is 80,917 occurrences and the top four (s, d, t, A)
# are the overwhelming majority, while everything below `x` is a long tail of
# tens.

# letter -> what a SpellValues lookup should return. Several letters are the
# same quantity under different spellings, which is the client's history rather
# than a distinction: `$w1`, `$W1`, `$S1` and `$e1` all read an effect's amount
# exactly as `$s1` does ("Stamina increased by $w1", spell 19705).
POINTS_CODES = "sSwWe"
CODE_MEANING = {
    **{c: "points" for c in POINTS_CODES},
    "m": "points_min",
    "M": "points_max",
    "o": "points_total",  # amount x ticks over the full duration
    "b": "points_per_combo",
    "t": "period", "T": "period",
    "a": "radius", "A": "radius",
    "x": "chain_targets",
    "i": "max_targets", "I": "max_targets",
    "q": "misc_value",
    "d": "duration", "D": "duration",
    "u": "max_stacks", "U": "max_stacks",
    "n": "charges",
    "h": "proc_chance",
    "r": "range", "R": "range",
    "v": "max_target_level",
}

# Codes spelled as a WORD rather than a letter, every one of which depends on
# the caster, on gear, or on the UI, and so can only be elided.
#
# ⚠ THE ALTERNATION IS SORTED LONGEST-FIRST, and that is load-bearing rather
# than tidy: a regex alternation takes the FIRST branch that matches, so with
# "AP" ahead of "RAP" the string `$RAP` is read as `$R` (a range!) followed by
# the literal letters "AP" — a fabricated number in the middle of a sentence,
# which is precisely the failure this module exists to avoid. Sorting here
# rather than by hand means adding a word can never reintroduce it.
ELIDED_WORDS = [
    # caster stats and scaling
    "RAP", "AP", "SP", "MWB", "mwb", "MHP", "PL", "pl", "pri",
    "INT", "STR", "AGI", "STA", "SPI", "versadmg", "abs",
    # weapon damage, enchant values, item-level scaling
    "ecix", "ec", "bc", "sw", "mw",
    # proc/cast bookkeeping the tooltip computes at runtime
    "proccooldown", "procrppm", "maxcast",
    # creature-level bands, UI markers, the player's hearth
    "ctrmax", "ctrmin", "lootspec", "bullet", "expandtiptag",
    # a handful of MALFORMED redirects: `$347182spelldesc` (41 on 9.2.7) has
    # its `@` in the wrong place, so the redirect pass never sees it
    "spelldesc", "spellaura", "spelltooltip", "spellname", "spellicon",
]
# The trailing `;` is part of the token for the ones that carry one (`$bullet;`)
# and absent for the rest, so it is optional — left behind it opens an encounter
# note with a stray semicolon.
_ELIDED_WORD_RE = re.compile(
    r"\$\d*(" + "|".join(sorted(ELIDED_WORDS, key=len, reverse=True)) + r")\d*;?")

# `$j1g` / `$j1f` — the ground and flight halves of a mount's speed effect.
# Two letters with the index BETWEEN them, so the generic code regex would read
# `$j1` and leave a stray "g". 2,222 occurrences on 9.2.7.
_JGF_RE = re.compile(r"\$\d*j\d*[gf]")

# `$z` is the player's hearth location and `$g male:female;` their gender —
# both real, neither ours to know.
_GENDER_RE = re.compile(r"\$[gG]([^:;]*):([^;]*);")
_PLURAL_RE = re.compile(r"\$[lL]([^:;]*):([^;]*);")
_BAR_PLURAL_RE = re.compile(r"\|4([^:;]*):([^;]*);")

# `$/10;s2`, `$*2;23478s1` and `$45548/5;s1` — a divisor or multiplier glued to
# the code it scales. THE SCALED CODE CARRIES NO `$` OF ITS OWN, which is why
# it needs its own pattern rather than a lookahead onto the ordinary one; and
# the spell id may sit on EITHER side of the operator.
_SCALE_RE = re.compile(r"\$(\d*)([/*])(\d+(?:\.\d+)?);(\d*)([a-zA-Z])(\d*)")

# `$<shield>` — a named variable from SpellDescriptionVariables, whose body is
# itself a template evaluated in the same spell's context.
_VAR_RE = re.compile(r"\$<([^>]+)>")

# `$@spelldesc159001` and friends. `$@spellicon` names art and is dropped.
_AT_RE = re.compile(r"\$@(spelldesc|spellaura|spelltooltip|spellname|spellicon)(\d+)")
_AT_OTHER_RE = re.compile(r"\$@+[A-Za-z]\w*\d*")

# `$12345s1` (another spell's effect) or `$s1` (this spell's). The optional
# leading digits are a spell id, the optional trailing ones an effect index.
#
# `l` and `L` are EXCLUDED: `$lpoint:points;` is a plural, and the plural can
# only be picked once the number in front of it exists — so it has to survive
# this pass and be resolved after it. Neither letter names a value, so nothing
# is lost by keeping them out.
_CODE_RE = re.compile(r"\$(\d*)([a-km-zA-KM-Z])(\d*)")

# UI escape sequences: colour runs, inline textures and atlases, hyperlinks.
#
# ⚠ THESE ARE CASE-SIGNIFICANT AND `re.I` CORRUPTS THEM. `|T` opens a texture
# and `|t` closes it, so a case-insensitive `\|T.*?\|t` happily starts on a
# CLOSING tag: spell 272123 opens "Chance to inflict|t" (a stray close, one of
# Blizzard's own typos), and the pattern then ate everything up to the next
# `|t` — deleting the sentence and leaving the icon path behind in its place.
# Found by diffing against Wowhead's rendering; do not add the flag back.
_COLOUR_RE = re.compile(r"\|[cC][0-9A-Fa-f]{8}|\|[rR]")
_TEXTURE_RE = re.compile(r"\|T.*?\|t", re.S)
_ATLAS_RE = re.compile(r"\|A.*?\|a", re.S)
_LINK_RE = re.compile(r"\|H.*?\|h(.*?)\|h", re.S)
# What is left after those four is an UNBALANCED escape — a stray `|t` with no
# `|T` in front of it, of which 9.2.7 ships several (spell 272123 opens with
# "Chance to inflict|t"). Blizzard's own typos; drop the marker, keep the word.
# Spelled as the observed escape letters rather than `\|.` so that a pipe used
# as ordinary punctuation cannot take the character after it with it.
_STRAY_BAR_RE = re.compile(r"\|[cCrRtTaAhHsSdDnN4]?")

# Encounter-journal difficulty blocks: `$[!2 ...body... $]` shows the body
# unless difficulty 2, `$[2 ...$]` only on it. Both bodies are real prose and
# the search wants all of it, so the markers go and the text stays.
_DIFFICULTY_RE = re.compile(r"\$\[!?\d+|\$\]")

_WS_BEFORE_PUNCT = re.compile(r"[ \t]+([,.;:!?%)\]])")
_MULTI_SPACE = re.compile(r"[ \t]{2,}")
_MULTI_NEWLINE = re.compile(r"\n{3,}")
_EMPTY_PARENS = re.compile(r"\(\s*\)")

MAX_DEPTH = 6  # redirect chains reach 3 in practice; the cap is the cycle stop


@dataclass
class SpellValues:
    """Every number a description can ask for, keyed by spell.

    One flat bundle rather than a reader per table: the caller fills whichever
    dicts its build actually has, and a code whose dict is empty elides exactly
    as a caster-dependent one does. That is the OPTIONAL_TABLES contract met
    without a per-version branch — a Classic build with no SpellRadius simply
    renders radius-free prose.
    """

    # spell -> effect index (1-based) -> value
    points: dict[int, dict[int, float]] = field(default_factory=dict)
    # SpellEffect.Variance — the spread `$m1 to $M1` is written around. 9.2.7
    # has no DieSides column at all, so without this the two ends of a range
    # come out identical ("Deals 2.6 to 2.6 damage", against Wowhead's 2 to 3).
    variance: dict[int, dict[int, float]] = field(default_factory=dict)
    # float throughout, including the counts: every one of them is read through
    # the same `_at` lookup and rendered by the same formatter, and a dict of
    # int is not a dict of float to a type checker
    period: dict[int, dict[int, float]] = field(default_factory=dict)  # ms
    radius: dict[int, dict[int, float]] = field(default_factory=dict)
    chain_targets: dict[int, dict[int, float]] = field(default_factory=dict)
    misc_value: dict[int, dict[int, float]] = field(default_factory=dict)
    # spell -> value
    duration: dict[int, int] = field(default_factory=dict)  # ms
    max_stacks: dict[int, int] = field(default_factory=dict)
    charges: dict[int, int] = field(default_factory=dict)
    proc_chance: dict[int, int] = field(default_factory=dict)
    max_targets: dict[int, int] = field(default_factory=dict)
    max_target_level: dict[int, int] = field(default_factory=dict)
    range_max: dict[int, float] = field(default_factory=dict)


def _num(v: float) -> str:
    """A number the way a tooltip writes one: no trailing .0, one decimal."""
    if v == int(v):
        return str(int(v))
    return f"{v:.1f}".rstrip("0").rstrip(".")


def _amount(v: float) -> str:
    """An EFFECT AMOUNT, rounded the way the client rounds one.

    Whole numbers at and above 1, because that is what the game shows and what
    Wowhead shows: the db2 stores 15.899 for a stat reduction the tooltip
    calls 16, and 2.608 for a hit it calls 3. Below 1 the decimals are the
    whole content of the number (a 0.4% chance), so they stay.
    """
    v = abs(v)
    return str(round(v)) if v >= 1 else f"{v:.2f}".rstrip("0").rstrip(".")


def format_duration(ms: int) -> str:
    """Milliseconds as the client words them — "8 sec", "1 min", "2 hours".

    A negative or absurd duration is the game's "no limit" sentinel, which the
    delivery line already words as unlimited (§3s); here it has no number to
    print, so it elides.
    """
    if ms <= 0 or ms >= 0x7FFFFFF0:
        return ""
    sec = ms / 1000
    if sec < 60:
        return f"{_num(sec)} sec"
    if sec < 3600:
        return f"{_num(sec / 60)} min"
    if sec < 86400:
        h = sec / 3600
        return f"{_num(h)} hour" + ("s" if h != 1 else "")
    d = sec / 86400
    return f"{_num(d)} day" + ("s" if d != 1 else "")


class DescriptionCooker:
    """Resolves description templates for one game version.

    Construct once per build and call `cook(spell_id, template)`; the
    per-template work is a single recursive walk with no shared mutable state
    beyond the caches, so it is safe to call in any order.
    """

    def __init__(self, descriptions: dict[int, str], aura_descriptions: dict[int, str],
                 names: dict[int, str], values: SpellValues,
                 variables: dict[int, dict[str, str]]):
        self.descriptions = descriptions
        self.aura_descriptions = aura_descriptions
        self.names = names
        self.values = values
        self.variables = variables  # spell -> {name -> template}
        self.stats = {"elided": 0, "resolved": 0}

    # ------------------------------------------------------------ public

    def cook(self, spell: int, template: str) -> str:
        """One template, rendered in `spell`'s context and tidied."""
        if not template:
            return ""
        return _tidy(self._render(template, spell, 0, ()))

    # ------------------------------------------------------- the recursion

    def _render(self, text: str, spell: int, depth: int, seen: tuple[int, ...]) -> str:
        """Resolve every construct in `text`, reading values from `spell`.

        The passes are ordered by what each one's output can still contain:
        redirects splice in whole templates (so they run first, and recurse),
        variables splice in fragments, and only once no more `$` can ARRIVE is
        it safe to evaluate expressions and substitute values.
        """
        if depth > MAX_DEPTH:
            return ""
        text = self._expand_redirects(text, spell, depth, seen)
        text = self._expand_variables(text, spell, depth)
        text = self._resolve_conditionals(text, spell, depth)
        # Difficulty markers are spelled with a `$` (`$[!2 … $]`), so they have
        # to go BEFORE code substitution — which ends by deleting every `$`
        # still standing and would otherwise leave a bare "[!2" in the prose.
        text = _DIFFICULTY_RE.sub("", text)
        text = self._eval_expressions(text, spell)
        text = self._substitute_codes(text, spell)
        return _strip_markup(text)

    def _expand_redirects(self, text: str, spell: int, depth: int,
                          seen: tuple[int, ...]) -> str:
        """`$@spelldescN` and friends — splice in another spell's own text.

        The spliced body is rendered in the TARGET's context, which is the
        whole reason this cannot be a flat substitution table.
        """

        def sub(m: re.Match[str]) -> str:
            kind, target = m.group(1), int(m.group(2))
            if kind == "spellicon":
                return ""
            if kind == "spellname":
                return self.names.get(target, "")
            if target in seen:  # A -> B -> A; the game shows nothing either
                return ""
            body = (self.aura_descriptions if kind == "spellaura"
                    else self.descriptions).get(target, "")
            if not body:
                return ""
            return self._render(body, target, depth + 1, seen + (target,))

        text = _AT_RE.sub(sub, text)
        return _AT_OTHER_RE.sub("", text)

    def _expand_variables(self, text: str, spell: int, depth: int) -> str:
        """`$<shield>` — a named template from SpellDescriptionVariables."""
        if "$<" not in text:
            return text
        table = self.variables.get(spell, {})

        def sub(m: re.Match[str]) -> str:
            body = table.get(m.group(1))
            if body is None:
                return ""
            return self._render(body, spell, depth + 1, ())

        return _VAR_RE.sub(sub, text)

    # ------------------------------------------------------- conditionals

    def _resolve_conditionals(self, text: str, spell: int, depth: int) -> str:
        """`$?c1[A]?c2[B]…[default]` — take the DEFAULT branch, as Wowhead does.

        ⚠ IT IS A SWITCH, NOT AN IF/ELSE, and reading it as one was worth a
        whole spell's text. Spell 342156 chains twelve conditions before its
        default — `$?a137005[Abomination Limb]?a212611[Fodder to the Flame]…
        [Activating your Necrolord class ability] increases your…` — with a
        single `$` at the very front. A two-bracket parser consumes the first
        pair, emits nothing, and leaves `?a212611[Fodder to the Flame]?a…` in
        the output as literal text. `$?c[A][B]` is just this shape with one
        condition, so the chain parser subsumes it rather than special-casing.

        Every condition asks about the CASTER — which talent, which aura, which
        class — and the app has no caster. The trailing unconditioned bracket
        is the game's own "none of the above", which is both the honest answer
        and the one Wowhead's default rendering shows. Where there is no
        default (the common `$?s12345[ …talent text…][]` shape) the result is
        empty, i.e. the optional line simply does not appear.
        """
        out: list[str] = []
        i = 0
        while True:
            j = text.find("$?", i)
            if j < 0:
                out.append(text[i:])
                break
            out.append(text[i:j])
            # walk the whole `?cond[…]` chain, keeping only the last bracket
            # that had no condition in front of it
            pos, default, consumed = j + 1, "", False
            while pos < len(text) and text[pos] == "?":
                k = text.find("[", pos)
                if k < 0:
                    break
                body, after = _balanced(text, k)
                if body is None:
                    break
                pos, consumed = after, True
            if not consumed:  # a bare `$?` that opens nothing; not a conditional
                out.append(text[j:j + 2])
                i = j + 2
                continue
            if pos < len(text) and text[pos] == "[":
                body, after = _balanced(text, pos)
                if body is not None:
                    default, pos = body, after
            out.append(self._render(default, spell, depth + 1, ()) if default else "")
            i = pos
        return "".join(out)

    # -------------------------------------------------------- expressions

    def _eval_expressions(self, text: str, spell: int) -> str:
        """`${$s1*$<mult>}` — arithmetic, ALL-OR-NOTHING.

        Every operand must resolve to a number; one caster-dependent term and
        the whole expression elides. A partially-evaluated expression would
        print a confidently wrong figure, which is worse than printing none.
        """
        out: list[str] = []
        i = 0
        while True:
            j = text.find("${", i)
            if j < 0:
                out.append(text[i:])
                break
            out.append(text[i:j])
            body, after = _balanced(text, j + 1, "{", "}")
            if body is None:
                out.append(text[j:j + 2])
                i = j + 2
                continue
            out.append(self._eval(body, spell))
            i = after
        return "".join(out)

    def _eval(self, body: str, spell: int) -> str:
        """Evaluate one expression body, or return "" if anything is unknown."""
        # nested expressions first, innermost out
        while "${" in body:
            k = body.find("${")
            inner, after = _balanced(body, k + 1, "{", "}")
            if inner is None:
                return ""
            val = self._eval(inner, spell)
            if not val:
                return ""
            body = body[:k] + val + body[after:]

        def sub(m: re.Match[str]) -> str:
            v = self._value(m, spell, numeric=True)
            return v if v else "\0"  # a sentinel no arithmetic can survive

        # The caster-dependent words go first and DELIBERATELY, as the sentinel
        # rather than as "": `$RAP` would otherwise reach _CODE_RE, match `$R`
        # as a range and leave a stray "P" — which happens to fail the digits
        # check below and elide anyway. Relying on that would be relying on an
        # accident; a term we cannot know must kill the expression on purpose.
        body = _ELIDED_WORD_RE.sub("\0", body)
        body = _JGF_RE.sub("\0", body)
        body = self._apply_scales(body, spell, numeric=True)
        body = _CODE_RE.sub(sub, body)
        if "\0" in body or "$" in body:
            return ""
        body = body.replace("|", "")  # stray colour markers inside an expression
        if not re.fullmatch(r"[-+*/(). 0-9]+", body):
            return ""
        try:
            value = eval(body, {"__builtins__": {}}, {})  # noqa: S307 - digits and operators only
        except (SyntaxError, ZeroDivisionError, TypeError, NameError):
            return ""
        if not isinstance(value, (int, float)):
            return ""
        return _amount(value)

    # ------------------------------------------------------------- values

    def _substitute_codes(self, text: str, spell: int) -> str:
        """Replace every remaining `$code` with its value, or with nothing."""
        text = _ELIDED_WORD_RE.sub("", text)
        text = _JGF_RE.sub("", text)
        text = _GENDER_RE.sub(lambda m: m.group(1), text)  # no caster; pick one
        text = self._apply_scales(text, spell)
        text = _CODE_RE.sub(lambda m: self._value(m, spell), text)
        # plurals last: the number they have to agree with only exists now
        text = _resolve_plurals(text)
        return text.replace("$", "")

    def _apply_scales(self, text: str, spell: int, numeric: bool = False) -> str:
        """`$/10;s2` — a scale factor and the code it scales, as one token."""

        def sub(m: re.Match[str]) -> str:
            # the id may be written before the operator or after it
            target = m.group(4) or m.group(1)
            code = _CODE_RE.match(f"${target}{m.group(5)}{m.group(6)}")
            raw = self._value(code, spell, numeric=True) if code else ""
            if not raw:
                return ""
            v = float(raw)
            v = v / float(m.group(3)) if m.group(2) == "/" else v * float(m.group(3))
            return _num(round(v, 3)) if numeric else _amount(v)

        return _SCALE_RE.sub(sub, text)

    def _value(self, m: re.Match[str], spell: int, numeric: bool = False) -> str:
        """One `$[spell]<letter>[index]` code as text, or "" when unknowable."""
        target = int(m.group(1)) if m.group(1) else spell
        letter, index = m.group(2), int(m.group(3) or 1)
        what = CODE_MEANING.get(letter)
        if what is None:
            self.stats["elided"] += 1
            return ""
        v = self.values
        got: float | None = None
        if what == "points":
            got = _at(v.points, target, index)
        elif what in ("points_min", "points_max"):
            base = _at(v.points, target, index)
            spread = (_at(v.variance, target, index) or 0) / 2
            got = None if base is None else base * (
                1 - spread if what == "points_min" else 1 + spread)
        elif what == "points_per_combo":
            got = _at(v.points, target, index)
        elif what == "points_total":
            base = _at(v.points, target, index)
            period, dur = _at(v.period, target, index), v.duration.get(target)
            got = (None if base is None or not period or not dur
                   else base * max(1, round(dur / period)))
        elif what == "period":
            ms = _at(v.period, target, index)
            got = None if not ms else ms / 1000
        elif what == "radius":
            got = _at(v.radius, target, index)
        elif what == "chain_targets":
            got = _at(v.chain_targets, target, index)
        elif what == "misc_value":
            got = _at(v.misc_value, target, index)
        elif what == "max_stacks":
            got = v.max_stacks.get(target)
        elif what == "charges":
            got = v.charges.get(target)
        elif what == "proc_chance":
            got = v.proc_chance.get(target)
        elif what == "max_targets":
            got = v.max_targets.get(target)
        elif what == "max_target_level":
            got = v.max_target_level.get(target)
        elif what == "range":
            got = v.range_max.get(target)
        elif what == "duration":
            ms = v.duration.get(target)
            if ms is None:
                self.stats["elided"] += 1
                return ""
            out = _num(ms / 1000) if numeric else format_duration(ms)
            self.stats["resolved" if out else "elided"] += 1
            return out
        if got is None or got == 0:
            # A zero is the client's "computed at runtime" — every modern player
            # spell scales, and printing "Deals 0 Frost damage" is the one
            # outcome worse than printing nothing at all. (Wowhead does print
            # it: spell 17 renders "absorbing 0 damage" there.)
            self.stats["elided"] += 1
            return ""
        self.stats["resolved"] += 1
        # inside an expression the value is an OPERAND, so it keeps its
        # precision; on its own it is a figure a reader sees, so it rounds
        return _num(abs(round(got, 3))) if numeric else _amount(got)


# -------------------------------------------------------------- helpers

def _at(table: dict[int, dict[int, float]], spell: int, index: int) -> float | None:
    return table.get(spell, {}).get(index)


def _balanced(text: str, start: int, open_ch: str = "[", close_ch: str = "]"
              ) -> tuple[str | None, int]:
    """The body of the bracket at `start`, and the index just past its close.

    Brackets NEST — a conditional's branch routinely holds another one — so a
    naive `find(close)` cuts in the middle of the inner construct and the two
    halves both come out as garbage.
    """
    if start >= len(text) or text[start] != open_ch:
        return None, start
    level = 0
    for i in range(start, len(text)):
        if text[i] == open_ch:
            level += 1
        elif text[i] == close_ch:
            level -= 1
            if level == 0:
                return text[start + 1:i], i + 1
    return None, start


def _resolve_plurals(text: str) -> str:
    """`$lpoint:points;` — singular when the number before it is exactly 1.

    With the number elided there is nothing to agree with, and the plural is
    the form that reads as a general statement ("combo points"), so it wins.
    """

    def pick(m: re.Match[str]) -> str:
        # The LAST number in the run before it, not the character immediately
        # before: the client agrees with the quantity, and a noun sits between
        # them as often as not — "Awards $s3 combo $lpoint:points;".
        before = re.findall(r"\d+(?:\.\d+)?", text[max(0, m.start() - 60):m.start()])
        singular = bool(before) and float(before[-1]) == 1
        return m.group(1) if singular else m.group(2)

    text = _PLURAL_RE.sub(pick, text)
    return _BAR_PLURAL_RE.sub(pick, text)


def _strip_markup(text: str) -> str:
    """Remove the UI escape sequences, keeping the words they wrapped.

    Balanced constructs first so their bodies go with them; the catch-all for
    unbalanced leftovers only ever sees Blizzard's typos.
    """
    text = _TEXTURE_RE.sub("", text)
    text = _ATLAS_RE.sub("", text)
    text = _LINK_RE.sub(lambda m: m.group(1), text)
    text = _COLOUR_RE.sub("", text)
    return _STRAY_BAR_RE.sub("", text)


def _tidy(text: str) -> str:
    """Close the gaps eliding left behind, without rewriting the prose.

    Only whitespace and empty brackets are touched. Repairing grammar ("causing
    Nature damage" -> "causing damage") would be inventing text, and the point
    of eliding was to stop doing that.
    """
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = _EMPTY_PARENS.sub("", text)
    text = _MULTI_SPACE.sub(" ", text)
    text = _WS_BEFORE_PUNCT.sub(r"\1", text)
    text = _MULTI_NEWLINE.sub("\n\n", text)
    text = "\n".join(line.strip() for line in text.split("\n"))
    return text.strip()

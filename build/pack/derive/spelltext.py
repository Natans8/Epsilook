"""Cook a spell description template into placeholder-free prose.

The client stores a description as a template resolved at tooltip time against
the caster's own state. The cooked string here is search text, so the rule is
never to print a number this data cannot justify and never to leave a `$`.
That splits every code in two: a code whose value is in a db2 already read is
substituted, and one that depends on the caster or the UI is elided, leaving
the sentence around it intact.

Two rules the rest of the module turns on. An expression is all or nothing:
one caster-dependent operand elides the whole `${...}`, because half an
arithmetic expression is a wrong answer rather than a smaller one. And the
context spell changes on a redirect: `$@spelldesc159001` inserts 159001's
template, whose `$s1` means 159001's first effect, so resolution is a recursion
carrying the context spell rather than one substitution pass.

The values are the build's own, which is the right answer for a build-pinned
pack even where it disagrees with a site rendering a later patch.
"""

from __future__ import annotations

import ast
import operator
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass

from ..routes.values import DescriptionValues

# letter -> what a DescriptionValues lookup should return. Several letters are the
# same quantity under different spellings: `$w1`, `$W1`, `$S1` and `$e1` all
# read an effect's amount exactly as `$s1` does.
POINTS_CODES = "sSwWe"
CODE_MEANING = {
    **{c: "points" for c in POINTS_CODES},
    "m": "points_min",
    "M": "points_max",
    "o": "points_total",  # amount times ticks over the full duration
    "b": "points_per_combo",
    "t": "period",
    "T": "period",
    "a": "radius",
    "A": "radius",
    "x": "chain_targets",
    "i": "max_targets",
    "I": "max_targets",
    "q": "misc_value",
    "d": "duration",
    "D": "duration",
    "u": "max_stacks",
    "U": "max_stacks",
    "n": "charges",
    "h": "proc_chance",
    "r": "range",
    "R": "range",
    "v": "max_target_level",
}

# Codes spelled as a word rather than a letter. Every one depends on the
# caster, on gear or on the UI, so all of them can only be elided.
#
# The alternation is sorted longest-first, and that is load-bearing: a regex
# alternation takes the first branch that matches, so with "AP" ahead of "RAP"
# the string `$RAP` reads as `$R` (a range) followed by the letters "AP", which
# fabricates a number mid-sentence. Sorting here means adding a word cannot
# reintroduce that.
LEVEL_WORDS = ("PL", "pl")
"""Codes meaning "the caster's level".

Resolved at the build's level cap rather than elided. A tooltip resolves these
against whoever is casting; here there is no caster, and the level a reader
cares about is the one they play at -- so the cap is the one answer that is
right for more of them than any other. Eliding instead left sentences like
"targets over level." with the number cut out of the middle.
"""

ELIDED_WORDS = [
    # caster stats and scaling
    "RAP",
    "AP",
    "SP",
    "MWB",
    "mwb",
    "MHP",
    "pri",
    "INT",
    "STR",
    "AGI",
    "STA",
    "SPI",
    "versadmg",
    "abs",
    # weapon damage, enchant values, item-level scaling
    "ecix",
    "ec",
    "bc",
    "sw",
    "mw",
    # proc/cast bookkeeping the tooltip computes at runtime
    "proccooldown",
    "procrppm",
    "maxcast",
    # creature-level bands, UI markers, the player's hearth
    "ctrmax",
    "ctrmin",
    "lootspec",
    "bullet",
    "expandtiptag",
    # malformed redirects such as `$347182spelldesc`, whose `@` is in the wrong
    # place, so the redirect pass never sees them
    "spelldesc",
    "spellaura",
    "spelltooltip",
    "spellname",
    "spellicon",
]
# The trailing `;` is part of the token for the ones that carry one (`$bullet;`)
# and absent for the rest, so it is optional.
_ELIDED_WORD_RE = re.compile(r"\$\d*(" + "|".join(sorted(ELIDED_WORDS, key=len, reverse=True)) + r")\d*;?")

# The level codes, matched the same way the elided ones are. Kept as its own
# pattern so the two lists cannot both claim a word: a code in both would be
# substituted or dropped depending on which pass ran first.
_LEVEL_WORD_RE = re.compile(r"\$\d*(" + "|".join(sorted(LEVEL_WORDS, key=len, reverse=True)) + r")\d*;?")

# `$j1g` / `$j1f` — the ground and flight halves of a mount's speed effect.
# Two letters with the index between them, so the generic code regex would read
# `$j1` and leave a stray "g".
_JGF_RE = re.compile(r"\$\d*j\d*[gf]")

# `$g male:female;` is the caster's gender, which this has no way to know.
_GENDER_RE = re.compile(r"\$[gG]([^:;]*):([^;]*);")
# One capture of the whole form list; the picker splits on ":" and asks the
# locale which form the number in front of it takes.
_PLURAL_RE = re.compile(r"\$[lL]([^;]*:[^;]*);")
_BAR_PLURAL_RE = re.compile(r"\|4([^;]*:[^;]*);")

# `$/10;s2`, `$*2;23478s1` and `$45548/5;s1` — a divisor or multiplier glued to
# the code it scales. The scaled code carries no `$` of its own, so it needs
# its own pattern, and the spell id may sit on either side of the operator.
_SCALE_RE = re.compile(r"\$(\d*)([/*])(\d+(?:\.\d+)?);(\d*)([a-zA-Z])(\d*)")

# `$<shield>` — a named variable from SpellDescriptionVariables, whose body is
# itself a template evaluated in the same spell's context.
_VAR_RE = re.compile(r"\$<([^>]+)>")

# `$@spelldesc159001` and friends. `$@spellicon` names art and is dropped.
_AT_RE = re.compile(r"\$@(spelldesc|spellaura|spelltooltip|spellname|spellicon)(\d+)")
_AT_OTHER_RE = re.compile(r"\$@+[A-Za-z]\w*\d*")

# `$12345s1` (another spell's effect) or `$s1` (this spell's). The optional
# leading digits are a spell id, the optional trailing ones an effect index.
# `l` and `L` are excluded: a plural can only be picked once the number in
# front of it exists, so it has to survive this pass and be resolved after it.
_CODE_RE = re.compile(r"\$(\d*)([a-km-zA-KM-Z])(\d*)")

# UI escape sequences: colour runs, inline textures and atlases, hyperlinks.
#
# These are case-significant and `re.I` corrupts them. `|T` opens a texture and
# `|t` closes it, so a case-insensitive `\|T.*?\|t` can start on a closing tag
# and eat everything up to the next `|t`, deleting the sentence and leaving the
# icon path in its place. Do not add the flag.
_COLOUR_RE = re.compile(r"\|[cC][0-9A-Fa-f]{8}|\|[rR]")
_TEXTURE_RE = re.compile(r"\|T.*?\|t", re.S)
_ATLAS_RE = re.compile(r"\|A.*?\|a", re.S)
_LINK_RE = re.compile(r"\|H.*?\|h(.*?)\|h", re.S)
# What is left after those four is an unbalanced escape, of which the game
# ships several. Spelled as the observed escape letters rather than `\|.`, so
# that a pipe used as ordinary punctuation cannot take the next character.
_STRAY_BAR_RE = re.compile(r"\|[cCrRtTaAhHsSdDnN4]?")

# Encounter-journal difficulty blocks: `$[!2 ...body... $]` shows the body
# unless difficulty 2, `$[2 ...$]` only on it. Both bodies are prose the search
# wants, so the markers go and the text stays.
_DIFFICULTY_RE = re.compile(r"\$\[!?\d+|\$\]")

_WS_BEFORE_PUNCT = re.compile(r"[ \t]+([,.;:!?%)\]])")
_MULTI_SPACE = re.compile(r"[ \t]{2,}")
_MULTI_NEWLINE = re.compile(r"\n{3,}")
_EMPTY_PARENS = re.compile(r"\(\s*\)")

MAX_DEPTH = 6  # redirect chains reach 3 in practice; the cap is the cycle stop


_ARITHMETIC: Mapping[type[ast.operator], Callable[[float, float], float]] = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.FloorDiv: operator.floordiv,
    ast.Pow: operator.pow,
}
"""The binary operators a template expression may use."""

_SIGNS: Mapping[type[ast.unaryop], Callable[[float], float]] = {
    ast.UAdd: operator.pos,
    ast.USub: operator.neg,
}
"""The unary operators a template expression may use."""


def _folded(node: ast.expr) -> float:
    """One node of a parsed template expression, as its value.

    Raises:
        TypeError: the node is not arithmetic. Everything a template can
            legitimately hold by this point is a number, a sign or a binary
            operator, so anything else is a body that only looked like a sum.
    """
    # bool is a subclass of int, and `True` is not a quantity a template
    # means -- the character filter upstream keeps letters out, but this
    # function is the one that decides what counts as a number.
    if isinstance(node, ast.Constant) and not isinstance(node.value, bool) and isinstance(node.value, (int, float)):
        return node.value
    if isinstance(node, ast.BinOp):
        fold = _ARITHMETIC.get(type(node.op))
        if fold is not None:
            return fold(_folded(node.left), _folded(node.right))
    if isinstance(node, ast.UnaryOp):
        sign = _SIGNS.get(type(node.op))
        if sign is not None:
            return sign(_folded(node.operand))
    raise TypeError(f"{type(node).__name__} is not arithmetic")


def _arithmetic(body: str) -> float | None:
    """The value of a resolved template expression, or None if it has none.

    The body reaching here is digits and operators, every code already
    substituted. It is still parsed rather than evaluated: the grammar admits
    shapes that are not sums -- `(1)(2)` is a call, `1 2` is not an expression
    at all -- and a parser refuses those by construction instead of relying on
    a character filter to have thought of them.

    Stripped first: a substituted code readily leaves the body opening on a
    space, and the parser reads that as an indent where evaluation would have
    skipped it.
    """
    try:
        tree = ast.parse(body.strip(), mode="eval")
    except (SyntaxError, ValueError, MemoryError, RecursionError):
        return None
    try:
        return _folded(tree.body)
    except (ArithmeticError, TypeError, ValueError, RecursionError):
        return None


def _num(v: float) -> str:
    """A number the way a tooltip writes one: no trailing .0, one decimal."""
    if v == int(v):
        return str(int(v))
    return f"{v:.1f}".rstrip("0").rstrip(".")


def _amount(v: float) -> str:
    """An effect amount, rounded the way the client rounds one.

    Whole numbers at and above 1. Below 1 the decimals are the whole content of
    the number, such as a 0.4% chance, so they stay.
    """
    v = abs(v)
    return str(round(v)) if v >= 1 else f"{v:.2f}".rstrip("0").rstrip(".")


@dataclass(frozen=True)
class TextLocale:
    """Locale-dependent wording for cooked prose.

    What differs by locale is the wording the cooker supplies -- duration units
    -- and how a plural marker picks among its forms. A form list is
    variable-length, so the picking rule belongs to the locale.
    """

    seconds: tuple[str, ...] = ("sec",)
    minutes: tuple[str, ...] = ("min",)
    hours: tuple[str, ...] = ("hour", "hours")
    days: tuple[str, ...] = ("day", "days")

    def plural_index(self, n: float | None, nforms: int) -> int:
        """Index into a plural marker's form list for quantity `n`.

        `None` means the number was elided; the last form is then taken, being
        the one that reads as a general statement.
        """
        return 0 if n == 1 and nforms > 1 else nforms - 1


class _RussianTextLocale(TextLocale):
    def plural_index(self, n: float | None, nforms: int) -> int:
        """Russian one/few/many: 1 is one, 2-4 few, 5+ and 11-14 many.

        A fractional quantity takes the few form, matching how the client words
        it. Two-form markers clamp few onto the last form.
        """
        if n is None:
            return nforms - 1
        if n != int(n):
            return min(1, nforms - 1)
        tail = int(n) % 100
        if 11 <= tail <= 14:
            return nforms - 1
        tail %= 10
        if tail == 1:
            return 0
        if 2 <= tail <= 4:
            return min(1, nforms - 1)
        return nforms - 1


class _FrenchTextLocale(TextLocale):
    def plural_index(self, n: float | None, nforms: int) -> int:
        """French singular covers nought as well as one, and a fraction below
        two with it."""
        if n is None:
            return nforms - 1
        return 0 if n < 2 and nforms > 1 else nforms - 1


ENGLISH = TextLocale()
RUSSIAN = _RussianTextLocale(seconds=("сек",), minutes=("мин",), hours=("ч",), days=("дн.",))
# Read from how each client's own templates word a duration beside a number,
# rather than guessed. The same measurement over the English templates returns
# `sec`, `min`, `hour`/`hours` and `day`/`days`, which is exactly what this
# file already supplied for English -- so it recovers a known answer, and the
# convention it recovers is the one applied here: the short unit abbreviates
# for seconds and minutes and is spelled out from hours up.
FRENCH = _FrenchTextLocale(seconds=("s",), minutes=("min",), hours=("heure", "heures"), days=("jour", "jours"))
# Spanish pluralises as English does -- one is one, everything else is not.
SPANISH = TextLocale(seconds=("s",), minutes=("min",), hours=("hora", "horas"), days=("día", "días"))


def format_duration(ms: int, locale: TextLocale = ENGLISH) -> str:
    """Milliseconds as the client words them: "8 sec", "1 min", "2 hours".

    A negative or absurd duration is the game's "no limit" sentinel; it has no
    number to print, so it elides.
    """
    if ms <= 0 or ms >= 0x7FFFFFF0:
        return ""

    def word(value: float, forms: tuple[str, ...]) -> str:
        return f"{_num(value)} {forms[locale.plural_index(value, len(forms))]}"

    sec = ms / 1000
    if sec < 60:
        return word(sec, locale.seconds)
    if sec < 3600:
        return word(sec / 60, locale.minutes)
    if sec < 86400:
        return word(sec / 3600, locale.hours)
    return word(sec / 86400, locale.days)


class DescriptionCooker:
    """Resolves description templates for one game version.

    Construct once per build and call `cook(spell_id, template)`. Templates may
    be cooked in any order.
    """

    def __init__(
        self,
        descriptions: dict[int, str],
        aura_descriptions: dict[int, str],
        names: dict[int, str],
        values: DescriptionValues,
        variables: dict[int, dict[str, str]],
        locale: TextLocale = ENGLISH,
    ):
        self.descriptions = descriptions
        self.aura_descriptions = aura_descriptions
        self.names = names
        self.values = values
        self.variables = variables  # spell -> {name -> template}
        self.locale = locale
        self._level = str(values.level) if values.level else ""
        """What a level code prints, read off the values it was resolved with.

        Empty when no level was supplied, so an unknown level is elided rather
        than printed as a zero."""
        self.stats = {"elided": 0, "resolved": 0}

    def cook(self, spell: int, template: str) -> str:
        """One template, rendered in `spell`'s context and tidied."""
        if not template:
            return ""
        return _tidy(self._render(template, spell, 0, ()))

    def _render(self, text: str, spell: int, depth: int, seen: tuple[int, ...]) -> str:
        """Resolve every construct in `text`, reading values from `spell`.

        The passes are ordered by what each one's output can still contain:
        redirects splice in whole templates, variables splice in fragments, and
        only once no more `$` can arrive is it safe to evaluate expressions and
        substitute values.
        """
        if depth > MAX_DEPTH:
            return ""
        text = self._expand_redirects(text, depth, seen)
        text = self._expand_variables(text, spell, depth)
        text = self._resolve_conditionals(text, spell, depth)
        # Difficulty markers are spelled with a `$`, so they go before code
        # substitution, which ends by deleting every `$` still standing and
        # would otherwise leave a bare "[!2" in the prose.
        text = _DIFFICULTY_RE.sub("", text)
        text = self._eval_expressions(text, spell)
        text = self._substitute_codes(text, spell)
        return _strip_markup(text)

    def _expand_redirects(self, text: str, depth: int, seen: tuple[int, ...]) -> str:
        """`$@spelldescN` and friends: splice in another spell's own text.

        The spliced body is rendered in the target's context.
        """

        def sub(m: re.Match[str]) -> str:
            kind, target = m.group(1), int(m.group(2))
            if kind == "spellicon":
                return ""
            if kind == "spellname":
                return self.names.get(target, "")
            if target in seen:  # A -> B -> A; the game shows nothing either
                return ""
            body = (self.aura_descriptions if kind == "spellaura" else self.descriptions).get(target, "")
            if not body:
                return ""
            return self._render(body, target, depth + 1, seen + (target,))

        text = _AT_RE.sub(sub, text)
        return _AT_OTHER_RE.sub("", text)

    def _expand_variables(self, text: str, spell: int, depth: int) -> str:
        """`$<shield>`: a named template from SpellDescriptionVariables."""
        if "$<" not in text:
            return text
        table = self.variables.get(spell, {})

        def sub(m: re.Match[str]) -> str:
            body = table.get(m.group(1))
            if body is None:
                return ""
            return self._render(body, spell, depth + 1, ())

        return _VAR_RE.sub(sub, text)

    def _resolve_conditionals(self, text: str, spell: int, depth: int) -> str:
        """`$?c1[A]?c2[B]...[default]`: take the default branch.

        It is a switch, not an if/else: one `$` can front a chain of a dozen
        conditions, and a two-bracket parser leaves the rest in the output as
        literal text. `$?c[A][B]` is the same shape with one condition.

        Every condition asks about the caster, and there is no caster here, so
        the trailing unconditioned bracket wins. Where there is no default the
        result is empty and the optional line does not appear.
        """
        out: list[str] = []
        i = 0
        while True:
            j = text.find("$?", i)
            if j < 0:
                out.append(text[i:])
                break
            out.append(text[i:j])
            # walk the whole `?cond[...]` chain, keeping only the last bracket
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
                out.append(text[j : j + 2])
                i = j + 2
                continue
            if pos < len(text) and text[pos] == "[":
                body, after = _balanced(text, pos)
                if body is not None:
                    default, pos = body, after
            out.append(self._render(default, spell, depth + 1, ()) if default else "")
            i = pos
        return "".join(out)

    def _eval_expressions(self, text: str, spell: int) -> str:
        """`${$s1*$<mult>}`: arithmetic, all or nothing.

        Every operand must resolve to a number; one caster-dependent term
        elides the whole expression.
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
                out.append(text[j : j + 2])
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

        # Level first, since it is a number this build knows and the words pass
        # below would otherwise swallow it.
        body = _LEVEL_WORD_RE.sub(self._level or "\0", body)
        # The caster-dependent words go next, and as the sentinel rather than
        # as "": `$RAP` would otherwise reach _CODE_RE, match `$R` as a range
        # and leave a stray "P". A term that cannot be known must kill the
        # expression on purpose rather than by accident.
        body = _ELIDED_WORD_RE.sub("\0", body)
        body = _JGF_RE.sub("\0", body)
        body = self._apply_scales(body, spell, numeric=True)
        body = _CODE_RE.sub(sub, body)
        if "\0" in body or "$" in body:
            return ""
        body = body.replace("|", "")  # stray colour markers inside an expression
        if not re.fullmatch(r"[-+*/(). 0-9]+", body):
            return ""
        value = _arithmetic(body)
        if value is None:
            return ""
        return _amount(value)

    def _substitute_codes(self, text: str, spell: int) -> str:
        """Replace every remaining `$code` with its value, or with nothing."""
        text = _LEVEL_WORD_RE.sub(self._level, text)
        text = _ELIDED_WORD_RE.sub("", text)
        text = _JGF_RE.sub("", text)
        text = _GENDER_RE.sub(lambda m: m.group(1), text)  # no caster; pick one
        text = self._apply_scales(text, spell)
        text = _CODE_RE.sub(lambda m: self._value(m, spell), text)
        # plurals last: the number they have to agree with only exists now
        text = _resolve_plurals(text, self.locale)
        return text.replace("$", "")

    def _apply_scales(self, text: str, spell: int, numeric: bool = False) -> str:
        """`$/10;s2`: a scale factor and the code it scales, as one token."""

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
            got = None if base is None else base * (1 - spread if what == "points_min" else 1 + spread)
        elif what == "points_per_combo":
            got = _at(v.points, target, index)
        elif what == "points_total":
            base = _at(v.points, target, index)
            period, dur = _at(v.period, target, index), v.duration.get(target)
            got = None if base is None or not period or not dur else base * max(1, round(dur / period))
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
            out = _num(ms / 1000) if numeric else format_duration(ms, self.locale)
            self.stats["resolved" if out else "elided"] += 1
            return out
        if got is None or got == 0:
            # A zero is the client's "computed at runtime": every modern player
            # spell scales, and "Deals 0 Frost damage" is worse than saying
            # nothing.
            self.stats["elided"] += 1
            return ""
        self.stats["resolved"] += 1
        # inside an expression the value is an operand and keeps its precision;
        # on its own it is a figure a reader sees, so it rounds
        return _num(abs(round(got, 3))) if numeric else _amount(got)


def _at(table: dict[int, dict[int, float]], spell: int, index: int) -> float | None:
    return table.get(spell, {}).get(index)


def _balanced(text: str, start: int, open_ch: str = "[", close_ch: str = "]") -> tuple[str | None, int]:
    """The body of the bracket at `start`, and the index just past its close.

    Brackets nest -- a conditional's branch routinely holds another one -- so a
    naive `find(close)` would cut in the middle of the inner construct.
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
                return text[start + 1 : i], i + 1
    return None, start


def _resolve_plurals(text: str, locale: TextLocale = ENGLISH) -> str:
    """`$lpoint:points;`: the form agreeing with the number in front of it.

    With the number elided there is nothing to agree with, so the last form
    wins, being the one that reads as a general statement.
    """

    def pick(m: re.Match[str]) -> str:
        # The last number in the run before it, not the character immediately
        # before: a noun sits between the two as often as not.
        before = re.findall(r"\d+(?:\.\d+)?", text[max(0, m.start() - 60) : m.start()])
        n = float(before[-1]) if before else None
        forms = m.group(1).split(":")
        return forms[locale.plural_index(n, len(forms))]

    text = _PLURAL_RE.sub(pick, text)
    return _BAR_PLURAL_RE.sub(pick, text)


def _strip_markup(text: str) -> str:
    """Remove the UI escape sequences, keeping the words they wrapped.

    Balanced constructs go first, so their bodies go with them.
    """
    text = _TEXTURE_RE.sub("", text)
    text = _ATLAS_RE.sub("", text)
    text = _LINK_RE.sub(lambda m: m.group(1), text)
    text = _COLOUR_RE.sub("", text)
    return _STRAY_BAR_RE.sub("", text)


def _tidy(text: str) -> str:
    """Close the gaps eliding left behind, without rewriting the prose.

    Only whitespace and empty brackets are touched: repairing grammar would be
    inventing text.
    """
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = _EMPTY_PARENS.sub("", text)
    text = _MULTI_SPACE.sub(" ", text)
    text = _WS_BEFORE_PUNCT.sub(r"\1", text)
    text = _MULTI_NEWLINE.sub("\n\n", text)
    text = "\n".join(line.strip() for line in text.split("\n"))
    return text.strip()

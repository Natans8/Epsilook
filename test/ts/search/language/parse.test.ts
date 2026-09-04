import {strict as assert} from "node:assert";
import {describe, it} from "node:test";

import type {Ask, Clause, Diagnostic, Parsed, ScopeTerm, ValueExpr} from "../../../../src/search/index";
import {equivalent, fold, formatQuery, KINDS, parse, wordOf} from "../../../../src/search/index";

/* ------------------------------------------------------------------ helpers */

type ColumnAsk = Extract<Ask, { on: "column" }>;
type KindAsk = Extract<Ask, { on: "kind" }>;
type ScopeTest = Extract<NonNullable<ColumnAsk["test"]>, { is: "scope" }>;

const errors = (parsed: Parsed): Diagnostic[] => parsed.diagnostics.filter((d) => d.severity === "error");
const warnings = (parsed: Parsed): Diagnostic[] => parsed.diagnostics.filter((d) => d.severity === "warning");
const notes = (parsed: Parsed): Diagnostic[] => parsed.diagnostics.filter((d) => d.severity === "note");

/** Parses expecting exactly one clause, and returns it. */
function one(query: string): Clause {
    const parsed = parse(query);
    assert.equal(parsed.clauses.length, 1, `${query}: expected one clause`);
    return parsed.clauses[0];
}

/** Parses expecting one valid clause with no error, and returns its ask. */
function ok(query: string): Ask {
    const parsed = parse(query);
    assert.equal(parsed.clauses.length, 1, `${query}: expected one clause`);
    assert.equal(parsed.clauses[0].state, "ok", `${query}: expected ok`);
    assert.deepEqual(errors(parsed), [], `${query}: expected no errors`);
    assert.notEqual(parsed.clauses[0].ask, null);
    return parsed.clauses[0].ask as Ask;
}

/** Parses in final mode expecting one invalid clause, and returns its error diagnostics. */
function invalid(query: string): Diagnostic[] {
    const parsed = parse(query);
    assert.equal(parsed.clauses.length, 1, `${query}: expected one clause`);
    assert.equal(parsed.clauses[0].state, "invalid", `${query}: expected invalid`);
    const found = errors(parsed);
    assert.ok(found.length > 0, `${query}: expected an error diagnostic`);
    return found;
}

/** The ok scope terms of a scope-shaped ask, flattened over alternation groups. */
function termsOf(ask: Ask): readonly ScopeTerm[] {
    const test = (ask as ColumnAsk | KindAsk).test;
    assert.ok(test !== null && test.is === "scope");
    return (test as ScopeTest).terms.flat();
}

const valueOf = (ask: Ask): ValueExpr => {
    if (ask.on === "plain") return ask.value;
    if (ask.on === "prop") {
        assert.ok(ask.value !== null);
        return ask.value;
    }
    const test = ask.test;
    assert.ok(test !== null && (test.is === "content" || test.is === "props"));
    return test.value;
};

/** The ask with spans stripped, for comparing one spelling's structure against another's. */
const shape = (query: string): unknown =>
    JSON.parse(JSON.stringify(ok(query), (key: string, value: unknown) => (key === "span" ? undefined : value)));

/* ------------------------------------------------------------------ tier 2: the documented language */

describe("clauses and alternation", () => {
    it("splits clauses on whitespace and negates with a leading dash", () => {
        const parsed = parse("model:fire -sound:ice");
        assert.equal(parsed.clauses.length, 2);
        assert.equal(parsed.clauses[0].not, false);
        assert.equal(parsed.clauses[1].not, true);
        assert.deepEqual(parsed.groups, [[0, 1]]);
    });

    it("a tag closes on whitespace: glued alternation is one value, spaced is three clauses", () => {
        const glued = parse("desc:kneel|dance");
        assert.equal(glued.clauses.length, 1);
        assert.equal(valueOf(glued.clauses[0].ask as Ask).op, "anyOf");

        const spaced = parse("desc:kneel | dance");
        assert.equal(spaced.clauses.length, 2);
        assert.deepEqual(spaced.groups, [[0], [1]]);
    });

    it("cross-column OR is two clauses in two groups", () => {
        const parsed = parse("model:fire | sound:fire");
        assert.equal(parsed.clauses.length, 2);
        assert.deepEqual(parsed.groups, [[0], [1]]);
    });

    it("juxtaposition binds tighter than |, so a flat list is DNF", () => {
        const parsed = parse("model:fire model:arcane | model:frost model:shadow");
        assert.deepEqual(parsed.groups, [[0, 1], [2, 3]]);
    });

    it("a dangling | leaves the group behind it intact", () => {
        const parsed = parse("model:fire |", {mode: "typing"});
        assert.deepEqual(parsed.groups, [[0]]);
    });

    it("a lone dash negates nothing: silent while typing, an error in final text", () => {
        const typing = parse("-", {mode: "typing"});
        assert.equal(typing.clauses[0].state, "incomplete");
        assert.deepEqual(typing.diagnostics, []);
        const final = parse("-");
        assert.equal(final.clauses[0].state, "invalid");
        assert.equal(errors(final).length, 1);
    });
});

describe("plain search", () => {
    it("a bare term is a content match", () => {
        const ask = ok("fireball");
        assert.equal(ask.on, "plain");
        assert.deepEqual(valueOf(ask), {op: "contains", operand: {text: "fireball"}});
    });

    it("an unknown word before a colon is ordinary text, never an error", () => {
        // 12,477 spell names carry a colon, so pasting one must never be a syntax error. The control surface
        // is what says the word opens no door, while the text still searches.
        assert.deepEqual(valueOf(ok("foo:bar")), {op: "contains", operand: {text: "foo:bar"}});
        const parsed = parse("Hero: Illidan");
        assert.equal(parsed.clauses.length, 2);
        assert.deepEqual(errors(parsed), []);
    });

    it("parens and braces in top-level free text are ordinary characters", () => {
        assert.equal(parse("fireball (rank 2)").clauses.length, 3);
        assert.deepEqual(errors(parse("fireball (rank 2)")), []);
        const braced = parse("fireball {2}");
        assert.equal(braced.clauses.length, 2);
        assert.deepEqual(valueOf(braced.clauses[1].ask as Ask), {op: "contains", operand: {text: "{2}"}});
    });

    it("a lone operator token is content — 84 spell names carry one", () => {
        assert.deepEqual(valueOf(ok("<INTERNAL>")), {op: "contains", operand: {text: "<INTERNAL>"}});
    });

    it("a lone * is every spell", () => {
        assert.deepEqual(valueOf(ok("*")), {op: "present"});
    });
});

describe("binds and their values", () => {
    it("a bare value on a text axis is a substring, = anchors it", () => {
        assert.equal(valueOf(ok("name:Fireball")).op, "contains");
        assert.deepEqual(valueOf(ok("name:=Fireball")),
            {op: "exact", operand: {type: "text", value: "Fireball", written: "Fireball"}});
    });

    it("= anchors a phrase: IS versus contains", () => {
        assert.deepEqual(valueOf(ok('name:="Blood Pool"')),
            {op: "exact", operand: {type: "text", value: "Blood Pool", written: "Blood Pool", verbatim: true}});
        assert.deepEqual(valueOf(ok('name:"Blood Pool"')),
            {op: "contains", operand: {type: "text", value: "Blood Pool", written: "Blood Pool", verbatim: true}});
    });

    it("a glued run is the scope it spells, and nothing else", () => {
        // The glue is the scope's own separator written where the braces are not, so the two spellings must
        // converge on one canonical form. What the run MEANS is therefore never decided by the comma: an id is
        // read whole and one spell holds one, so these bare values alternate exactly as the braced form's do.
        assert.equal(
            formatQuery(parse("id:133,134"), "canonical"),
            formatQuery(parse("id:{133 134}"), "canonical"));
    });

    it("an ordinal compares on its ladder", () => {
        const value = valueOf(ok("xpac:>legion"));
        assert.deepEqual(value, {op: "gt", operand: {type: "ordinal", value: "legion", written: "legion"}});
    });

    it("a minus in value position is a sign, not negation", () => {
        const clause = one("scale:-50");
        assert.equal(clause.not, false);
        assert.deepEqual(valueOf(clause.ask as Ask), {
            op: "exact",
            operand: {type: "percentChange", value: -50, written: "-50"}
        });
    });

    it("parens shelter a negative range bound", () => {
        assert.equal(valueOf(ok("scale:(-50)-10")).op, "range");
    });

    it("units convert into storage: seconds store milliseconds", () => {
        assert.deepEqual(valueOf(ok("cast:500ms")), {
            op: "exact",
            operand: {type: "seconds", value: 500, written: "500ms"}
        });
        assert.deepEqual(valueOf(ok("cast:1.5")), {
            op: "exact",
            operand: {type: "seconds", value: 1500, written: "1.5"}
        });
        assert.equal(valueOf(ok("cast:2-5")).op, "range");
    });

    it("open ranges desugar to comparisons at parse time", () => {
        assert.deepEqual(valueOf(ok("cast:10-*")), {
            op: "gte",
            operand: {type: "seconds", value: 10_000, written: "10"}
        });
        assert.deepEqual(valueOf(ok("cast:*-10")), {
            op: "lte",
            operand: {type: "seconds", value: 10_000, written: "10"}
        });
    });

    it("a trailing dash is the open lower bound, and a note names the reading", () => {
        const parsed = parse("cast:10-");
        assert.deepEqual(valueOf(parsed.clauses[0].ask as Ask),
            {op: "gte", operand: {type: "seconds", value: 10_000, written: "10"}});
        assert.equal(notes(parsed).length, 1);
    });

    it("a sentinel is reachable by its word and never by its number", () => {
        assert.deepEqual(valueOf(ok("cast:instant")), {
            op: "exact",
            operand: {type: "seconds", value: 0, written: "instant"}
        });
        assert.deepEqual(valueOf(ok("channel:unlimited")), {
            op: "exact",
            operand: {type: "seconds", value: -1, written: "unlimited"}
        });
    });

    it("a bare number on the scale axis splits at ten: 2 is double, 50 a proportion", () => {
        assert.deepEqual(valueOf(ok("scale:2")), {
            op: "exact",
            operand: {type: "percentChange", value: 100, written: "2"}
        });
        assert.deepEqual(valueOf(ok("scale:50")), {
            op: "exact",
            operand: {type: "percentChange", value: -50, written: "50"}
        });
    });

    it("a range's bare bounds read in ONE notation, the larger bound classifying the pair", () => {
        // And each bound records the spelling that reading gave it, never the bare text: the pair is classified
        // together, so spelling them apart afterwards would put a factor beside a proportion.
        const range = (q: string): unknown => valueOf(ok(q));
        assert.deepEqual(range("scale:10-90"), {
            op: "range",
            lo: {type: "percentChange", value: -90, written: "10%"},
            hi: {type: "percentChange", value: -10, written: "90%"},
        });
        assert.deepEqual(range("scale:2-5"), {
            op: "range",
            lo: {type: "percentChange", value: 100, written: "x2"},
            hi: {type: "percentChange", value: 400, written: "x5"},
        });
        assert.deepEqual(range("scale:8-12"), {
            op: "range",
            lo: {type: "percentChange", value: -92, written: "8%"},
            hi: {type: "percentChange", value: -88, written: "12%"},
        });
        // A signed bound is already a change, and the sign is the notation: nothing is added to it.
        assert.deepEqual(range("scale:(-50)-10"), {
            op: "range",
            lo: {type: "percentChange", value: -50, written: "-50"},
            hi: {type: "percentChange", value: 10, written: "10"},
        });
    });

    it("a written unit is what it says, and a unit written anywhere is the phrase's own", () => {
        // A bound carrying its symbol is never reinterpreted.
        assert.deepEqual(valueOf(ok("scale:x2-x5")), {
            op: "range",
            lo: {type: "percentChange", value: 100, written: "x2"},
            hi: {type: "percentChange", value: 400, written: "x5"},
        });
        // The BARE bound beside it has no notation of its own, so it takes the one the phrase names -- `50`
        // here is fifty times, not fifty percent. Read alone it was −50%, which made the range run backwards.
        // It is recorded wearing that notation, since a surface writing `50` back would read it the other way.
        assert.deepEqual(valueOf(ok("scale:x2-50")), {
            op: "range",
            lo: {type: "percentChange", value: 100, written: "x2"},
            hi: {type: "percentChange", value: 4900, written: "x50"},
        });
        // Whichever side wears it, and a range with no unit anywhere still reads its bounds together.
        assert.deepEqual(valueOf(ok("scale:50-x2")), {
            op: "range",
            lo: {type: "percentChange", value: 4900, written: "x50"},
            hi: {type: "percentChange", value: 100, written: "x2"},
        });
    });

    it("exact and a pattern cannot combine, and the fix drops the anchor", () => {
        const [error] = invalid("name:=Fire*");
        assert.match(error.message, /= cannot combine/);
        assert.equal(error.fixes?.[0]?.query, "name:Fire*");
    });

    it("a declined operator is a static error with the drop fix, in both modes", () => {
        const [error] = invalid("name:>m");
        assert.match(error.message, /no order to sort by/);
        assert.equal(error.fixes?.[0]?.query, "name:m");
        assert.equal(parse("name:>m", {mode: "typing"}).clauses[0].state, "invalid");
    });

    it("an ill-typed value is an error in final text and silence while typing", () => {
        const [error] = invalid("scale:abc");
        assert.match(error.message, /scale can take/);
        const typing = parse("scale:abc", {mode: "typing"});
        assert.equal(typing.clauses[0].state, "incomplete");
        assert.deepEqual(typing.diagnostics, []);
    });

    it("* alone is existence, * inside a token is a pattern", () => {
        const column = ok("model:*") as ColumnAsk;
        assert.deepEqual(column.test, {is: "exists"});
        const kind = ok("missile:*") as KindAsk;
        assert.deepEqual(kind.test, {is: "exists"});
        assert.equal(valueOf(ok("name:bee*")).op, "glob");
    });

    it("a glob on a file path column carries the futility warning", () => {
        const parsed = parse("model:bee*");
        assert.equal(warnings(parsed).length, 1);
        assert.deepEqual(warnings(parse("name:bee*")), []);
    });
});

describe("the quote law: a phrase is one literal string value", () => {
    it("a phrase is a leaf — colons, parens and pipes inside are data", () => {
        assert.deepEqual(valueOf(ok('name:"Embody Hero: Illidan"')),
            {
                op: "contains",
                operand: {type: "text", value: "Embody Hero: Illidan", written: "Embody Hero: Illidan", verbatim: true}
            });
        assert.deepEqual(valueOf(ok('name:"Elixir (Greater)"')),
            {
                op: "contains",
                operand: {type: "text", value: "Elixir (Greater)", written: "Elixir (Greater)", verbatim: true}
            });
        assert.deepEqual(valueOf(ok('model:"beam|chain"')),
            {op: "contains", operand: {text: "beam|chain", verbatim: true}});
    });

    it("an escaped quote is a literal quote", () => {
        assert.deepEqual(valueOf(ok(String.raw`name:"the \"real\" one"`)),
            {
                op: "contains",
                operand: {type: "text", value: 'the "real" one', written: 'the "real" one', verbatim: true}
            });
    });

    it("quotes never group clauses: a quoted pair stays a phrase", () => {
        assert.deepEqual(valueOf(ok('model:"fire missile"')),
            {op: "contains", operand: {text: "fire missile", verbatim: true}});
    });

    it("quotes suppress the vocabulary: a quoted kind word is content", () => {
        const ask = ok('model:"missile"');
        assert.equal(ask.on, "column");
        assert.deepEqual(valueOf(ask), {op: "contains", operand: {text: "missile", verbatim: true}});
    });

    it("a pattern inside a phrase is literal text, not a glob", () => {
        assert.equal(valueOf(ok('name:"bee*"')).op, "contains");
    });

    it("quotes are inert where the axis reads nothing but quantities — they select no other reading", () => {
        // The quotes say "read this as a string". Where the axis has no string reading there is none to
        // select, so they carry no information and the number is read as the number it is.
        assert.deepEqual(valueOf(ok('scale:"50"')), valueOf(ok("scale:50")));
        assert.deepEqual(valueOf(ok('scale:"x2"')), valueOf(ok("scale:x2")));
        assert.deepEqual(valueOf(ok('cast:"5"')), valueOf(ok("cast:5")));
        assert.deepEqual(valueOf(ok('scale:="50"')), valueOf(ok("scale:=50")));
    });

    it("the axis must still be able to read it: a word that is no quantity stays an error", () => {
        const [error] = invalid("scale:abc");
        assert.match(error.message, /how much bigger or smaller/);
        assert.equal(invalid('scale:"abc"').length, 1);
    });

    it("sentinel words are strings, so quoting one is harmless", () => {
        assert.deepEqual(valueOf(ok('cast:"instant"')), {
            op: "exact",
            operand: {type: "seconds", value: 0, written: "instant"}
        });
    });

    it("role words are strings, so a quoted role reads as the role", () => {
        const [term] = termsOf(ok('model:{target:"caster"}'));
        assert.equal(term.state, "ok");
        assert.ok(term.ask !== null && term.ask.on === "props");
        assert.deepEqual(term.ask.value, {op: "exact", operand: {type: "bitmask", value: "caster", written: "caster"}});
    });

    it("a quoted colour name carries the colour, not the letters", () => {
        const [term] = termsOf(ok('fx:{tint:"red"}'));
        assert.ok(term.ask !== null && term.ask.on === "props");
        assert.deepEqual(term.ask.value, {
            op: "contains",
            operand: {type: "colour", value: 0xff_00_00, written: "red", verbatim: true}
        });
    });

    it("on a name-or-id property, digits are the id and quoted digits are the name", () => {
        const [byId] = termsOf(ok("sound:{kit:150}"));
        assert.ok(byId.ask !== null && byId.ask.on === "props");
        assert.deepEqual(byId.ask.value, {op: "exact", operand: {type: "soundKitId", value: 150, written: "150"}});
        const [byName] = termsOf(ok('sound:{kit:"150"}'));
        assert.ok(byName.ask !== null && byName.ask.on === "props");
        assert.deepEqual(byName.ask.value, {
            op: "contains",
            operand: {type: "text", value: "150", written: "150", verbatim: true}
        });
    });

    it("an unclosed phrase runs to the end of input", () => {
        assert.deepEqual(valueOf(ok('name:"fire')), {
            op: "contains",
            operand: {type: "text", value: "fire", written: "fire", verbatim: true}
        });
    });

    it("a quoted number is a string to the count question too", () => {
        const quoted = parse('model:>"4"').clauses[0].ask;
        assert.equal(quoted?.on, "column");
        assert.ok(quoted?.on === "column" && quoted.test?.is === "content");
        const bare = parse("model:>4").clauses[0].ask;
        assert.ok(bare?.on === "column" && bare.test?.is === "scope");
    });

    it("a quoted wildcard is a literal star even behind the anchor", () => {
        const ask = parse('model:="fi*re"').clauses[0].ask;
        assert.ok(ask?.on === "column" && ask.test?.is === "content");
        assert.ok(ask?.on === "column" && ask.test?.is === "content" && ask.test.value.op === "exact");
    });

    it("the single quote is a letter — 14,819 of 276,332 names on 9.2.7 carry one", () => {
        assert.deepEqual(valueOf(ok("name:al'ar")), {
            op: "contains",
            operand: {type: "text", value: "al'ar", written: "al'ar"}
        });
        // A typographic apostrophe folds to the plain one, so a pasted name still matches.
        assert.deepEqual(valueOf(ok("name:al’ar")), {
            op: "contains",
            operand: {type: "text", value: "al'ar", written: "al'ar"}
        });
        // And so does the backtick, the chat-era stand-in — zero names carry one, so nothing is stranded.
        assert.deepEqual(valueOf(ok("name:zul`jin")), {
            op: "contains",
            operand: {type: "text", value: "zul'jin", written: "zul'jin"}
        });
    });
});

describe("the implied colon: a comparison straight after a head", () => {
    it("model<=4 reads as model:<=4 — measured: no name glues a head to a comparison", () => {
        const [glued] = termsOf(parse("model<=4").clauses[0].ask as Ask);
        const [spelled] = termsOf(parse("model:<=4").clauses[0].ask as Ask);
        assert.deepEqual(glued.ask, spelled.ask);
        assert.deepEqual(valueOf(ok("scale>50")), valueOf(ok("scale:>50")));
        assert.deepEqual(valueOf(ok("cast<2")), {op: "lt", operand: {type: "seconds", value: 2000, written: "2"}});
        assert.deepEqual(valueOf(ok("name=Fireball")), valueOf(ok("name:=Fireball")));
    });

    it("works inside a scope too", () => {
        const [term] = termsOf(ok("model:{count<=4}"));
        assert.ok(term.ask !== null && term.ask.on === "count");
        assert.deepEqual(term.ask.value, {op: "lte", operand: {type: "count", value: 4, written: "4"}});
    });

    it("an unknown word keeps its comparison as ordinary text", () => {
        assert.deepEqual(valueOf(ok("a=b")), {op: "contains", operand: {text: "a=b"}});
    });
});

describe("regular expressions: the superuser door", () => {
    it("a slash-delimited value on a text axis is a pattern", () => {
        assert.deepEqual(valueOf(ok("name:/^fire/")), {op: "regex", operand: {text: "^fire"}});
    });

    it("a pipe inside the slashes belongs to the pattern", () => {
        const parsed = parse("model:/beam|chain/");
        assert.equal(parsed.clauses.length, 1);
        assert.deepEqual(valueOf(parsed.clauses[0].ask as Ask), {op: "regex", operand: {text: "beam|chain"}});
    });

    it("a pattern works as a scope term", () => {
        const [term] = termsOf(ok("model:{/^spells/ fire}"));
        assert.ok(term.ask !== null && term.ask.on === "content");
        assert.deepEqual(term.ask.value, {op: "regex", operand: {text: "^spells"}});
    });

    it("an escaped slash is data; the backslash itself survives for the engine", () => {
        assert.deepEqual(valueOf(ok(String.raw`name:/a\/b/`)), {op: "regex", operand: {text: "a/b"}});
        assert.deepEqual(valueOf(ok(String.raw`name:/fire\d+/`)), {op: "regex", operand: {text: String.raw`fire\d+`}});
    });

    it("a quantity axis declines a pattern", () => {
        const [error] = invalid("scale:/5/");
        assert.match(error.message, /run on text and file names/);
    });

    it("a pattern's characters are not typography-folded — stored text is matched as written", () => {
        const ask = parse("name:/x–y`z/").clauses[0].ask;
        assert.ok(ask?.on === "kind" && ask.test?.is === "props" && ask.test.value.op === "regex");
        assert.ok(ask?.on === "kind" && ask.test?.is === "props" && ask.test.value.op === "regex"
            && "text" in ask.test.value.operand && ask.test.value.operand.text === "x–y`z");
    });

    it("a slash in free text is an ordinary character", () => {
        assert.deepEqual(valueOf(ok("/fire/")), {op: "contains", operand: {text: "/fire/"}});
    });

    it("a broken pattern is an error in final text and silence while typing", () => {
        const [error] = invalid("name:/[/");
        assert.match(error.message, /invalid regular expression/);
        const typing = parse("name:/[/", {mode: "typing"});
        assert.equal(typing.clauses[0].state, "incomplete");
        assert.deepEqual(typing.diagnostics, []);
    });

    it("an anchor and a pattern cannot combine", () => {
        const [error] = invalid("name:=/fire/");
        assert.match(error.message, /cannot combine/);
    });
});

describe("scopes", () => {
    it("a scope holds more than one condition on one row, and a lone kind word tests the kind", () => {
        const terms = termsOf(ok("model:{fire missile}"));
        assert.equal(terms.length, 2);
        assert.ok(terms.every((t) => t.state === "ok"));
        assert.equal(terms[0].ask?.on, "content");
        assert.equal(terms[1].ask?.on, "kindWord");
    });

    it("a bind and a term share the row, and a group is one value", () => {
        const terms = termsOf(ok("model:{attach:(chest|head) fire}"));
        assert.equal(terms.length, 2);
        assert.ok(terms[0].ask !== null && terms[0].ask.on === "props");
        assert.equal((terms[0].ask.value as ValueExpr).op, "anyOf");
    });

    it("a kind scope reads its own properties", () => {
        const ask = ok('missile:{from:chest to:"right hand" motion:parabola}') as KindAsk;
        assert.equal(ask.kind, KINDS.get("model.missile"));
        const terms = termsOf(ask);
        assert.equal(terms.length, 3);
        assert.ok(terms.every((t) => t.ask?.on === "props"));
    });

    it("a foreign axis in a scope is a static error, with its own clause as the fix", () => {
        const [error] = invalid("model:{sound:fire}");
        assert.match(error.message, /not a model field/);
        assert.equal(error.fixes?.[0]?.query, "model:* sound:fire");
    });

    it("a wrong property in a kind scope is named, not searched", () => {
        const [error] = invalid("missile:{foo:bar}");
        assert.match(error.message, /no "foo" property/);
    });

    it("an unknown word in a column scope is ordinary text", () => {
        const [term] = termsOf(ok("model:{foo:bar}"));
        assert.equal(term.state, "ok");
        assert.ok(term.ask !== null && term.ask.on === "content");
    });

    it("a scope of only negations has no anchor: an error in final text, quiet while typing", () => {
        const parsed = parse("model:{-fire}");
        assert.equal(parsed.clauses[0].state, "invalid");
        assert.match(errors(parsed)[0].message, /something to look for/);
        assert.deepEqual(errors(parse("model:{-fire}", {mode: "typing"})), []);
    });

    it("an empty scope is an identity: any row, with a note saying so", () => {
        const parsed = parse("model:{}");
        assert.equal(parsed.clauses[0].state, "ok");
        assert.equal(notes(parsed).length, 1);
    });

    it("an empty group inside a scope errors in final text and stays silent while typing", () => {
        const parsed = parse("model:{attach:()}");
        const reported = parsed.diagnostics.filter((d) => d.severity === "error");
        assert.equal(reported.length, 1);
        assert.match(reported[0].message, /matches nothing/);
        assert.equal(parse("model:{attach:()}", {mode: "typing"}).diagnostics.length, 0);
    });

    it("a scope cannot hold another scope, even while typing", () => {
        const [error] = invalid("model:{attach:{chest}}");
        assert.match(error.message, /not more curly brackets/);
        assert.equal(parse("model:{fire {", {mode: "typing"}).clauses[0].state, "invalid");
    });

    it("an unclosed scope closes before the clause that cannot belong to it", () => {
        const parsed = parse("model:{fire sound:ice");
        assert.equal(parsed.clauses.length, 2);
        assert.equal(parsed.clauses[0].state, "ok");
        assert.equal((parsed.clauses[1].ask as ColumnAsk).column.key, "sound");
        const [warning] = warnings(parsed);
        assert.match(warning.message, /closed before the next field/);
        assert.equal(warning.fixes?.[0]?.query, "model:{fire } sound:ice");
    });

    it("count is universal, so it belongs and the scope closes at the end", () => {
        const parsed = parse("model:{fire count:>4");
        assert.equal(parsed.clauses.length, 1);
        assert.equal(parsed.clauses[0].state, "ok");
        assert.match(warnings(parsed)[0].message, /closed at the end/);
    });

    it("lenient parens: a scope-shaped group is read as a scope", () => {
        const bound = ok("model:(attach:chest)");
        assert.ok((bound as ColumnAsk).test?.is === "scope");
        const terms = termsOf(ok("model:(fire missile)"));
        assert.equal(terms.length, 2);
    });

    it("a phrase glued to a bind's value splits into its own clause with disjoint spans", () => {
        const parsed = parse('name:fire"frost"');
        assert.equal(parsed.clauses.length, 2);
        assert.ok(parsed.clauses[0].span.end <= parsed.clauses[1].span.start);
    });

    it("text glued to a closing brace is a missing space, repaired and announced", () => {
        const parsed = parse("model:{fire}x");
        assert.equal(parsed.clauses.length, 2);
        assert.match(warnings(parsed)[0].message, /missing space/);
    });
});

describe("the count desugar", () => {
    it("a lone comparison at a column head is the count question, with a note", () => {
        const parsed = parse("model:>4");
        const [term] = termsOf(parsed.clauses[0].ask as Ask);
        assert.ok(term.ask !== null && term.ask.on === "count");
        assert.deepEqual(term.ask.value, {op: "gt", operand: {type: "count", value: 4, written: "4"}});
        assert.equal(notes(parsed).length, 1);
    });

    it("a bare range at a column head counts too", () => {
        const [term] = termsOf(parse("mech:2-4").clauses[0].ask as Ask);
        assert.ok(term.ask !== null && term.ask.on === "count");
    });

    it("the same default holds in term position inside a scope", () => {
        const terms = termsOf(ok("model:{fire >4}"));
        assert.equal(terms.length, 2);
        assert.ok(terms[1].ask !== null && terms[1].ask.on === "count");
    });

    it("a kind with no ordering property falls back to counting its rows", () => {
        const [term] = termsOf(ok("morph:{>2}"));
        assert.ok(term.ask !== null && term.ask.on === "count");
    });

    it("a kind's numeric subject outranks the count default", () => {
        assert.deepEqual(valueOf(ok("scale:>50")), {
            op: "gt",
            operand: {type: "percentChange", value: -50, written: "50"}
        });
        const vehicles = valueOf(ok("vehicle:>2"));
        assert.deepEqual(vehicles, {op: "gt", operand: {type: "count", value: 2, written: "2"}});
        assert.equal((ok("vehicle:>2") as KindAsk).test?.is, "props");
        assert.deepEqual(valueOf(ok("cast:>2")), {op: "gt", operand: {type: "seconds", value: 2000, written: "2"}});
        // The volley size, since format 54: the salient number about a missile
        // is how many fly, so the bare comparison stopped counting rows.
        const missiles = valueOf(ok("missile:>2"));
        assert.deepEqual(missiles, {op: "gt", operand: {type: "count", value: 2, written: "2"}});
        assert.equal((ok("missile:>2") as KindAsk).test?.is, "props");
    });
});

describe("brace expansion and glued tokens", () => {
    it("alternatives distribute over glued text, as the shell does", () => {
        const value = valueOf(ok("model:(fire|frost)bolt"));
        assert.equal(value.op, "anyOf");
        const alternatives = (value as Extract<ValueExpr, { op: "anyOf" }>).alternatives;
        assert.deepEqual(alternatives.map((alt) => (alt as { operand: { text: string } }).operand.text),
            ["firebolt", "frostbolt"]);
    });

    it("a glued single-value group is a missing space, warned and split", () => {
        const parsed = parse("model:(fire)bolt");
        assert.equal(parsed.clauses.length, 2);
        assert.match(warnings(parsed)[0].message, /run together/);
    });

    it("a glued phrase can never mean anything, warned and split", () => {
        const parsed = parse('name:"blood pool"x');
        assert.equal(parsed.clauses.length, 2);
        assert.equal(warnings(parsed).length, 1);
    });
});

describe("alternative spellings", () => {
    it("a full name reads as its word", () => {
        assert.equal((ok("description:kneel") as KindAsk).kind, (ok("desc:kneel") as KindAsk).kind);
        assert.equal((ok("expansion:>wotlk") as KindAsk).kind, KINDS.get("id.xpac"));
    });

    it("a column synonym reads as the column", () => {
        assert.equal((ok("models:fire") as ColumnAsk).column.key, "model");
    });

    it("spellings resolve inside a scope: a kind by its full name, a property by a synonym", () => {
        const [term] = termsOf(ok("fx:{camouflage}"));
        assert.ok(term.ask !== null && term.ask.on === "kindWord");
        assert.equal(term.ask.kind, KINDS.get("fx.camo"));
        const [colour] = termsOf(ok("chain:{color:red}"));
        assert.ok(colour.ask !== null && colour.ask.on === "props");
        assert.deepEqual(colour.ask.value, {
            op: "contains",
            operand: {type: "colour", value: 0xff_00_00, written: "red"}
        });
    });
});

describe("typography and non-Latin text", () => {
    it("a full-width colon binds: an IME query parses as its ASCII form", () => {
        const ask = ok("model：火");
        assert.equal(ask.on, "column");
        assert.deepEqual(valueOf(ask), {op: "contains", operand: {text: "火"}});
    });

    it("a Cyrillic term parses with its case intact — folding is the matcher's job, on both sides", () => {
        const bound = valueOf(ok("name:Огненный"));
        assert.deepEqual(bound, {op: "contains", operand: {type: "text", value: "Огненный", written: "Огненный"}});
        assert.equal(fold("Огненный"), "огненный");
        assert.deepEqual(valueOf(ok("Огненный")), {op: "contains", operand: {text: "Огненный"}});
    });
});

describe("incomplete against invalid — the classifier", () => {
    const incomplete = (query: string): void => {
        const parsed = parse(query, {mode: "typing"});
        assert.deepEqual(parsed.diagnostics, [], `${query}: expected silence`);
        assert.ok(parsed.clauses.every((c) => c.state !== "invalid"), `${query}: expected no invalid clause`);
    };

    it("every intermediary state from the catalogue stays quiet while typing", () => {
        for (const query of [
            "mod", "model:", "model:{", "model:{at", "model:{attach:", "model:{attach:c",
            "scale:>", "name:=", "model:fire |", "model:fire -", "model:{fire ", "model:{-missile}",
            "cast:insta", "fx:{tint:re", "scale:(",
        ]) {
            incomplete(query);
        }
    });

    it("what no suffix can rescue is invalid even while typing", () => {
        for (const query of ["name:>m", "model:{fire {", "model:{sound:fire}"]) {
            const parsed = parse(query, {mode: "typing"});
            assert.equal(parsed.clauses[0].state, "invalid", query);
        }
    });

    it("an incomplete bind in final text is a broken chip, not a silent drop", () => {
        const parsed = parse("model:");
        assert.equal(parsed.clauses[0].state, "invalid");
        assert.equal(errors(parsed).length, 1);
    });

    it("only ok clauses join the evaluable groups", () => {
        const parsed = parse("scale:abc model:fire");
        assert.equal(parsed.clauses[0].state, "invalid");
        assert.deepEqual(parsed.groups, [[1]]);
    });
});

/* ------------------------------------------------------------------ tier 3: the truncation fuzz */

/**
 * Every valid fixture the suite asserts on. The fuzz truncates each at every character: a prefix of a valid query
 * is something a reader passes through on the way to typing it, so it must classify INCOMPLETE (or already valid),
 * never INVALID, and never raise an error — the promise that keeps the bar quiet mid-keystroke.
 */
const VALID_FIXTURES: readonly string[] = [
    "fireball", "foo:bar", "Hero: Illidan", "fireball (rank 2)", "fireball {2}", "*", "<INTERNAL>",
    "model:fire -sound:ice", "desc:kneel|dance", "desc:kneel | dance", "model:fire | sound:fire",
    "model:fire|frost", "model:fire model:arcane | model:frost model:shadow",
    "name:Fireball", "name:=Fireball", 'name:="Blood Pool"', 'name:"Blood Pool"', "id:133,134",
    "xpac:>legion", "scale:-50", "scale:(-50)-10", "scale:2", "scale:50", "scale:=50", "scale:>50",
    "cast:10-*", "cast:*-10", "cast:10-", "cast:instant", 'cast:"instant"', "channel:unlimited",
    "cast:500ms", "cast:1.5", "cast:2-5", "cast:>2", "name:bee*", "model:bee*", 'name:"bee*"',
    "model:*", "-model:*", "missile:*", "scale:*",
    'name:"Embody Hero: Illidan"', 'name:"Elixir (Greater)"', 'model:"beam|chain"',
    String.raw`name:"the \"real\" one"`, 'model:"fire missile"', 'model:"missile"',
    'model:{target:"caster"}', 'fx:{tint:"red"}', 'sound:{kit:"150"}', "sound:{kit:150}",
    "model:{fire missile}", "model:{attach:(chest|head) fire}",
    'missile:{from:chest to:"right hand" motion:parabola}', "model:{foo:bar}",
    "model:>4", "mech:2-4", "model:{fire >4}", "missile:{>2}", "vehicle:>2", "model:{}",
    "model:(attach:chest)", "model:(fire missile)", "model:(fire|frost)", "model:(fire|frost)bolt",
    "description:kneel", "expansion:>wotlk", "models:fire", "fx:{camouflage}", "chain:{color:red}",
    "model:{fire count:>4", "model:{fire sound:ice",
    'frost model:{missile attach:(chest|"right hand") -fire} scale:50-* cast:instant',
    "model：火", "name:Огненный", "Огненный", "name:al'ar", "name:al’ar",
    "model<=4", "scale>50", "cast<2", "name=Fireball", "model:{count<=4}", "a=b",
    "name:/^fire/", "model:/beam|chain/", "model:{/^spells/ fire}", String.raw`name:/a\/b/`, "/fire/",
    "fire sort:-name first:20", "model:fire sort:{name -cast} first:-5", "-sort:-id",
];

describe("the truncation fuzz: a prefix of a valid query is never an error", () => {
    it("classifies every truncation of every valid fixture INCOMPLETE or valid, never INVALID", () => {
        for (const fixture of VALID_FIXTURES) {
            for (let cut = 1; cut <= fixture.length; cut++) {
                const parsed = parse(fixture.slice(0, cut), {mode: "typing"});
                const broken = parsed.clauses.find((c) => c.state === "invalid");
                assert.equal(broken, undefined,
                    `"${fixture.slice(0, cut)}" (of "${fixture}"): invalid clause`);
                assert.deepEqual(errors(parsed), [],
                    `"${fixture.slice(0, cut)}" (of "${fixture}"): error diagnostic`);
            }
        }
    });

    it("parses every full fixture in final mode without an error", () => {
        for (const fixture of VALID_FIXTURES) {
            assert.deepEqual(errors(parse(fixture)), [], fixture);
        }
    });
});

describe("totality", () => {
    it("never throws, whatever the input", () => {
        for (const junk of [
            "", "   ", '"""', "}}}{{{", ":::a:::", "((()))", "-|-|-", "*|*", "a{b}c", "model:{{",
            String.raw`\"\ `, "：：", "🔥🔥:🔥", "-", "|", "{", "}", '"', "\\", "model:{fire {{{",
            'name:"', "name:=Fire*", "scale:abc", "model:{sound:fire}",
        ]) {
            assert.doesNotThrow(() => parse(junk), junk);
            assert.doesNotThrow(() => parse(junk, {mode: "typing"}), junk);
        }
    });

    it("an empty query is an empty parse", () => {
        assert.deepEqual(parse(""), {clauses: [], groups: [], sorts: [], limit: null, diagnostics: []});
    });
});

describe("the operator-glued inner bind", () => {
    it("reads a resolved word glued to an operator as the one-term scope the braces spell", () => {
        assert.deepEqual(shape("model:count<5"), shape("model:{count<5}"));
        assert.deepEqual(shape("model:file=foo"), shape("model:{file=foo}"));
        assert.deepEqual(shape("spell:cast>2s"), shape("spell:{cast>2s}"));
        assert.deepEqual(shape("missile:from=chest"), shape("missile:{from=chest}"));
    });

    it("keeps the content reading for a word the head does not resolve", () => {
        assert.deepEqual(valueOf(ok("model:up=down")), {op: "contains", operand: {text: "up=down"}});
    });

    it("keeps the content reading for a foreign word, and for the colon-glued shape", () => {
        assert.deepEqual(valueOf(ok("model:cast=5")), {op: "contains", operand: {text: "cast=5"}});
        assert.deepEqual(valueOf(ok("sound:kit:150")), {op: "contains", operand: {text: "kit:150"}});
    });

    it("reads a comparison no property answers as that ROW's count: the pair the braces spell", () => {
        // `worn>2` is the column desugar one level down — the kind word narrows and the count measures what
        // it leaves — so both spellings parse to the kind-word-plus-count pair.
        for (const spelled of ["model:{attach>2}", "model:attach>2"]) {
            const terms = termsOf(ok(spelled));
            assert.equal(terms.length, 2, spelled);
            assert.equal(terms[0].ask?.on, "kindWord", spelled);
            assert.equal(terms[1].ask?.on, "count", spelled);
        }
        assert.deepEqual(shape("model:{attach>2}"), shape("model:{attach count>2}"));
        // A property that CLAIMS the comparison keeps its own reading — the count never shadows a value.
        const claimed = termsOf(ok("model:{missile>2}"));
        assert.equal(claimed.length, 1);
        assert.equal(claimed[0].ask?.on, "props");
        // The pair cannot carry the term's own minus: negating a conjunction is not negating its halves.
        const negated = parse("model:{-attach>2}");
        assert.ok(negated.diagnostics.some((d) => d.severity === "error"));
    });
});

describe("whitespace bridging inside a scope", () => {
    it("reads an operator across any amount of whitespace, but only inside the braces", () => {
        assert.deepEqual(shape("model:{count > 5}"), shape("model:{count>5}"));
        assert.deepEqual(shape("model:{count >5}"), shape("model:{count>5}"));
        assert.deepEqual(shape("model:{count> 5}"), shape("model:{count>5}"));
        assert.deepEqual(shape("spell:{cast > 2s}"), shape("spell:{cast>2s}"));
    });

    it("never bridges a colon: whitespace tolerance does not extend to it", () => {
        const spaced = parse("model:{attach : chest}");
        const terms = termsOf(spaced.clauses[0].ask as Ask);
        assert.ok(terms.every((t) => t.ask?.on !== "props"), "the spaced colon must not bind");
        const bound = parse("model: fire");
        assert.equal(bound.clauses.length, 2);
        assert.equal(bound.clauses[0].state, "invalid");
    });

    it("never bridges at the top level, where whitespace separates clauses", () => {
        const spaced = parse("cast > 2s");
        assert.equal(spaced.clauses.length, 3);
        const braceless = parse("model:count < 5").clauses[0].ask;
        assert.ok(braceless !== null);
        assert.deepEqual(valueOf(braceless), {op: "contains", operand: {text: "count"}});
    });

    it("does not bridge while typing, where the next character may change the word", () => {
        const typing = parse("model:{count > 5}", {mode: "typing"});
        const terms = termsOf(typing.clauses[0].ask as Ask);
        assert.ok(terms.every((t) => t.ask?.on !== "count"), "typing keeps whitespace as the separator");
    });
});

/* ------------------------------------------------------- the display words, typed back in */

describe("the word synonyms — everything a chip displays parses in its place", () => {
    it("reads the any-word as the wildcard wherever a bound value is read", () => {
        assert.equal(formatQuery(parse("model:any")), formatQuery(parse("model:*")));
        assert.equal(formatQuery(parse("cast:any")), formatQuery(parse("cast:*")));
        assert.equal(formatQuery(parse("model:{any missile}")), formatQuery(parse("model:{* missile}")));
    });

    it("keeps a bare top-level any as plain search content", () => {
        const clause = one("any");
        assert.ok(clause.ask !== null && clause.ask.on === "plain");
        assert.deepEqual(valueOf(clause.ask), {op: "contains", operand: {text: "any"}});
    });

    it("keeps a quoted any a literal — the phrase stays the escape", () => {
        const quoted = one('name:"any"');
        assert.ok(quoted.ask !== null && quoted.ask.on !== "plain");
    });

    it("reads the or-word as alternation between clauses, exactly as the symbol", () => {
        const worded = parse("model:fire or model:frost");
        assert.equal(worded.clauses.length, 2);
        assert.deepEqual(worded.groups, [[0], [1]]);
    });

    it("reads the or-word between a scope's terms", () => {
        assert.equal(formatQuery(parse("model:{fire or frost}")), formatQuery(parse("model:{fire | frost}")));
    });

    it("keeps a glued or ordinary text — only the standalone word is the connective", () => {
        assert.equal(parse("orgrimmar portal").clauses.length, 2);
        assert.deepEqual(parse("orgrimmar portal").groups, [[0, 1]]);
        const bound = one("model:or");
        assert.ok(bound.ask !== null && bound.ask.on === "column");
    });
});

describe("operator aliases — the display glyphs read back", () => {
    it("reads the comparison glyphs as their operators, the implied colon included", () => {
        assert.equal(formatQuery(parse("scale:≥50")), formatQuery(parse("scale:>=50")));
        assert.equal(formatQuery(parse("scale≥50")), formatQuery(parse("scale>=50")));
        assert.equal(formatQuery(parse("cast:≤2s")), formatQuery(parse("cast:<=2s")));
    });

    it("reads a spaced glyph through the in-scope whitespace bridge", () => {
        assert.equal(formatQuery(parse("model:{count ≥ 5}")), formatQuery(parse("model:{count >= 5}")));
    });
});

describe("a sign binds tighter than negation inside a scope", () => {
    it("reads a leading minus before a digit as the value's own sign, so `{x}` and `x` agree", () => {
        // The two spellings write different canonical text — the braced form names the property it binds —
        // so the law they must satisfy is equivalence, not identity.
        assert.ok(equivalent(parse("scale:{-50%}"), parse("scale:-50%")));
        assert.equal(one("scale:{-50%}").state, "ok");
        assert.equal(errors(parse("scale:{-50%}")).length, 0);
    });

    it("negates a word exactly as before — position still decides everywhere else", () => {
        const scope = one("model:{fire -missile}");
        const terms = termsOf(scope.ask as Ask);
        assert.equal(terms.filter((t) => t.not).length, 1);
        // And the top level is untouched: a bare number there still excludes.
        assert.equal(parse("fireball -50").clauses[1].not, true);
    });

    it("reads a range of negative bounds, which the negation reading could not express", () => {
        const ranged = one("scale:{-50%--10%}");
        assert.equal(ranged.state, "ok");
        const [term] = termsOf(ranged.ask as Ask);
        const ask = term.ask;
        assert.ok(ask !== null && ask.on === "props");
        assert.equal(ask.value.op, "range");
    });

    it("keeps the quoted escape for excluding a number, where a phrase can carry no sign", () => {
        const scope = one('model:{fire -"50"}');
        const terms = termsOf(scope.ask as Ask);
        assert.equal(terms.filter((t) => t.not).length, 1);
    });
});

it("reads juxtaposition as alternation on a kind that cannot repeat", () => {
    // A scope binds its conditions to ONE row, so `model:{fire missile}` asks for a row that is both. An
    // expansion is declared single: a spell has exactly one, so two bare values can never both describe it and
    // the reader plainly means either. Drawn as a tidy two-part chip it read as an ordinary conjunction.
    const runs = (query: string): number => {
        const ask = parse(query).clauses[0].ask;
        assert.ok(ask !== null && (ask.on === "kind" || ask.on === "column"), query);
        assert.ok(ask.test?.is === "scope", query);
        return ask.test.terms.length;
    };
    assert.equal(runs("xpac:{legion wotlk}"), 2, "two alternatives, not one conjunction");

    // An OPERATOR is the exception: two comparisons bound one value from opposite sides, which is satisfiable.
    assert.equal(runs("xpac:{>wotlk <legion}"), 1);

    // A kind whose rows repeat is untouched — its lane is the whole point of the brace.
    assert.equal(runs("model:{fire missile}"), 1);

    // A FLAG word states no value: it says one of the row's properties is set, which holds alongside whatever the
    // row's distance is. Alternated, `range:{melee unlimited}` answered the union of the two — every melee spell
    // plus every unlimited one — where a reader asking for both means the band that is both.
    assert.equal(runs("range:{melee unlimited}"), 1, "a flag conjoins with a value");
    assert.equal(runs("range:{5 40}"), 2, "two distances still alternate");

    // A TEXT subject is the exception the rationale itself draws: a spell has ONE name, but two bare values on
    // it are substring claims and both can describe it — `name:{fire ball}` is Fireball, not fire-or-ball. The
    // single declaration exists on name, desc and icon for what it says about ROWS (a count of them answers
    // nothing); it may not import the exclusivity that is only true of a value read whole.
    assert.equal(runs("name:{fire ball}"), 1, "two substrings of one name conjoin");
    assert.equal(runs("desc:{kneel dance}"), 1);
});

describe("the directives: sort orders and first trims, and neither selects anything", () => {
    it("sort takes a door, negation on either side means descending, and bare sort is the default door", () => {
        const sorted = parse("fire sort:name");
        assert.equal(sorted.clauses.length, 1, "the directive is no clause");
        assert.equal(sorted.sorts.length, 1);
        assert.equal(sorted.sorts[0].descending, false);
        for (const spelled of ["sort:-cast", "-sort:cast"]) {
            assert.equal(parse(spelled).sorts[0]?.descending, true, spelled);
        }
        // The exclusion INVERTS the door's own direction, so the two minuses turn back.
        assert.equal(parse("-sort:-cast").sorts[0]?.descending, false);
        assert.equal(parse("sort").sorts[0]?.head.role, "column");
        assert.deepEqual(parse("fire sort:name sort:-model").sorts.map((s) => s.descending), [false, true]);
    });

    it("a scope holds a sort sequence, each door with its own direction", () => {
        assert.deepEqual(parse("fire sort:{name -cast}").sorts.map((s) => s.descending), [false, true]);
        // The scoped spelling is the canonical form of a sequence, and the two spellings converge on it.
        assert.equal(formatQuery(parse("fire sort:name sort:-cast")), "fire sort:{name -cast}");
        assert.equal(formatQuery(parse("fire sort:{name -cast}")), "fire sort:{name -cast}");
        // The directive's own exclusion inverts each member's direction.
        assert.deepEqual(parse("fire -sort:{name -cast}").sorts.map((s) => s.descending), [true, false]);
        // Half a sequence ordering would lie: an unknown member refuses the whole directive, and so does an
        // empty or unclosed scope.
        for (const bad of ["sort:{name zzz}", "sort:{}", "sort:{name"]) {
            assert.equal(parse(bad).sorts.length, 0, bad);
            assert.equal(parse(bad).diagnostics.filter((d) => d.severity === "error").length, 1, bad);
        }
    });

    it("a sort door nothing resolves is refused in final text, quiet while typing", () => {
        const bad = parse("sort:zzz");
        assert.equal(bad.sorts.length, 0);
        assert.equal(bad.diagnostics.filter((d) => d.severity === "error").length, 1);
        assert.deepEqual(parse("sort:zzz", {mode: "typing"}).diagnostics, []);
    });

    it("first takes a whole number, the smallest consumes the larger, and the synonyms reach it", () => {
        assert.equal(parse("fire first:20").limit?.value, 20);
        assert.equal(parse("fire first:20 first:5").limit?.value, 5);
        assert.equal(parse("fire first:5 first:20").limit?.value, 5);
        assert.equal(parse("fire limit:3").limit?.value, 3);
        assert.equal(parse("fire top:7").limit?.value, 7);
        assert.equal(parse("fire").limit, null);
        assert.equal(parse("first:x").diagnostics.filter((d) => d.severity === "error").length, 1);
    });

    it("a minus takes the count from the end, on the number or on the word, and the smallest still wins", () => {
        assert.equal(parse("fire first:-5").limit?.value, -5);
        assert.equal(parse("fire -first:5").limit?.value, -5);
        assert.equal(parse("fire -first:-5").limit?.value, -5);
        assert.equal(parse("fire first:-3 first:5").limit?.value, -3);
        assert.equal(parse("fire first:3 first:-5").limit?.value, 3);
        assert.equal(parse("first:-x").diagnostics.filter((d) => d.severity === "error").length, 1);
    });

    it("the formatter carries the directives, and the round trip holds", () => {
        const text = "fire sort:-name first:20";
        assert.equal(formatQuery(parse(text)), text);
        assert.equal(formatQuery(parse("fire first:-5")), "fire first:-5");
    });
});

describe("the escape works everywhere: a shielded character is data, outside a regex", () => {
    it("an escaped word opens no door — the term is inert text", () => {
        const parsed = parse(String.raw`\model:fire`);
        assert.equal(parsed.clauses.length, 1);
        assert.equal(parsed.clauses[0].ask?.on, "plain");
    });

    it("an escaped minus negates nothing", () => {
        const parsed = parse(String.raw`\-fire`);
        assert.equal(parsed.clauses.length, 1);
        assert.equal(parsed.clauses[0].not, false);
        assert.equal(parsed.clauses[0].ask?.on, "plain");
    });

    it("an escaped quote opens no phrase, so the rest of the query stays its own clauses", () => {
        const parsed = parse(String.raw`name:\" fire`);
        assert.equal(parsed.clauses.length, 2);
        assert.equal(parsed.clauses[1].ask?.on, "plain");
    });

    it("an escaped pipe does not alternate, and an escaped brace does not close a scope", () => {
        const glued = ok("model:{fire\\|frost}");
        assert.ok(glued.on === "column" && glued.test?.is === "scope");
        assert.equal((glued.test as ScopeTest).terms.length, 1, "one run, not two alternatives");
        // Down to the value too: the bare run's own alternation split steps over the pair, so the operand is
        // one text rather than an anyOf.
        assert.equal(valueOf(ok("model:fire\\|frost")).op, "contains");
        const braced = parse("model:{a\\}b}");
        assert.equal(braced.clauses.length, 1, "the escaped brace stayed inside the scope");
    });
});

it("a punctuation-only operand warns on the bare spelling, and quotes make it a real ask", () => {
    // Bare substring matching squashes punctuation away, so the bare ask is dead on arrival and the warning
    // spells the escapes: the pattern, and the strict phrase. Quotes are STRICT, so the quoted spellings are
    // exactly how punctuation is searched and carry no warning at all.
    const bare = parse("name:.").diagnostics.filter((d) => d.severity === "warning");
    assert.equal(bare.length, 1);
    assert.match(bare[0].fixes?.[0]?.query ?? "", /^name:\//);
    for (const query of ['name:"---"', 'name:"\\""']) {
        assert.deepEqual(parse(query).diagnostics, [], query);
    }
});

it("claims a flag word for the property whose own word it is", () => {
    // A flag stores no value, so no notation can read an operand into one: what selects the rows carrying it is
    // the property's name. Without the claim `range:melee` was an error, and only the column word reached it —
    // which also matches every spell whose NAME says melee.
    const parsed = parse("range:melee");
    const ask = parsed.clauses[0].ask;
    assert.ok(ask !== null && ask.on === "kind", "the word bound to the range kind");
    assert.ok(ask.test?.is === "props", "the flag property claimed the word");
    assert.deepEqual(ask.test.props.map((ref) => ref.prop), ["melee"]);
    assert.equal(ask.test.value.op, "contains");
    assert.deepEqual(parsed.diagnostics, []);
});

it("a range's bare bound takes the unit its phrase names, on either side", () => {
    const bounds = (query: string): [number, number] => {
        const ask = parse(query).clauses[0].ask;
        assert.ok(ask !== null && ask.on === "prop" && ask.value?.op === "range", query);
        const {lo, hi} = ask.value;
        assert.ok(!("text" in lo) && !("text" in hi), query);
        return [Number(lo.value), Number(hi.value)];
    };
    assert.deepEqual(bounds("cast:2-5ms"), [2, 5], "the bare bound takes the spelled one's unit");
    assert.deepEqual(bounds("cast:2ms-5"), [2, 5], "whichever side wears it");
    assert.deepEqual(bounds("cast:500ms-2s"), [500, 2000], "two spelled bounds read as written");
    assert.deepEqual(bounds("cast:2-5"), [2000, 5000], "no unit anywhere: the bounds read together");
});

it("a value's bare alternative takes the unit its phrase names", () => {
    // The same rule over alternatives instead of bounds: `200|500ms` is two readings in milliseconds, never one
    // of each. Without it a bare alternative fell back to the default and the two meant different units.
    const alts = (query: string): number[] => {
        const ask = parse(query).clauses[0].ask;
        assert.ok(ask !== null && ask.on === "prop" && ask.value?.op === "anyOf", query);
        return ask.value.alternatives.map((alt) => {
            assert.ok(alt.op === "contains" || alt.op === "exact", query);
            assert.ok(!("text" in alt.operand), query);
            return Number(alt.operand.value);
        });
    };
    assert.deepEqual(alts("cast:2|5ms"), [2, 5], "the bare alternative takes the spelled one's unit");
    assert.deepEqual(alts("cast:2s|5s"), [2000, 5000], "two spelled alternatives read as written");
    assert.deepEqual(alts("cast:2|5"), [2000, 5000], "no unit anywhere: both take the default");
});

it("a bare duration splits at a hundred, which is the fastest cast that exists", () => {
    // Measured on 9.2.7: the quickest cast in the game is exactly 100 ms, so a bare number under a hundred read
    // as milliseconds selects nothing — while above it the seconds reading is nearly as empty, only 24 of
    // 48,873 cast times running past a minute. `1.5` and `1500` therefore name the same duration.
    const stored = (query: string): number => {
        const ask = parse(query).clauses[0].ask;
        assert.ok(ask !== null, query);
        // `cast:` is a KIND's door, so the value arrives on the row test rather than on a property ask.
        const expr = ask.on === "prop" ? ask.value
            : ask.on === "kind" && ask.test?.is === "props" ? ask.test.value : null;
        assert.ok(expr !== null && "operand" in expr, query);
        assert.ok(!("text" in expr.operand), query);
        return Number(expr.operand.value);
    };
    assert.equal(stored("cast:2"), 2000, "under a hundred is seconds");
    assert.equal(stored("cast:99"), 99_000);
    assert.equal(stored("cast:100"), 100, "a hundred and over is milliseconds");
    assert.equal(stored("cast:1500"), 1500);
    assert.equal(stored("cast:1.5"), 1500, "which agrees with the seconds spelling of the same duration");
});

it("existence on a kind inside a scope is the kind word, not bare existence", () => {
    // `model:{display:*}` says the row is a display row — exactly what `model:{display}` says. Answering a bare
    // existence dropped WHICH kind was named and the term fell back to content, so the ask became "any model
    // row at all": 130,512 rows where it names 955. A wrong ANSWER, not a wrong drawing.
    const term = (query: string): { on: string; kind?: string } => {
        const ask = parse(query).clauses[0].ask;
        assert.ok(ask !== null && ask.on === "column" && ask.test?.is === "scope", query);
        const only = ask.test.terms.flat()[0].ask;
        assert.ok(only !== null, query);
        return {on: only.on, kind: only.on === "kindWord" ? wordOf(only.kind) : undefined};
    };
    assert.deepEqual(term("model:{display}"), {on: "kindWord", kind: "display"});
    assert.deepEqual(term("model:{display:*}"), {on: "kindWord", kind: "display"});
    assert.deepEqual(term("model:{display:any}"), {on: "kindWord", kind: "display"});
});


it("a pattern inside a scope keeps its own braces and bars: they are the pattern language, not a nested scope", () => {
    const parsed = parse(String.raw`name:{/^(fire|frost)[_-]?\d{2,}(?!bolt)$/}`, {mode: "final"});
    assert.deepEqual(parsed.diagnostics, []);
    assert.equal(parsed.clauses.length, 1);
    assert.equal(parsed.clauses[0].state, "ok");
    // A slash mid-word is still an ordinary character, so a path fragment reads as text.
    assert.equal(parse("model:{spell/fire}", {mode: "final"}).clauses[0].state, "ok");
});

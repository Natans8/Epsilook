import {strict as assert} from "node:assert";
import {describe, it} from "node:test";

import type {Ask, Clause, Diagnostic, Parsed, ScopeTerm, ValueExpr} from "../../../../src/search/index";
import {equivalent, fold, formatQuery, KINDS, parse} from "../../../../src/search/index";

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
            {op: "exact", operand: {type: "text", value: "Blood Pool", written: "Blood Pool"}});
        assert.deepEqual(valueOf(ok('name:"Blood Pool"')),
            {op: "contains", operand: {type: "text", value: "Blood Pool", written: "Blood Pool"}});
    });

    it("a comma list of numbers is alternation", () => {
        const value = valueOf(ok("id:133,134"));
        assert.equal(value.op, "anyOf");
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
        const range = (q: string): unknown => valueOf(ok(q));
        assert.deepEqual(range("scale:10-90"), {
            op: "range",
            lo: {type: "percentChange", value: -90, written: "10"},
            hi: {type: "percentChange", value: -10, written: "90"},
        });
        assert.deepEqual(range("scale:2-5"), {
            op: "range",
            lo: {type: "percentChange", value: 100, written: "2"},
            hi: {type: "percentChange", value: 400, written: "5"},
        });
        assert.deepEqual(range("scale:8-12"), {
            op: "range",
            lo: {type: "percentChange", value: -92, written: "8"},
            hi: {type: "percentChange", value: -88, written: "12"},
        });
        assert.deepEqual(range("scale:(-50)-10"), {
            op: "range",
            lo: {type: "percentChange", value: -50, written: "-50"},
            hi: {type: "percentChange", value: 10, written: "10"},
        });
    });

    it("a written unit is what it says: symbol bounds keep their own notations", () => {
        assert.deepEqual(valueOf(ok("scale:x2-x5")), {
            op: "range",
            lo: {type: "percentChange", value: 100, written: "x2"},
            hi: {type: "percentChange", value: 400, written: "x5"},
        });
        assert.deepEqual(valueOf(ok("scale:x2-50")), {
            op: "range",
            lo: {type: "percentChange", value: 100, written: "x2"},
            hi: {type: "percentChange", value: -50, written: "50"},
        });
    });

    it("exact and a pattern cannot combine, and the fix drops the anchor", () => {
        const [error] = invalid("name:=Fire*");
        assert.match(error.message, /exact and a pattern/);
        assert.equal(error.fix?.query, "name:Fire*");
    });

    it("a declined operator is a static error with the drop fix, in both modes", () => {
        const [error] = invalid("name:>m");
        assert.match(error.message, /no ordering/);
        assert.equal(error.fix?.query, "name:m");
        assert.equal(parse("name:>m", {mode: "typing"}).clauses[0].state, "invalid");
    });

    it("an ill-typed value is an error in final text and silence while typing", () => {
        const [error] = invalid("scale:abc");
        assert.match(error.message, /scale takes/);
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
            {op: "contains", operand: {type: "text", value: "Embody Hero: Illidan", written: "Embody Hero: Illidan"}});
        assert.deepEqual(valueOf(ok('name:"Elixir (Greater)"')),
            {op: "contains", operand: {type: "text", value: "Elixir (Greater)", written: "Elixir (Greater)"}});
        assert.deepEqual(valueOf(ok('model:"beam|chain"')),
            {op: "contains", operand: {text: "beam|chain"}});
    });

    it("an escaped quote is a literal quote", () => {
        assert.deepEqual(valueOf(ok(String.raw`name:"the \"real\" one"`)),
            {op: "contains", operand: {type: "text", value: 'the "real" one', written: 'the "real" one'}});
    });

    it("quotes never group clauses: a quoted pair stays a phrase", () => {
        assert.deepEqual(valueOf(ok('model:"fire missile"')),
            {op: "contains", operand: {text: "fire missile"}});
    });

    it("quotes suppress the vocabulary: a quoted kind word is content", () => {
        const ask = ok('model:"missile"');
        assert.equal(ask.on, "column");
        assert.deepEqual(valueOf(ask), {op: "contains", operand: {text: "missile"}});
    });

    it("a pattern inside a phrase is literal text, not a glob", () => {
        assert.equal(valueOf(ok('name:"bee*"')).op, "contains");
    });

    it("a quantity axis refuses a quoted number, with the drop-the-quotes fix", () => {
        const [error] = invalid('scale:"50"');
        assert.match(error.message, /a quoted value is text/);
        assert.equal(error.fix?.label, "drop the quotes");
        assert.equal(error.fix?.query, "scale:50");
        const typing = parse('scale:"50"', {mode: "typing"});
        assert.equal(typing.clauses[0].state, "incomplete");
        assert.deepEqual(typing.diagnostics, []);
    });

    it("the anchor does not change that: scale:=50 is a value, scale:=\"50\" is refused", () => {
        assert.deepEqual(valueOf(ok("scale:=50")), {
            op: "exact",
            operand: {type: "percentChange", value: -50, written: "50"}
        });
        const [error] = invalid('scale:="50"');
        assert.equal(error.fix?.query, "scale:=50");
    });

    it("a property door refuses a quoted quantity the same way a kind head does", () => {
        const [error] = invalid('cast:"5"');
        assert.match(error.message, /a quoted value is text/);
        assert.equal(error.fix?.query, "cast:5");
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
            operand: {type: "colour", value: 0xff_00_00, written: "red"}
        });
    });

    it("on a name-or-id property, digits are the id and quoted digits are the name", () => {
        const [byId] = termsOf(ok("sound:{kit:150}"));
        assert.ok(byId.ask !== null && byId.ask.on === "props");
        assert.deepEqual(byId.ask.value, {op: "exact", operand: {type: "id", value: 150, written: "150"}});
        const [byName] = termsOf(ok('sound:{kit:"150"}'));
        assert.ok(byName.ask !== null && byName.ask.on === "props");
        assert.deepEqual(byName.ask.value, {op: "contains", operand: {type: "text", value: "150", written: "150"}});
    });

    it("an unclosed phrase runs to the end of input", () => {
        assert.deepEqual(valueOf(ok('name:"fire')), {
            op: "contains",
            operand: {type: "text", value: "fire", written: "fire"}
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
        assert.match(error.message, /run on text and file paths/);
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
        assert.match(error.message, /not a valid pattern/);
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
        assert.match(error.message, /cannot read a model row/);
        assert.equal(error.fix?.query, "model:* sound:fire");
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
        assert.match(errors(parsed)[0].message, /positive term/);
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
        assert.match(error.message, /takes a value, not a scope/);
        assert.equal(parse("model:{fire {", {mode: "typing"}).clauses[0].state, "invalid");
    });

    it("an unclosed scope closes before the clause that cannot belong to it", () => {
        const parsed = parse("model:{fire sound:ice");
        assert.equal(parsed.clauses.length, 2);
        assert.equal(parsed.clauses[0].state, "ok");
        assert.equal((parsed.clauses[1].ask as ColumnAsk).column.key, "sound");
        const [warning] = warnings(parsed);
        assert.match(warning.message, /closed it before the next clause/);
        assert.equal(warning.fix?.query, "model:{fire } sound:ice");
    });

    it("count is universal, so it belongs and the scope closes at the end", () => {
        const parsed = parse("model:{fire count:>4");
        assert.equal(parsed.clauses.length, 1);
        assert.equal(parsed.clauses[0].state, "ok");
        assert.match(warnings(parsed)[0].message, /closed it at the end/);
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
        const seats = valueOf(ok("seats:>2"));
        assert.deepEqual(seats, {op: "gt", operand: {type: "count", value: 2, written: "2"}});
        assert.equal((ok("seats:>2") as KindAsk).test?.is, "props");
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
        assert.match(warnings(parsed)[0].message, /glued together/);
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
        const parsed = parse('scale:"50" model:fire');
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
    "model:>4", "mech:2-4", "model:{fire >4}", "missile:{>2}", "seats:>2", "model:{}",
    "model:(attach:chest)", "model:(fire missile)", "model:(fire|frost)", "model:(fire|frost)bolt",
    "description:kneel", "expansion:>wotlk", "models:fire", "fx:{camouflage}", "chain:{color:red}",
    "model:{fire count:>4", "model:{fire sound:ice",
    'frost model:{missile attach:(chest|"right hand") -fire} scale:50-* cast:instant',
    "model：火", "name:Огненный", "Огненный", "name:al'ar", "name:al’ar",
    "model<=4", "scale>50", "cast<2", "name=Fireball", "model:{count<=4}", "a=b",
    "name:/^fire/", "model:/beam|chain/", "model:{/^spells/ fire}", String.raw`name:/a\/b/`, "/fire/",
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
        assert.deepEqual(parse(""), {clauses: [], groups: [], diagnostics: []});
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

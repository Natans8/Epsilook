import {strict as assert} from "node:assert";
import {describe, it} from "node:test";

import {equivalent, formatQuery, parse} from "../../../../src/search/index";

/** The canonical form of a query: format its parse. */
const canonical = (query: string): string => formatQuery(parse(query));

/** Whether two query strings ask the same evaluable question. */
const same = (a: string, b: string): boolean => equivalent(parse(a), parse(b));

describe("formatQuery", () => {
    it("is idempotent: formatting the parse of a canonical string returns it", () => {
        for (const query of [
            "fireball", "model:fire -sound:ice", "name=Fireball", 'name:"Blood Pool"',
            "model:{fire missile}", "model:{attach:(chest|head) fire}", "scale>50", "cast:instant",
            "name:/^fire/", "model:fire | sound:fire", 'missile:{from:chest to:"right hand" motion:parabola}',
            "scale:(-50)-10", "xpac>legion", "-model:*", "model:missile", "model<=4",
            // Values whose bare spelling would re-read as structure keep their quotes.
            '"model:fire"', '"-fire"', 'name:"fi*re"', 'model:"/fire"', 'name:"1,2"', 'name:"<3"',
            String.raw`"a \\"`, "model:{fire|frost missile}",
            // A colon inside a value has no meaning, so the bare spelling re-reads as itself.
            "model:mount:horse", "sound:kit:150", 'model:"mount:horse"',
        ]) {
            const once = canonical(query);
            assert.equal(canonical(once), once, query);
        }
    });

    it("converges lenient spellings onto the canonical one", () => {
        assert.equal(canonical("model:(fire missile)"), "model:{fire missile}");
        assert.equal(canonical("model:(attach:chest)"), "model:{attach:chest}");
        assert.equal(canonical("model:{fire}"), "model:fire");
        assert.equal(canonical("id:133,134"), "id:(133|134)");
        assert.equal(canonical("model:{count:<=4}"), "model<=4");
        assert.equal(canonical("name:=Fireball"), "name=Fireball");
    });

    it("binds a prefix operator without the colon, at the top level and inside a scope", () => {
        assert.equal(canonical("cast:>2s"), "cast>2s");
        assert.equal(canonical("scale:>=+20%"), "scale>=+20%");
        assert.equal(canonical("model:{fire count:<4}"), "model:{fire count<4}");
        assert.equal(canonical("model:{attach:=chest fire}"), "model:{attach=chest fire}");
    });

    it("spells a bare kind-existence ask through its column", () => {
        assert.equal(canonical("missile:*"), "model:missile");
        assert.equal(canonical("model:missile"), "model:missile");
    });

    it("canonicalises open ranges to the comparison spelling", () => {
        assert.equal(canonical("cast:10-*"), "cast>=10s");
        assert.equal(canonical("cast:*-10"), "cast<=10s");
        assert.equal(canonical("cast:10-"), "cast>=10s");
    });

    it("writes sentinels as their words and values in their display notation", () => {
        assert.equal(canonical("cast:0"), "cast:instant");
        assert.equal(canonical("scale:2"), "scale=+100%");
        assert.equal(canonical('cast:"instant"'), "cast:instant");
    });

    it("quotes what would otherwise read as structure, and keeps a pattern's slashes", () => {
        assert.equal(canonical('name:"Blood Pool"'), 'name:"Blood Pool"');
        assert.equal(canonical("name:/^fire/"), "name:/^fire/");
    });

    it("keeps quotes wherever dropping them would change the ask", () => {
        assert.equal(canonical('"model:fire"'), '"model:fire"');
        assert.equal(canonical('"-fire"'), '"-fire"');
        assert.equal(canonical('name:"fi*re"'), 'name:"fi*re"');
        assert.equal(canonical('model:"/fire"'), 'model:"/fire"');
        assert.equal(canonical('name:"1,2"'), 'name:"1,2"');
    });

    it("a word shared across kinds keeps that word: one kind's name would narrow the ask", () => {
        // `file:` reaches every kind's file, and the paste that settled as `missile:wolf` had been narrowed
        // to one kind's rows — a different question wearing a confident spelling.
        assert.equal(canonical("model:{attach file:wolf}"), "model:{attach file:wolf}");
        assert.equal(canonical("model:{file:wolf}"), "model:{file:wolf}");
    });

    it("never repeats a kind's word inside its own scope: the subject speaks bare there", () => {
        // Inside `name:{...}` the word is already the door overhead; writing it again names a property the
        // kind does not have, and the spelling stopped parsing — the keymash `name:{"\"""\\}}` found it.
        assert.equal(canonical('name:{"fire" "ball"}'), 'name:{"fire" "ball"}');
        // The keymash spelling converges once — escapes respelled canonically — and then holds.
        const once = canonical(String.raw`name:{"\\" "" "\\\\\}"}`);
        assert.equal(once, String.raw`name:{"\\" "" "\\\\}"}`);
        assert.equal(canonical(once), once);
        // A foreign kind's subject inside a COLUMN scope keeps binding through the kind's word.
        assert.equal(canonical("model:{mount:horse fire}"), "model:{mount:horse fire}");
    });

    it("keeps a value's colon bare: quoting is not an escape, it changes the ask", () => {
        // The colon-glued shape keeps its content reading — only a comparison glues an inner bind — so the bare
        // spelling re-reads as the same content, where the phrase would flip its squashed match to a verbatim one.
        assert.equal(canonical("model:mount:horse"), "model:mount:horse");
        assert.equal(canonical("sound:kit:150"), "sound:kit:150");
        // The alternation stays GLUED: parenthesised, the inner colon would flip the group to a scope.
        assert.equal(canonical("model:mount:horse|fire"), "model:mount:horse|fire");
        // A one-term scope promotes to the bind form, which reads the colon the same way.
        assert.equal(canonical("model:{foo:bar}"), "model:foo:bar");
        // The reader who QUOTED chose the string, and that choice stays.
        assert.equal(canonical('model:"mount:horse"'), 'model:"mount:horse"');
    });

    it("glues a scope term's alternation, which is the spelling a scope reads", () => {
        assert.equal(canonical("model:{fire|frost missile}"), "model:{fire|frost missile}");
    });

    it("writes only the evaluable query: broken clauses are not part of it", () => {
        assert.equal(canonical("scale:abc model:fire"), "model:fire");
        assert.equal(canonical("model:"), "");
    });
});

describe("the written tier", () => {
    const written = (query: string): string => formatQuery(parse(query), "written");

    it("upholds the notation the reader chose where canonical converges it", () => {
        assert.equal(written("scale:x1.5"), "scale:x1.5");
        assert.equal(canonical("scale:x1.5"), "scale=+50%");
        assert.equal(written("cast:500ms"), "cast:500ms");
        // The bare bound took the phrase's notation when it was read, so it is written wearing it.
        assert.equal(written("scale:x2-50"), "scale:x2-x50");
    });

    it("writes the unit of the notation that read a bare number, without converging the number", () => {
        // A bare number leaves its unit implicit and a surface writing it back leaves the reader guessing which
        // one it landed in -- which is a real question wherever a type splits its bare numbers by size.
        assert.equal(written("cast:2"), "cast:2s");
        assert.equal(written("cast:1500"), "cast:1500ms", "the bare threshold, said out loud");
        assert.equal(written("scale:2"), "scale:x2", "up to ten a bare number is a factor");
        assert.equal(written("scale:50"), "scale:50%", "above ten it is a proportion");
        assert.equal(written("cast:10-*"), "cast>=10s");
        // Apart from converging, which writes the value in the type's display notation whatever was typed.
        assert.equal(canonical("scale:50"), "scale=-50%");
        // A pair is classified together, so it is spelled together: never a factor beside a proportion.
        assert.equal(written("scale:10-90"), "scale:10%-90%");
        assert.equal(written("scale:2-5"), "scale:x2-x5");
    });

    it("still converges structure: delimiters and anchors spell canonically around the upheld value", () => {
        assert.equal(written("model:(fire missile)"), "model:{fire missile}");
        assert.equal(written("cast:instant"), "cast:instant");
        assert.equal(written("cast:0"), "cast:0s");
    });

    it("is idempotent: the written form of a written form is itself", () => {
        for (const query of ["scale:x1.5", "cast:500ms", "scale:x2-50", "cast:10-*", "cast:2", "scale:10-90",
            "range:40"]) {
            const once = written(query);
            assert.equal(formatQuery(parse(once), "written"), once, query);
        }
    });

    it("never reaches equivalence, which compares through the folded canonical", () => {
        assert.ok(same("scale:x1.5", "scale:+50"));
        assert.ok(same("cast:500ms", "cast:0.5"));
    });
});

describe("equivalent", () => {
    it("clause order never matters, and neither does group order", () => {
        assert.ok(same("model:fire -model:missile", "-model:missile model:fire"));
        assert.ok(same("model:fire | sound:fire", "sound:fire | model:fire"));
    });

    it("holds across every lenient spelling of one question", () => {
        assert.ok(same("model:(fire missile)", "model:{fire missile}"));
        assert.ok(same("model:{fire}", "model:fire"));
        assert.ok(same("id:133,134", "id:(133|134)"));
        assert.ok(same("cast:10-*", "cast:>=10"));
        assert.ok(same("model<=4", "model:{count:<=4}"));
        assert.ok(same("cast:instant", 'cast:"instant"'));
        assert.ok(same("model:{}", "model:*"));
    });

    it("separates what the row scope separates", () => {
        assert.ok(!same("model:fire model:missile", "model:{fire missile}"));
        assert.ok(!same("model:fire", "model:frost"));
        assert.ok(!same("model:fire", "-model:fire"));
        assert.ok(!same("scale:>50", "scale:>=50"));
    });

    it("separates a literal string from the structure it is spelled like", () => {
        assert.ok(!same('"-fire"', "-fire"));
        assert.ok(!same('name:"=fire"', "name:=fire"));
        assert.ok(!same('name:"fi*re"', "name:fi*re"));
    });

    it("never separates on letter case, which matching folds", () => {
        assert.ok(same("model:fire", "model:FIRE"));
        assert.ok(same("name:Fireball", "name:fireball"));
        assert.ok(same('name:"Blood Pool"', 'name:"blood pool"'));
        assert.ok(same("name:=Fireball", "name:=FIREBALL"));
        assert.ok(same("model:{Fire missile}", "model:{fire missile}"));
        assert.ok(same("name:fire*ball", "name:FIRE*BALL"));
    });

    it("keeps regex patterns case-sensitive: folding one would flip its character classes", () => {
        assert.ok(same("name:/^Fire/", "name:/^Fire/"));
        assert.ok(!same(String.raw`name:/\D/`, String.raw`name:/\d/`));
    });

    it("keeps the written case in the display canonical: only comparison folds", () => {
        assert.equal(canonical("name:Fireball"), "name:Fireball");
        assert.equal(canonical("model:FIRE"), "model:FIRE");
    });

    it("round-trips: a query is equivalent to its own canonical form", () => {
        for (const query of [
            "model:{attach:(chest|head) fire}", "frost scale:50-* cast:instant", "name:/^fire/",
            "model:fire model:arcane | model:frost model:shadow",
            '"model:fire"', "model:{fire|frost missile}", 'name:"1,2"', "id:133,134",
        ]) {
            assert.ok(same(query, canonical(query)), query);
        }
    });
});

it("a kind word and its row count write back as the one term the reader typed", () => {
    assert.equal(formatQuery(parse("model:{attach count>2}"), "written"), "model:{attach>2}");
    assert.equal(formatQuery(parse("model:{attach>2}"), "written"), "model:{attach>2}");
    // A negated kind is not the pair, and keeps the count word.
    assert.equal(formatQuery(parse("model:{-attach count>2}"), "written"), "model:{-attach count>2}");
});

/**
 * @file Folding: what two spellings of the same thing compare equal, and the position contract the parser rests on.
 *
 * Both sides of every match fold with the same function, so each case here implies its mirror: a corpus string is as
 * reachable by the folded query as the query is able to reach the folded corpus.
 */
import {strict as assert} from "node:assert";
import {describe, it} from "node:test";

import {fold, foldTypography, squash} from "../../src/search/text-normalization";

describe("foldTypography", () => {
    it("restores substituted characters to their plain forms", () => {
        assert.equal(foldTypography("“blood pool”"), '"blood pool"');
        assert.equal(foldTypography("scale:10–20"), "scale:10-20");
        assert.equal(foldTypography("model：fire"), "model:fire");
    });

    it("replaces one character with one character, so every position survives", () => {
        // The parser tokenizes the folded text while reporting spans against the text as typed; a substitution that
        // changed length would silently shift every diagnostic after it.
        for (const text of ["“a–b”", "x：y", "a b", "—", "plain text"]) {
            assert.equal(foldTypography(text).length, text.length, JSON.stringify(text));
        }
    });

    it("leaves case and spelling alone, which belong to fold", () => {
        assert.equal(foldTypography("Colour"), "Colour");
    });
});

describe("fold", () => {
    it("removes letter case, locale-independently", () => {
        assert.equal(fold("FrostBolt"), "frostbolt");
        assert.equal(fold("Огненный"), "огненный");
    });

    it("folds regional spellings to the spelling the game data uses", () => {
        assert.equal(fold("colour"), "color");
        assert.equal(fold("color"), "color");
        assert.equal(fold("Armour of the Fallen"), "armor of the fallen");
    });

    it("folds inflections as their own pairs, on word boundaries only", () => {
        // The table is generated from VarCon, so colours and coloured are entries of their own rather than the
        // product of a substring rule — which is what lets the match demand word boundaries and never rewrite a
        // fragment inside an unrelated word.
        assert.equal(fold("colours"), "colors");
        assert.equal(fold("Grey Colours"), "gray colors");
        assert.equal(fold("cursecolour"), "cursecolour");
    });

    it("keeps spacing and punctuation, so a phrase means what it shows", () => {
        assert.equal(fold("Anti-Magic Shell"), "anti-magic shell");
    });
});

describe("squash", () => {
    it("reduces to letters and digits, so punctuation does not have to be remembered", () => {
        assert.equal(squash("Anti-Magic Shell"), "antimagicshell");
        assert.ok(squash("Anti-Magic").includes(squash("antimagic")));
    });

    it("keeps letters of every script", () => {
        assert.equal(squash("Огненный шар"), "огненныйшар");
        assert.equal(squash("火球术"), "火球术");
    });

    it("carries the spelling fold, so armour finds armor in partial matches too", () => {
        // The pair must be one the generated table kept — the table is intersected with the default pack's
        // corpus, and armor is a word that corpus will never lose.
        assert.ok(squash("platearmorheavy").includes(squash("Armour")));
    });
});

--- How text is folded for matching, and how a folded operand becomes a pattern.
--
-- The web engine folds both sides of a match: typography is normalised, case
-- is dropped, and for a substring test everything that is not a letter or a
-- digit is removed, so `fire ball` finds `Fireball`. The addon cannot afford to
-- fold a stored column -- the columns are one string each, and folding one
-- means a copy -- so it folds the OPERAND and turns it into a pattern that
-- matches the stored text as written: each letter becomes a class of its two
-- cases, and for a substring test every gap between letters admits a run of
-- anything that is not a letter or a digit. One `string.find` over a column
-- then answers what folding both sides would have, at no copy.
--
-- Two things the web does that this does not, deliberately. Letter case is
-- folded for the ASCII letters only, because that is the case the client's
-- own `string.lower` knows; a name in another alphabet still matches when
-- typed in its own case. And regional spellings are not folded: `colour` does
-- not find `color` here.
--
-- Nothing here touches a WoW global.

_G.Epsilook = _G.Epsilook or {}
local Epsilook = _G.Epsilook

local Text = {}
Epsilook.Text = Text

local byte, char, gsub, lower, sub = string.byte, string.char, string.gsub, string.lower, string.sub

--- Typographic characters that read as their plain equivalent, by the bytes
-- they take in UTF-8. Double quotes become the phrase delimiter, single quotes
-- and both stray accents the apostrophe, every dash the hyphen, every odd
-- space a plain space, and the full-width colon the one that binds.
--
-- Two tables because two passes: the general punctuation block is one run of
-- three-byte sequences differing in their last byte, so one class over that
-- byte finds every candidate and the table says which to replace; the rest
-- are scattered sequences of two or three bytes found by their lead byte.
local PUNCTUATION_BLOCK = {
	["\226\128\128"] = " ",
	["\226\128\129"] = " ",
	["\226\128\130"] = " ",
	["\226\128\131"] = " ",
	["\226\128\132"] = " ",
	["\226\128\133"] = " ",
	["\226\128\134"] = " ",
	["\226\128\135"] = " ",
	["\226\128\136"] = " ",
	["\226\128\137"] = " ",
	["\226\128\138"] = " ",
	["\226\128\139"] = " ",
	["\226\128\140"] = " ",
	["\226\128\141"] = " ",
	["\226\128\146"] = "-",
	["\226\128\147"] = "-",
	["\226\128\148"] = "-",
	["\226\128\152"] = "'",
	["\226\128\153"] = "'",
	["\226\128\155"] = "'",
	["\226\128\156"] = '"',
	["\226\128\157"] = '"',
	["\226\128\158"] = '"',
	["\226\128\159"] = '"',
	["\226\128\168"] = " ",
	["\226\128\169"] = " ",
	["\226\128\175"] = " ",
}
local SCATTERED = {
	["\194\160"] = " ",
	["\194\180"] = "'",
	["\226\129\159"] = " ",
	["\226\136\146"] = "-",
	["\227\128\128"] = " ",
	["\239\187\191"] = " ",
	["\239\188\154"] = ":",
}

--- Typographic variants replaced by the plain character they stand for.
-- A sequence the tables do not name is left as it stands: a table handed to
-- `gsub` keeps any match it has no entry for.
-- @param text the text as typed
-- @return the text with every variant replaced, one to one
function Text.foldTypography(text)
	local out = gsub(text, "\226\128[\128-\175]", PUNCTUATION_BLOCK)
	-- A lead byte and its continuation bytes; a two-byte sequence is never
	-- followed by a continuation byte, so taking a third where one follows
	-- is always right.
	out = gsub(out, "[\194\226\227\239][\128-\191][\128-\191]?", SCATTERED)
	return (gsub(out, "`", "'"))
end

--- The game's own text markup removed: colour codes, link wrappers, texture
-- and atlas escapes, and a doubled pipe read as one.
-- @param text the text
-- @return the text with the markup gone and a link's shown words kept
function Text.stripMarkup(text)
	if not text:find("|", 1, true) then
		return text
	end
	local out = text
	out = gsub(out, "||", "\1")
	out = gsub(out, "|H[^|]*|h(.-)|h", "%1")
	out = gsub(out, "|T[^|]*|t", "")
	out = gsub(out, "|A[^|]*|a", "")
	out = gsub(out, "|c%x%x%x%x%x%x%x%x", "")
	out = gsub(out, "|n", " ")
	out = gsub(out, "|[rw]", "")
	out = gsub(out, "\1", "|")
	return out
end

--- The folded form of an operand: typography plain, markup gone, case dropped.
-- @param text the text as typed
-- @return the folded text
function Text.fold(text)
	return lower(Text.stripMarkup(Text.foldTypography(text)))
end

--- The folded form of an operand with the space around it dropped, which is
-- how a number, a sentinel word and a rung are read.
function Text.foldTrimmed(text)
	return Text.fold(text:match("^%s*(.-)%s*$"))
end

--- Everything that is not a letter or a digit, as a pattern class.
-- A byte above the ASCII range is part of a letter in another alphabet, so
-- those bytes count as letters rather than as punctuation.
local NON_WORD = "[^%w\128-\255]"

--- The squashed form of an operand: folded, and then nothing but letters and digits.
-- @param text the text as typed
-- @return the squashed text, possibly empty
function Text.squash(text)
	return (gsub(Text.fold(text), NON_WORD, ""))
end

--- Characters that mean something in a Lua pattern, each escaped.
local MAGIC = "[%^%$%(%)%%%.%[%]%*%+%-%?]"

--- One character of an operand as a pattern matching it in either case.
local function cased(c)
	local code = byte(c)
	if code >= 97 and code <= 122 then
		return "[" .. char(code - 32) .. c .. "]"
	elseif code >= 65 and code <= 90 then
		return "[" .. c .. char(code + 32) .. "]"
	end
	return (gsub(c, MAGIC, "%%%0"))
end

--- A folded operand as a pattern over stored text, one case-blind class per
-- character, with `glue` between them.
local function patternOf(folded, glue)
	if folded == "" then
		return nil
	end
	local parts = {}
	for i = 1, #folded do
		parts[i] = cased(sub(folded, i, i))
	end
	return table.concat(parts, glue)
end

--- The pattern a substring test runs over a stored column.
-- The operand is squashed first; between any two of its characters the
-- stored text may carry a run of anything that is not a letter or a digit,
-- which is what matching two squashed strings would have allowed.
-- @param text the operand as typed
-- @return the pattern, or nil where nothing is left to match on
function Text.containsPattern(text)
	return patternOf(Text.squash(text), NON_WORD .. "*")
end

--- The pattern an anchored test runs over a stored column.
-- The operand is folded but not squashed: a reader who anchors a match is
-- asking for the whole value as written, punctuation and spaces included.
-- @param text the operand as typed
-- @return the pattern, or nil where the operand is empty
function Text.exactPattern(text)
	return patternOf(Text.fold(text), "")
end

--- A test of whole stored strings against a folded operand, by the same rule
-- the column pattern applies, for the handful of reads that test one value
-- rather than scan a column: a word of a vocabulary, a flag's name.
-- @param text the operand as typed
-- @return a function from a stored string to true or false; never true for an operand with nothing to match on
function Text.containsTest(text)
	local needle = Text.squash(text)
	return function(stored)
		return needle ~= "" and Text.squash(stored):find(needle, 1, true) ~= nil
	end
end

--- A test of whole stored strings being a folded operand, whole.
-- @param text the operand as typed
-- @return a function from a stored string to true or false
function Text.equalsTest(text)
	local wanted = Text.fold(text)
	return function(stored)
		return Text.fold(stored) == wanted
	end
end

return Text

--- Applying one operator to stored values: the tests, and the column scans
-- that answer them wholesale.
--
-- The narrowest matching step, and the name says which: a VALUE is compared
-- against an operand. Whether a row satisfies a clause and whether a spell
-- satisfies a query are decided above this file, in `Search`.
--
-- Two shapes of answer. `Match.Test` builds a function from one operator, one
-- type and one operand, and that function is asked about one stored value at
-- a time -- a number read off a row, a role mask, a rung. `Match.ScanText`
-- answers for a whole text column at once, running the operand's pattern over
-- the column's one string and collecting the rows it lands in, which is how a
-- quarter of a million names are searched without reading one of them out.
--
-- Nothing here touches a WoW global.

_G.Epsilook = _G.Epsilook or {}
local Epsilook = _G.Epsilook

local Match = {}
Epsilook.Match = Match

local Reader = Epsilook.Reader
local Schema = Epsilook.Schema
local Text = Epsilook.Text

local floor, abs, find, sub = math.floor, math.abs, string.find, string.sub

local function always()
	return true
end

local function never()
	return false
end

--- The orderings, each over the sign of one comparison: a stored value
-- against an operand, or a stored rank against a wanted rank.
local COMPARE = {
	exact = function(a, b)
		return a == b
	end,
	lt = function(a, b)
		return a < b
	end,
	lte = function(a, b)
		return a <= b
	end,
	gt = function(a, b)
		return a > b
	end,
	gte = function(a, b)
		return a >= b
	end,
}

--- A test of a stored value being within two bounds, whichever way round they were written.
local function between(lo, hi, rank)
	if lo > hi then
		lo, hi = hi, lo
	end
	return function(stored)
		local value = stored
		if rank then
			value = rank(stored)
		end
		return value ~= nil and value >= lo and value <= hi
	end
end

--- The channels of a packed colour.
local function channels(packed)
	return floor(packed / 65536) % 256, floor(packed / 256) % 256, packed % 256
end

--- The bits two masks share. Arithmetic rather than the client's bit library,
-- so the file runs under a bare interpreter; the masks are a handful of bits.
local function band(a, b)
	local out, place = 0, 1
	while a > 0 and b > 0 do
		if a % 2 == 1 and b % 2 == 1 then
			out = out + place
		end
		a, b, place = floor(a / 2), floor(b / 2), place * 2
	end
	return out
end

--- The text of an operand, typed or written.
local function textOf(operand)
	return operand.text or tostring(operand.value)
end

--- The test for one operator on one type against one operand.
-- @param op the operator name
-- @param typeName the type the stored value is of
-- @param operand the operand: a typed operand, or for a range a table with lo and hi
-- @return a function from a stored value to true or false
function Match.Test(op, typeName, operand)
	if op == "present" then
		if typeName == "bitmask" then
			return function(stored)
				return stored ~= 0
			end
		end
		if Schema.IsTextual(typeName) or typeName == "ordinal" then
			return function(stored)
				return stored ~= ""
			end
		end
		return always
	end

	if Schema.IsTextual(typeName) then
		if op == "exact" then
			return Text.equalsTest(textOf(operand))
		elseif op == "contains" then
			-- A quoted operand is matched as written: quotes are strict, and
			-- the squashed substring test is the bare spelling's alone.
			if operand.verbatim then
				return Text.verbatimTest(textOf(operand))
			end
			return Text.containsTest(textOf(operand))
		end
		return never
	end

	if Schema.IsQuantity(typeName) then
		if op == "range" then
			return between(operand.lo.value, operand.hi.value)
		end
		local wanted, compare = tonumber(operand.value), COMPARE[op]
		if wanted == nil or not compare then
			return never
		end
		return function(stored)
			return compare(stored, wanted)
		end
	end

	if typeName == "colour" then
		local wanted = tonumber(operand.value)
		if wanted == nil then
			return never
		end
		if op == "exact" then
			return function(stored)
				return stored == wanted
			end
		elseif op == "contains" then
			local r2, g2, b2 = channels(wanted)
			local tolerance = Schema.colourTolerance
			return function(stored)
				local r1, g1, b1 = channels(stored)
				return abs(r1 - r2) <= tolerance
					and abs(g1 - g2) <= tolerance
					and abs(b1 - b2) <= tolerance
			end
		end
		return never
	end

	if typeName == "bitmask" then
		local role = Schema.roles[Text.fold(textOf(operand))]
		if op ~= "exact" or not role then
			return never
		end
		local any, all = role.any, role.all
		return function(stored)
			if any and band(stored, any) == 0 then
				return false
			end
			return not all or band(stored, all) == all
		end
	end

	if typeName == "ordinal" then
		local rank = Schema.OrdinalRank
		if op == "range" then
			local lo, hi = rank(operand.lo.value), rank(operand.hi.value)
			if not lo or not hi then
				return never
			end
			return between(lo, hi, rank)
		end
		-- A rung is named, so there is no substring reading of it: a bare
		-- token ranks against the ladder as an equality.
		local wanted = rank(textOf(operand))
		local compare = COMPARE[op == "contains" and "exact" or op]
		if not wanted or not compare then
			return never
		end
		return function(stored)
			local at = rank(stored)
			return at ~= nil and compare(at, wanted)
		end
	end

	if typeName == "flag" then
		return always
	end
	return never
end

--- How many characters of a column one window of a scan covers. A window is
-- copied out and searched on its own, so a scan yields between windows
-- whatever it finds in them; the size trades the copy against the number of
-- pauses.
Match.WINDOW = 65536

--- Which rows of a text column an operator lands in.
-- The operand's pattern is run over the column's string a window at a time,
-- each window copied out with an overlap long enough for any match that
-- begins inside it to end, so a match straddling the boundary is found by
-- the window it begins in and no other. A row is counted once and the scan
-- resumes past it; a match that runs across the boundary into the next row
-- is not a hit in either, and the scan resumes one character on so nothing
-- in the second row is skipped.
-- @param blob the chunk's payload
-- @param node the text column's header entry
-- @param op "contains", "verbatim" or "exact"
-- @param written the operand as typed
-- @param tick a function called after each window, or nil; what lets a
--   caller drive the scan across frames
-- @return a set of rows counted from zero, empty where nothing matches
function Match.ScanText(blob, node, op, written, tick)
	local hits = {}
	-- A verbatim scan wants the characters as written anywhere in a row, so it
	-- runs the anchored test's pattern under the substring test's acceptance.
	local pattern = op == "contains" and Text.containsPattern(written) or Text.exactPattern(written)
	local rows = Reader.size(node)
	if not pattern or rows == 0 then
		return hits
	end
	local index = node.index
	local base = node.at
	local last = base + Reader.number(blob, index, rows) - 1
	-- A match is as long as the operand, folded character for character;
	-- twice that is room for any folding that widens.
	local overlap = #written * 2
	local pos = base
	while pos <= last do
		local windowEnd = pos + Match.WINDOW - 1
		if windowEnd > last then
			windowEnd = last
		end
		local reach = windowEnd + overlap
		if reach > last then
			reach = last
		end
		local text = sub(blob, pos, reach)
		local at = 1
		while true do
			local s, e = find(text, pattern, at)
			if not s or pos + s - 1 > windowEnd then
				break
			end
			local from, to = pos + s - 1, pos + e - 1
			local row = Reader.rowAtMost(blob, index, from - base)
			local rowStart = base + Reader.number(blob, index, row)
			local rowEnd = base + Reader.number(blob, index, row + 1) - 1
			if to <= rowEnd then
				if op ~= "exact" or (from == rowStart and to == rowEnd) then
					hits[row] = true
				end
				at = rowEnd + 2 - pos
			else
				at = s + 1
			end
		end
		pos = windowEnd + 1
		if tick then
			tick()
		end
	end
	return hits
end

return Match

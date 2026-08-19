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

local floor, abs, find = math.floor, math.abs, string.find

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

--- Which rows of a text column an operator lands in.
-- One pass of the operand's pattern over the column's string. A row is
-- counted once and the scan resumes past it; a match that runs across the
-- boundary into the next row is not a hit in either, and the scan resumes one
-- character on so nothing in the second row is skipped.
-- @param blob the chunk's payload
-- @param node the text column's header entry
-- @param op "contains" or "exact"
-- @param written the operand as typed
-- @return a set of rows counted from zero, empty where nothing matches
function Match.ScanText(blob, node, op, written)
	local hits = {}
	local pattern = op == "exact" and Text.exactPattern(written) or Text.containsPattern(written)
	local rows = Reader.size(node)
	if not pattern or rows == 0 then
		return hits
	end
	local index = node.index
	local base = node.at
	local last = base + Reader.number(blob, index, rows) - 1
	local pos = base
	while pos <= last do
		local s, e = find(blob, pattern, pos)
		if not s or s > last then
			break
		end
		local row = Reader.rowAtMost(blob, index, s - base)
		local rowStart = base + Reader.number(blob, index, row)
		local rowEnd = base + Reader.number(blob, index, row + 1) - 1
		if e <= rowEnd then
			if op ~= "exact" or (s == rowStart and e == rowEnd) then
				hits[row] = true
			end
			pos = rowEnd + 1
		else
			pos = s + 1
		end
	end
	return hits
end

return Match

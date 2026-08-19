--- Reads the columns an Epsilook data file carries.
--
-- The one account of the layout, and it is on this side deliberately. The
-- emitter writes the blob and this reads it, so a Python copy of these rules
-- would be a second account of one thing and the two would drift. What keeps
-- them honest instead is a test: it emits a chunk, loads it here, and compares
-- what comes back against the pack the chunk was made from.
--
-- Nothing here touches a WoW global, so it runs under a bare interpreter with
-- no stubs at all. That is the guard rather than a lint rule: if it needs the
-- game to run, it stops being testable and the test stops running.
--
-- The reading is by row on purpose. A column is a region of one long string,
-- and asking for row n slices it where it lies rather than turning the column
-- into a table first. `Reader.all` exists for verification and says so.

_G.Epsilook = _G.Epsilook or {}
local Epsilook = _G.Epsilook

local Reader = {}
Epsilook.Reader = Reader

local DIGITS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
local BASE = 64

--- What each digit is worth, keyed by its byte so a read needs no substring.
local PLACE = {}
for index = 1, #DIGITS do
	PLACE[string.byte(DIGITS, index)] = index - 1
end

local byte, sub, tonumber, floor = string.byte, string.sub, tonumber, math.floor

--- How many rows a column holds.
-- @param node the header entry describing the column
-- @return the row count
function Reader.size(node)
	return node.n or 0
end

--- One whole number out of a numeric column.
-- @param blob the chunk's payload
-- @param node the header entry describing the column
-- @param row which row, counted from zero
-- @return the number
function Reader.number(blob, node, row)
	-- Bounds are checked because being outside them is not detectable
	-- afterwards. Every byte of the blob is a valid digit, so a read past this
	-- column lands in the next one and returns a number that looks entirely
	-- ordinary. Reading a row's end as the next row's start needs no slack
	-- here: an index column carries one more entry than the column it
	-- indexes, so that read is already inside it.
	if row < 0 or row >= node.n then
		error("row " .. tostring(row) .. " is outside a column of " .. tostring(node.n))
	end
	local width = node.width
	local at = node.at + row * width
	local value = 0
	for index = at, at + width - 1 do
		value = value * BASE + PLACE[byte(blob, index)]
	end
	return value + node.base
end

--- One string out of a text column.
-- A row ends where the next begins, which is why the index carries one more
-- offset than the column has rows and no separator is stored at all.
-- @param blob the chunk's payload
-- @param node the header entry describing the column
-- @param row which row, counted from zero
-- @return the text, which may be empty
function Reader.text(blob, node, row)
	local index = node.index
	local from = Reader.number(blob, index, row)
	local to = Reader.number(blob, index, row + 1)
	return sub(blob, node.at + from, node.at + to - 1)
end

--- One row of a column, whatever kind it is.
-- @param blob the chunk's payload
-- @param node the header entry describing the column
-- @param row which row, counted from zero
-- @return the value
function Reader.value(blob, node, row)
	local kind = node.kind
	if kind == "int" then
		return Reader.number(blob, node, row)
	elseif kind == "text" then
		return Reader.text(blob, node, row)
	elseif kind == "float" then
		return tonumber(Reader.text(blob, node, row))
	elseif kind == "list" then
		local index, values = node.index, node.values
		local from = Reader.number(blob, index, row)
		local to = Reader.number(blob, index, row + 1)
		local out = {}
		for at = from, to - 1 do
			out[#out + 1] = Reader.value(blob, values, at)
		end
		return out
	end
	error("no reader for a " .. tostring(kind) .. " column")
end

--- Every row of a column, as a table.
-- For checking a chunk against what it was built from, and for a column small
-- enough that holding it costs nothing. It is the one call here that
-- materialises, so anything in the hot path should be reading by row instead.
-- @param blob the chunk's payload
-- @param node the header entry describing the column
-- @return a table of values, or of tables for the composite kinds
function Reader.all(blob, node)
	local kind = node.kind
	if kind == "map" then
		local keys, values = node.keys, node.values
		local out = {}
		for row = 0, Reader.size(keys) - 1 do
			out[Reader.value(blob, keys, row)] = Reader.value(blob, values, row)
		end
		return out
	elseif kind == "group" then
		local out = {}
		for name, sub_node in pairs(node.columns) do
			out[name] = Reader.all(blob, sub_node)
		end
		return out
	elseif kind == "dedup" then
		return { text = Reader.all(blob, node.pool), of = Reader.all(blob, node.of) }
	elseif kind == "sparse" then
		return { at = Reader.all(blob, node.at), is = Reader.all(blob, node["is"]) }
	end

	local out = {}
	for row = 0, Reader.size(node) - 1 do
		out[row + 1] = Reader.value(blob, node, row)
	end
	return out
end

--- The row a sorted whole-number column holds a value at.
-- A binary search, so a column of a quarter of a million ids costs eighteen
-- reads and no index is built at load.
-- @param blob the chunk's payload
-- @param node the header entry describing the column, whose values ascend
-- @param value the number looked for
-- @return the row counted from zero, or nil where the column lacks it
function Reader.rowOf(blob, node, value)
	local low, high = 0, node.n - 1
	while low <= high do
		local middle = floor((low + high) / 2)
		local found = Reader.number(blob, node, middle)
		if found == value then
			return middle
		elseif found < value then
			low = middle + 1
		else
			high = middle - 1
		end
	end
	return nil
end

--- The last row of a sorted whole-number column at or below a value.
-- What finds the row an offset falls in, given the column of row starts.
-- @param blob the chunk's payload
-- @param node the header entry describing the column, whose values ascend
-- @param value the number looked for
-- @return the row counted from zero, or nil where every value is above it
function Reader.rowAtMost(blob, node, value)
	local low, high = 0, node.n - 1
	if high < 0 or Reader.number(blob, node, 0) > value then
		return nil
	end
	while low < high do
		local middle = floor((low + high + 1) / 2)
		if Reader.number(blob, node, middle) <= value then
			low = middle
		else
			high = middle - 1
		end
	end
	return low
end

return Reader

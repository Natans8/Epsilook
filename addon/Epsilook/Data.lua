--- Reaching the payload: which axes are loaded, and where a column sits.
--
-- The layer between the emitted files and everything that asks a question of
-- them. It knows how a pack is laid out and nothing about what is being asked,
-- which is what lets the API above it stay about spells rather than about
-- offsets.
--
-- Two things it deliberately does not do. It never materialises a column --
-- callers are handed a node and read the row they want -- and it never
-- performs an action. Both belong to whoever is displaying the answer.
--
-- The client seam lives here. A column the payload does not carry may still be
-- answerable by the running game, and `index.supplied` says which call answers
-- it. That lookup is invisible above this file: a caller asks for a column and
-- either gets one or does not.

local _, ns = ...

local Data = {}
if ns then
	ns.Data = Data
end

_G.Epsilook = _G.Epsilook or {}
_G.Epsilook.Data = Data

local Reader = (ns and ns.Reader) or _G.Epsilook.Reader

local floor = math.floor

--- How many spells one checkpoint covers when finding a row's place in a pool.
-- The pack ships a count per spell rather than a running offset, because a
-- rising six-digit number is what a compressed artifact cannot afford. Walking
-- those counts from the start would be a quarter of a million steps per
-- lookup, so the walk happens once per axis and every 'th total is kept. A
-- lookup is then one index plus at most this many steps.
local STRIDE = 1024

--- Where the emitted axes land.
-- @return the table of loaded axes, keyed by axis name
local function payload()
	return _G.Epsilook.data
end

--- Whether the payload has been loaded.
function Data.IsLoaded()
	return payload() ~= nil and _G.Epsilook.index ~= nil
end

--- What the payload says about itself.
-- @param target an optional table to fill instead of allocating one
-- @return pack, built, variation, supplied, absent
function Data.GetInfo(target)
	local index = _G.Epsilook.index
	if not index then
		return nil
	end
	local out = target or {}
	out.pack, out.built = index.pack, index.built
	out.variation, out.supplied, out.absent = index.variation, index.supplied, index.absent
	return out
end

--- Which axes this payload carries, in the order a dossier shows them.
function Data.GetAxes()
	local index = _G.Epsilook.index
	return index and index.axes or {}
end

--- One axis's chunk, loading it if the client has not yet.
-- @param axis the axis name
-- @return the chunk table, or nil where this build carries no such axis
function Data.GetAxis(axis)
	local held = payload()
	if held and held[axis] then
		return held[axis]
	end
	-- Load on demand, and only once: the whole payload is one addon, so the
	-- first axis anybody asks for brings the rest with it.
	local load = _G.LoadAddOn
	if load then
		load("Epsilook_Data")
	end
	held = payload()
	return held and held[axis] or nil
end

--- One column's header node and the blob it sits in.
-- @param axis which axis file carries the section
-- @param section the section name
-- @param column the column name
-- @return the node and the blob, or nil where the payload lacks it
function Data.GetColumn(axis, section, column)
	local chunk = Data.GetAxis(axis)
	if not chunk then
		return nil
	end
	local held = chunk.sections[section]
	if not held then
		return nil
	end
	local node = held.columns[column]
	if not node then
		return nil
	end
	return node, chunk.blob
end

--- Which client call answers a column the payload leaves out, if any.
-- @param section the section name
-- @param column the column name
-- @return the call's name, or nil
function Data.GetSupplier(section, column)
	local index = _G.Epsilook.index
	local supplied = index and index.supplied
	if not supplied then
		return nil
	end
	return supplied[section .. "." .. column] or supplied[section]
end

--- The axes carrying a row family, which is what makes one inspectable.
-- Read off the payload rather than listed, so an axis that stops shipping
-- rows stops being offered without an edit here.
function Data.GetPartAxes()
	local out = {}
	for _, axis in ipairs(Data.GetAxes()) do
		local chunk = Data.GetAxis(axis)
		if chunk and chunk.sections[axis .. "Rows"] then
			out[#out + 1] = axis
		end
	end
	return out
end

--- How many spells this build carries.
function Data.GetNumSpells()
	local node = Data.GetColumn("spell", "spells", "ids")
	return node and Reader.size(node) or 0
end

--- The row a spell id sits at.
-- The ids ascend, so this is a binary search rather than a scan and needs no
-- index built at load: eighteen reads against a quarter of a million rows.
-- @param spellID the spell id
-- @return the row, counted from zero, or nil
function Data.GetSpellIndexByID(spellID)
	local node, blob = Data.GetColumn("spell", "spells", "ids")
	if not node then
		return nil
	end
	local low, high = 0, Reader.size(node) - 1
	while low <= high do
		local middle = floor((low + high) / 2)
		local found = Reader.number(blob, node, middle)
		if found == spellID then
			return middle
		elseif found < spellID then
			low = middle + 1
		else
			high = middle - 1
		end
	end
	return nil
end

--- Checkpoints into one axis's row pool, built once and kept.
local places = {}

--- Where a spell's rows begin in an axis's pool, and how many there are.
-- @param axis the axis
-- @param row the spell's row
-- @return the first pooled row and the count, or nil where the axis is absent
function Data.GetRowRange(axis, row)
	local counts, blob = Data.GetColumn(axis, axis .. "Rows", "counts")
	if not counts then
		return nil
	end
	local marks = places[axis]
	if not marks then
		marks = {}
		local running = 0
		for at = 0, Reader.size(counts) - 1 do
			if at % STRIDE == 0 then
				marks[floor(at / STRIDE)] = running
			end
			running = running + Reader.number(blob, counts, at)
		end
		places[axis] = marks
	end
	local mark = floor(row / STRIDE)
	local at = marks[mark] or 0
	for step = mark * STRIDE, row - 1 do
		at = at + Reader.number(blob, counts, step)
	end
	return at, Reader.number(blob, counts, row)
end

--- How many rows of one axis a spell has.
-- @param axis the axis
-- @param row the spell's row
-- @return a count, zero where the spell has none and the axis is present
function Data.GetNumRows(axis, row)
	local counts, blob = Data.GetColumn(axis, axis .. "Rows", "counts")
	if not counts then
		return 0
	end
	return Reader.number(blob, counts, row)
end

--- Forget every checkpoint, so a reloaded payload is not read through stale
-- offsets. Called when the payload changes, which today is only ever a reload.
function Data.Reset()
	places = {}
end

return Data

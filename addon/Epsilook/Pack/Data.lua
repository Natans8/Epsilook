--- The mount: where the pack's columns are, and how a row is found in them.
--
-- The layer between the emitted files and everything that asks a question of
-- them. It knows how a pack is laid out and nothing about what is being asked,
-- which is what lets the layers above it stay about spells and queries rather
-- than about offsets.
--
-- A column is read through an ordered list of HOMES. The shipped data is one
-- home: a load-on-demand addon whose files the client turns into tables. A
-- pack compiled from the running client would be a second, holding the same
-- header-plus-blob shape in a saved variable, and adding it is one entry in
-- `Data.HOMES`. Nothing above this file learns which home answered.
--
-- Locating a column walks the homes, so a caller on a hot path locates once
-- and reads many times: the row table, the vocabularies and the small columns
-- are each read once per mount and kept, and `Data.Reset` forgets them all.
--
-- Two things it deliberately does not do. It never materialises a
-- spell-sized column -- callers are handed a node and read the row they want
-- -- and it never performs an action. Both belong to whoever is displaying
-- the answer.

_G.Epsilook = _G.Epsilook or {}
local Epsilook = _G.Epsilook

local Data = {}
Epsilook.Data = Data

local Reader = Epsilook.Reader

local floor = math.floor

--- The layout this reader is written against. A payload written in another
-- is refused at load rather than misread.
Data.FORMAT = 2

--- The addon holding the shipped data, loaded on first use.
Data.DATA_ADDON = "Epsilook_Data"

--- How many spells one checkpoint covers when finding a row's place in a pool.
-- The pack ships a count per spell rather than a running offset, because a
-- rising six-digit number is what a compressed artifact cannot afford. Walking
-- those counts from the start would be a quarter of a million steps per
-- lookup, so every 'th total is kept, built as far as lookups have reached.
-- A lookup is then one index plus at most this many steps.
local STRIDE = 1024

--- Where the emitted axes land, and what the pack says about itself.
local function shipped()
	return Epsilook.data
end

--- The homes a column may live in, first answer wins.
-- Each is a name and a function returning its table of axes, or nil while it
-- is not loaded. The shipped data is the only one today; a pack compiled in
-- game would be appended here and nothing else changes.
Data.HOMES = {
	{ name = "shipped", axes = shipped },
}

--- One section of one axis, from the first home holding it.
-- @return the section's entry and the blob it sits in, or nil
local function held(axis, section)
	for _, home in ipairs(Data.HOMES) do
		local axes = home.axes()
		local chunk = axes and axes[axis]
		local entry = chunk and chunk.sections[section]
		if entry then
			return entry, chunk.blob
		end
	end
	return nil
end

--- Whether the payload is loaded and can be asked anything.
function Data.IsLoaded()
	return shipped() ~= nil and Epsilook.index ~= nil and Epsilook.schema ~= nil
end

--- Load the shipped data addon, once.
-- @return true, or false and a reason in the client's own words
function Data.Load()
	if Data.IsLoaded() then
		return true
	end
	local load = _G.LoadAddOn or (_G.C_AddOns and _G.C_AddOns.LoadAddOn)
	if not load then
		return false, "no addon loader"
	end
	local ok, reason = load(Data.DATA_ADDON)
	if not ok then
		return false, tostring(reason)
	end
	local index = Epsilook.index
	if not index or index.format ~= Data.FORMAT then
		return false,
			"data format " .. tostring(index and index.format) .. ", reader expects " .. Data.FORMAT
	end
	-- The pieces each blob was joined from and the parser's own constants are
	-- garbage the moment the files finish loading; without a collect the addon
	-- sits at twice its real size until the client gets round to one.
	collectgarbage("collect")
	Data.Reset()
	return Data.IsLoaded()
end

--- What the payload says about itself.
-- @param target an optional table to fill instead of allocating one
-- @return a table with pack, built, format, variation, homes, or nil before loading
function Data.GetInfo(target)
	local index = Epsilook.index
	if not index then
		return nil
	end
	local out = target or {}
	out.pack, out.built, out.format = index.pack, index.built, index.format
	out.variation, out.supplied, out.absent = index.variation, index.supplied, index.absent
	out.homes = {}
	for i, home in ipairs(Data.HOMES) do
		out.homes[i] = home.name
	end
	return out
end

--- The query language's declarations, as the data addon carries them.
function Data.GetSchema()
	return Epsilook.schema
end

--- Which axes this payload carries, in the order they ship.
function Data.GetAxes()
	local index = Epsilook.index
	return index and index.axes or {}
end

--- One column's header node and the blob it sits in.
-- Homes are asked in order and the first holding the column answers, so a
-- compiled home can carry some columns of an axis while the shipped one
-- carries the rest.
-- @param axis which axis file carries the section
-- @param section the section name
-- @param column the column name
-- @return the node and the blob, or nil where no home has it
function Data.GetColumn(axis, section, column)
	local entry, blob = held(axis, section)
	local node = entry and entry.columns[column]
	if node then
		return node, blob
	end
	return nil
end

--- The column names of one section, in no particular order.
-- @return a list of names, empty where no home has the section
function Data.GetColumnNames(axis, section)
	local entry = held(axis, section)
	local out = {}
	for name in pairs(entry and entry.columns or {}) do
		out[#out + 1] = name
	end
	table.sort(out)
	return out
end

--- Small columns read whole, kept by axis, section and column.
local read = {}

--- Every row of a small column, as a table, read once and kept.
-- For vocabularies and declarations, never for a spell-sized column.
-- @return the table, or nil where no home has the column
function Data.ReadAll(axis, section, column)
	local key = axis .. "." .. section .. "." .. column
	local out = read[key]
	if out == nil then
		local node, blob = Data.GetColumn(axis, section, column)
		out = node and Reader.all(blob, node) or false
		read[key] = out
	end
	return out or nil
end

--- The axes carrying a row family, found once.
local partAxes

--- The axes carrying a row family, which is what makes one inspectable.
-- Read off the payload rather than listed, so an axis that stops shipping
-- rows stops being offered without an edit here.
function Data.GetPartAxes()
	if not partAxes then
		partAxes = {}
		for _, axis in ipairs(Data.GetAxes()) do
			if held(axis, axis .. "Rows") then
				partAxes[#partAxes + 1] = axis
			end
		end
	end
	return partAxes
end

--- How many spells this build carries.
function Data.GetNumSpells()
	local node = Data.GetColumn("spell", "spells", "ids")
	return node and Reader.size(node) or 0
end

--- The row a spell id sits at.
-- @param spellID the spell id
-- @return the row, counted from zero, or nil
function Data.GetSpellIndexByID(spellID)
	local node, blob = Data.GetColumn("spell", "spells", "ids")
	return node and Reader.rowOf(blob, node, spellID) or nil
end

--- The row of the icon pool a spell's icon sits at.
-- The spell carries an index into the pool counted from one, so that nought
-- can mean the spell has no icon at all; read as though it were counted from
-- zero it is off by one, and a wrong icon is not a thing anybody notices by
-- looking. This is the one place the rule is applied.
-- @param row the spell's row
-- @return the icon's row counted from zero, or nil where the spell has none
function Data.GetIconRow(row)
	local node, blob = Data.GetColumn("spell", "spells", "icons")
	local icon = node and Reader.number(blob, node, row) or 0
	return icon > 0 and icon - 1 or nil
end

--- The small part of one axis's row table, read once and kept.
local pools = {}

--- One axis's row table: its kinds, where each kind's pool begins, and the
-- columns every read of a row starts from.
-- The pack numbers a column's rows across the whole column, with the pools
-- laid end to end in kind order, so one reference names both the kind and the
-- row within it. `first[k]` is the reference the k'th kind's pool starts at,
-- and `first[#kinds + 1]` is one past the last. `marks` are the checkpoints
-- into the counts, built on the first row range asked for.
-- @param axis the axis
-- @return a table with kinds, first, values, carried, vocab, absent, blob,
--   counts, countsBlob, refs, refsBlob; or nil where the axis has no row table
function Data.GetRowTable(axis)
	local table_ = pools[axis]
	if table_ ~= nil then
		return table_ or nil
	end
	local section = axis .. "Rows"
	local kindsNode, blob = Data.GetColumn(axis, section, "kinds")
	if not kindsNode then
		pools[axis] = false
		return nil
	end
	local kinds = Reader.all(blob, kindsNode)
	local sizes = Data.ReadAll(axis, section, "sizes")
	local first = { 0 }
	for k = 1, #kinds do
		first[k + 1] = first[k] + sizes[k]
	end
	local counts, countsBlob = Data.GetColumn(axis, section, "counts")
	local refs, refsBlob = Data.GetColumn(axis, section, "refs")
	table_ = {
		kinds = kinds,
		first = first,
		values = Data.GetColumn(axis, section, "values"),
		carried = Data.GetColumn(axis, section, "carried"),
		vocab = Data.ReadAll(axis, section, "vocab") or {},
		absent = Data.ReadAll(axis, section, "absent") or {},
		blob = blob,
		counts = counts,
		countsBlob = countsBlob,
		refs = refs,
		refsBlob = refsBlob,
	}
	pools[axis] = table_
	return table_
end

--- Where a spell's rows begin in an axis's reference list, and how many there are.
-- @param axis the axis
-- @param row the spell's row
-- @return the first reference index and the count, or nil where the axis is absent
function Data.GetRowRange(axis, row)
	local table_ = Data.GetRowTable(axis)
	if not table_ then
		return nil
	end
	local counts, blob = table_.counts, table_.countsBlob
	local marks = table_.marks
	if not marks then
		marks = { [0] = 0 }
		table_.marks = marks
		-- The marks are built as far as a lookup needs and no further, so the
		-- first walk of a session pays for them as it goes rather than all at
		-- once before its first row.
		table_.markedTo = 0
		table_.markedSum = 0
	end
	local mark = floor(row / STRIDE)
	local limit = Reader.size(counts)
	while table_.markedTo < mark and table_.markedTo * STRIDE < limit do
		local sum = table_.markedSum
		local from = table_.markedTo * STRIDE
		for at = from, from + STRIDE - 1 do
			if at >= limit then
				break
			end
			sum = sum + Reader.number(blob, counts, at)
		end
		table_.markedTo = table_.markedTo + 1
		table_.markedSum = sum
		marks[table_.markedTo] = sum
	end
	local at = marks[mark] or 0
	for step = mark * STRIDE, row - 1 do
		at = at + Reader.number(blob, counts, step)
	end
	return at, Reader.number(blob, counts, row)
end

--- How many rows of one axis a spell has.
-- @param axis the axis
-- @param row the spell's row
-- @return a count, zero where the spell has none or the axis is absent
function Data.GetNumRows(axis, row)
	local table_ = Data.GetRowTable(axis)
	if not table_ then
		return 0
	end
	return Reader.number(table_.countsBlob, table_.counts, row)
end

--- Which kind a pooled row is, and its slot in that kind's pool.
-- @param axis the axis
-- @param ref a column-wide row reference
-- @return the kind's word and the slot counted from zero, or nil
function Data.LocateRow(axis, ref)
	local table_ = Data.GetRowTable(axis)
	if not table_ then
		return nil
	end
	local first = table_.first
	-- A handful of kinds per axis, so a walk beats a search.
	for k = 1, #table_.kinds do
		if ref < first[k + 1] then
			return table_.kinds[k], ref - first[k]
		end
	end
	return nil
end

--- Where one property of one kind is stored: the column, its blob, and the
-- number meaning the row has no value. What a hot path locates once and then
-- reads with `Reader.value` per slot.
-- @param axis the axis
-- @param kind the kind's word
-- @param prop the property name
-- @return node, blob, absent; or nil where the kind lacks the property
function Data.GetStoredColumn(axis, kind, prop)
	local table_ = Data.GetRowTable(axis)
	if not table_ then
		return nil
	end
	local group = table_.values.columns[kind]
	local node = group and group.columns[prop]
	if not node then
		return nil
	end
	local absent = table_.absent[kind]
	return node, table_.blob, (absent and absent[prop]) or 0
end

--- One property's stored number on one pooled row.
-- @param axis the axis
-- @param kind the kind's word
-- @param slot the row's slot in that kind's pool
-- @param prop the property name
-- @return the number, or nil where the kind lacks the property or the row has no value for it
function Data.GetStored(axis, kind, slot, prop)
	local node, blob, absent = Data.GetStoredColumn(axis, kind, prop)
	if not node then
		return nil
	end
	-- A handful of columns carry a float and spell it as text; the rest are numbers.
	local value = Reader.value(blob, node, slot)
	if value == absent then
		return nil
	end
	return value
end

--- A carried column's stored number on one pooled row. A carried column is
-- one a row has beyond the properties its kind declares -- what the shipped
-- app rebuilds a section from -- and the pack writes it beside the values.
-- @param axis the axis
-- @param kind the kind's word
-- @param slot the row's slot in that kind's pool
-- @param name the column's name
-- @return the number, or nil where the kind carries no such column
function Data.GetCarried(axis, kind, slot, name)
	local table_ = Data.GetRowTable(axis)
	-- An axis whose rows carry nothing beyond their properties has no such
	-- column at all, and a kind that carries nothing has no group.
	local carried = table_ and table_.carried
	local groups = carried and carried.columns
	local group = groups and groups[kind]
	local node = group and group.columns and group.columns[name]
	if not node then
		return nil
	end
	return Reader.value(table_.blob, node, slot)
end

--- The vocabulary a property's stored number is keyed by, if any.
-- @return the vocabulary's name, or nil where the number is the value
function Data.GetVocabName(axis, kind, prop)
	local table_ = Data.GetRowTable(axis)
	local vocab = table_ and table_.vocab[kind]
	return vocab and vocab[prop] or nil
end

--- The axis a section lands in, by section, found by asking each axis.
local axisOfSection = {}

--- Which axis file carries a section.
-- @return the axis name, or nil where no home has the section
function Data.GetAxisOf(section)
	local known = axisOfSection[section]
	if known ~= nil then
		return known or nil
	end
	for _, axis in ipairs(Data.GetAxes()) do
		if held(axis, section) then
			axisOfSection[section] = axis
			return axis
		end
	end
	axisOfSection[section] = false
	return nil
end

--- One vocabulary located: its text column, that column's blob, and where
-- paired, its key column; kept by name.
local located = {}

--- One vocabulary's columns, located through the pack's declaration.
-- A vocabulary is one of three shapes, and this reads which: two parallel
-- columns paired by key; one named column indexed by the stored number; or a
-- bare section that is itself indexed by it, which ships as a map whose text
-- keys spell the number.
-- @param name the vocabulary
-- @return a table with values, blob, and keys plus textKeys where paired; or nil
function Data.LocateVocab(name)
	local found = located[name]
	if found ~= nil then
		return found or nil
	end
	local where = (Data.ReadAll("misc", "rowVocabs", "vocabs") or {})[name]
	local axis = where and Data.GetAxisOf(where["in"])
	local entry, blob
	if axis then
		entry, blob = held(axis, where["in"])
	end
	local values = entry and entry.columns[where.values or next(entry.columns)]
	if not values then
		located[name] = false
		return nil
	end
	found = { values = values, blob = blob }
	if where.keys then
		found.keys = entry.columns[where.keys]
	elseif values.kind == "map" then
		found.keys, found.values, found.textKeys = values.keys, values.values, true
	end
	located[name] = found
	return found
end

--- The stored number one row of a vocabulary is keyed by.
-- @param name the vocabulary
-- @param row the row counted from zero
-- @return the key, which is the row itself for a vocabulary indexed directly
function Data.VocabKeyAt(name, row)
	local found = Data.LocateVocab(name)
	if not found or not found.keys then
		return row
	end
	if found.textKeys then
		return tonumber(Reader.text(found.blob, found.keys, row))
	end
	return Reader.number(found.blob, found.keys, row)
end

--- Lookups from a stored number to a row of a paired vocabulary, built on
-- first use per vocabulary: a handful of small tables, never a spell-sized one.
local paired = {}

--- What a stored number means in its vocabulary.
-- @param name the vocabulary
-- @param stored the number a row carries
-- @return the text, or the number the vocabulary resolves it to, or nil
function Data.ResolveVocab(name, stored)
	local found = Data.LocateVocab(name)
	if not found then
		return nil
	end
	local row = stored
	if found.keys then
		local map = paired[name]
		if not map then
			map = {}
			for at = 0, Reader.size(found.keys) - 1 do
				map[Data.VocabKeyAt(name, at)] = at
			end
			paired[name] = map
		end
		row = map[stored]
	elseif stored < 0 or stored >= Reader.size(found.values) then
		row = nil
	end
	if row == nil then
		return nil
	end
	return Reader.value(found.blob, found.values, row)
end

--- Lookups over two parallel columns of a section, built on first use.
local lookups = {}

--- The value beside a key in two parallel columns of one section.
-- For the pairs the pack ships beside a vocabulary rather than as one: the
-- gameobject id beside a file id, say. The pairing is built once per pair and
-- kept, so it is for small sections only.
-- @param axis which axis file carries the section
-- @param section the section name
-- @param keyColumn the column holding the keys
-- @param valueColumn the column holding the values
-- @param key the key
-- @return the value, or nil where the key is absent or the columns are
function Data.Lookup(axis, section, keyColumn, valueColumn, key)
	local name = axis .. "." .. section .. "." .. keyColumn .. "." .. valueColumn
	local map = lookups[name]
	if not map then
		map = {}
		local keys, blob = Data.GetColumn(axis, section, keyColumn)
		local values = Data.GetColumn(axis, section, valueColumn)
		if keys and values then
			for row = 0, Reader.size(keys) - 1 do
				map[Reader.value(blob, keys, row)] = Reader.value(blob, values, row)
			end
		end
		lookups[name] = map
	end
	return map[key]
end

--- The rows of a section grouped by one column's value, built on first use.
local groups = {}

--- The rows of a section whose key column holds a key, in section order.
-- For the sections that carry several rows per key: a creature's displays,
-- a display's skins. The grouping is built once per key column and kept,
-- so it is for small sections only.
-- @param axis which axis file carries the section
-- @param section the section name
-- @param keyColumn the column holding the keys
-- @param key the key
-- @return a list of row numbers, counted from nought, empty where the key
--   is absent or the column is
function Data.RowsOf(axis, section, keyColumn, key)
	local name = axis .. "." .. section .. "." .. keyColumn
	local map = groups[name]
	if not map then
		map = {}
		local keys, blob = Data.GetColumn(axis, section, keyColumn)
		if keys then
			for row = 0, Reader.size(keys) - 1 do
				local value = Reader.value(blob, keys, row)
				local rows = map[value]
				if not rows then
					rows = {}
					map[value] = rows
				end
				rows[#rows + 1] = row
			end
		end
		groups[name] = map
	end
	return map[key] or {}
end

--- Forget everything read off the payload, so a changed payload is not read
-- through stale offsets. Called when the payload loads.
function Data.Reset()
	read = {}
	partAxes = nil
	pools = {}
	axisOfSection = {}
	located = {}
	paired = {}
	lookups = {}
	groups = {}
end

return Data

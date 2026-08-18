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
-- A section is addressed by NAME and never by the file it landed in. Which
-- file that is belongs to the addon's own arrangement rather than to anything
-- the pack decided, so a section moving between them is a declaration edit in
-- the emitter and no edit at all here.
--
-- The client seam lives here, at the grain a route actually has. A column the
-- payload leaves out may still be answerable by the running game;
-- `GetSupplier` names the call and `GetSupplied` asks it for ONE row, because
-- one row is what a route answers about. So a column is not what comes back
-- from the client, and a caller that wants a value asks for the value rather
-- than for the column it would have been read from.
--
-- TODO: reach the two Epsilon routes. `GetSupplied` composes whatever the
-- supply table names, but what `C_Epsilon.GODI_Get` and `SoundKit_Get` take
-- and give back is unmeasured, so nothing asks them for a value yet. Settling
-- that is a question for the running client rather than one to infer from a
-- name.

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

--- Every cache this file keeps.
-- Held together so that forgetting them is one loop rather than a list that
-- has to be edited whenever a cache is added -- which is the edit that gets
-- missed, and whose failure is a payload read through stale offsets.
local caches = {}

--- One table that `Reset` will empty.
-- @return a fresh table, registered
local function cache()
	local held = {}
	caches[#caches + 1] = held
	return held
end

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

--- The payload, loading it if the client has not yet.
-- Load on demand, and only once: the whole payload is one addon, so the first
-- axis anybody asks for brings the rest with it. That is also what lets a
-- section be found by name below without a table saying where each one landed.
-- @return the table of loaded axes, or nil where the data addon is absent
local function loaded()
	local held = payload()
	if held then
		return held
	end
	local load = _G.LoadAddOn
	if load then
		load("Epsilook_Data")
	end
	return payload()
end

--- One axis's chunk, loading it if the client has not yet.
-- @param axis the axis name
-- @return the chunk table, or nil where this build carries no such axis
function Data.GetAxis(axis)
	local held = loaded()
	return held and held[axis] or nil
end

--- Which axis file carries each section, worked out from the payload itself.
-- Empty until the first question, and empty is how "not yet" is told from
-- "built": a loaded payload always carries sections, so this is only ever
-- empty before anything has been asked.
local where = cache()

--- Which axis file carries a section.
-- A table saying so would be a second account of what the emitter already
-- wrote into every chunk, and building it is one pass over eight lists of
-- names.
-- @param section the section name
-- @return the axis name, or nil where nothing carries it
local function axisOf(section)
	if not next(where) then
		local held = loaded()
		if not held then
			return nil
		end
		for axis, chunk in pairs(held) do
			for name in pairs(chunk.sections) do
				where[name] = axis
			end
		end
	end
	return where[section]
end

--- One section's table and the blob it sits in.
-- @param section the section name
-- @return the section table and the blob, or nil where the payload lacks it
local function sectionOf(section)
	local axis = axisOf(section)
	local chunk = axis and Data.GetAxis(axis)
	local held = chunk and chunk.sections[section]
	if not held then
		return nil
	end
	return held, chunk.blob
end

--- One column's header node and the blob it sits in.
-- @param section the section name
-- @param column the column name
-- @return the node and the blob, or nil where the payload lacks either
function Data.GetColumn(section, column)
	local held, blob = sectionOf(section)
	local node = held and held.columns[column]
	if not node then
		return nil
	end
	return node, blob
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

--- What the running game answers for one row of a column the payload lacks.
-- The other half of the variation, and the reason a caller above this file
-- cannot tell where a value came from. A route answers about one identity at a
-- time, which is why this takes a key rather than handing back a column.
-- @param section the section name
-- @param column the column name
-- @param key the identity the column is keyed by, usually a spell id
-- @return whatever the client answered, or nil where nothing does
function Data.GetSupplied(section, column, key)
	-- Reached when asked rather than captured at the top of this file, because
	-- the client seam loads after it: a local bound at load time would be nil
	-- for the whole session.
	local client = _G.Epsilook.Client
	local route = client and Data.GetSupplier(section, column)
	if not route then
		return nil
	end
	return client.Get(route, key)
end

--- The one column of a section that ships nothing else.
-- A vocabulary naming neither a key nor a value column means the section
-- itself is the lookup, which the pack can only express for a section holding
-- a single column. Raising rather than picking says so where it stops being
-- true, since `pairs` would otherwise choose one at random.
-- @param section the section name
-- @return the column's name, or nil where the payload lacks the section
local function sole(section)
	local held = sectionOf(section)
	if not held then
		return nil
	end
	local only
	for name in pairs(held.columns) do
		if only then
			error(section .. " is read as a lookup but ships more than one column")
		end
		only = name
	end
	return only
end

--- Every lookup built so far, by the shape and columns that describe it.
local lookups = cache()

--- One lookup, built on first use and kept.
-- A build that cannot answer is not remembered as unanswerable, so a lookup
-- asked for before the payload finished loading is not written off for the
-- rest of the session. What it costs is a handful of table reads each time a
-- pack genuinely lacks the section, which four of the Classic packs do.
-- @param key what names this lookup among the others
-- @param make builds it, returning nil where the payload cannot answer
-- @return the lookup, or nil
local function kept(key, make)
	local found = lookups[key]
	if not found then
		found = make()
		lookups[key] = found
	end
	return found
end

--- Which row of an ascending column holds a key, by halving.
-- @param blob the chunk's payload
-- @param node the column's header entry
-- @param key the value to find
-- @param last the column's last row
-- @return the row, or nil where no row holds it
local function searched(blob, node, key, last)
	local low, high = 0, last
	while low <= high do
		local middle = floor((low + high) / 2)
		local found = Reader.number(blob, node, middle)
		if found == key then
			return middle
		elseif found < key then
			low = middle + 1
		else
			high = middle - 1
		end
	end
	return nil
end

--- Which row of a column holds a key, by reading every one.
-- @param blob the chunk's payload
-- @param node the column's header entry
-- @param key the value to find
-- @param last the column's last row
-- @return the row, or nil where no row holds it
local function walked(blob, node, key, last)
	for at = 0, last do
		if Reader.number(blob, node, at) == key then
			return at
		end
	end
	return nil
end

--- A lookup pairing two columns of one section, key to value.
-- Nothing is built, which on this data is the difference between a lookup and
-- a stall. The widest paired vocabulary is every spell in the build -- over
-- four hundred thousand rows on the largest pack -- and pairing it into a
-- table would spend that, and the memory to hold it, the moment somebody asked
-- what one linked spell is called.
--
-- The keys ascend, so a lookup is a halving: eighteen reads whatever the
-- column's length. Measured over every paired vocabulary of all thirteen
-- packs, exactly one column breaks that, and by exactly four rows -- the build
-- appends the equipped-weapon slots to `files.fids` and those are negative. So
-- a search that finds nothing walks the column before answering that the key
-- is absent, because halving a column with a tail like that can step over a
-- key that is really there. The fallback cannot be wrong the other way: a
-- halving only reports a hit on a key it compared equal.
-- @param section the section holding both columns
-- @param keys the column holding the keys
-- @param values the column holding the values
-- @return a function from key to value, or nil where the payload lacks either
function Data.GetPaired(section, keys, values)
	return kept(section .. "/" .. keys .. "/" .. values, function()
		local keyNode, blob = Data.GetColumn(section, keys)
		local valueNode = Data.GetColumn(section, values)
		if not keyNode or not valueNode then
			return nil
		end
		local last = Reader.size(keyNode) - 1
		return function(key)
			local at = searched(blob, keyNode, key, last) or walked(blob, keyNode, key, last)
			if not at then
				return nil
			end
			return Reader.value(blob, valueNode, at)
		end
	end)
end

--- A lookup over a column the key itself indexes.
-- Nothing is built: the key is the row, so a read is a slice of the blob.
-- @param node the column's header entry
-- @param blob the chunk's payload
-- @return a function from key to value
local function byPosition(node, blob)
	return function(key)
		if type(key) ~= "number" or key < 0 or key >= Reader.size(node) then
			return nil
		end
		return Reader.value(blob, node, key)
	end
end

--- A lookup over a mapping the payload ships whole.
-- The other half of the same shape: a vocabulary whose numbers are sparse
-- ships as a mapping rather than as a column, and its keys are those numbers
-- written as text, so they are read back as numbers here. It is the shape the
-- build uses for the small vocabularies -- the widest any pack ships is five
-- hundred entries -- which is what makes reading it whole the cheap option.
-- @param node the column's header entry
-- @param blob the chunk's payload
-- @return a function from key to value
local function byKey(node, blob)
	local held = {}
	for at, value in pairs(Reader.all(blob, node)) do
		held[tonumber(at) or at] = value
	end
	return function(key)
		return held[key]
	end
end

--- A lookup reading one column at the position the key names.
-- @param section the section holding the column
-- @param column the column, or nil for a section that ships exactly one
-- @return a function from key to value, or nil where the payload lacks it
function Data.GetIndexed(section, column)
	return kept(section .. "/" .. (column or ""), function()
		local name = column or sole(section)
		if not name then
			return nil
		end
		local node, blob = Data.GetColumn(section, name)
		if not node then
			return nil
		end
		-- Which of the two the payload chose is the payload's to say, and it
		-- says so in the node: a column has rows, a mapping has keys.
		if node.kind == "map" then
			return byKey(node, blob)
		end
		return byPosition(node, blob)
	end)
end

--- What one vocabulary the pack declares answers.
-- `rowVocabs` says where each lives and how it is keyed, and there are exactly
-- three shapes: two parallel columns, one column the stored number indexes, or
-- a section that IS the lookup and therefore ships a single column.
-- @param name the vocabulary's name, as a row's `vocab` entry spells it
-- @return a function from a stored number to its value, or nil
function Data.GetVocabulary(name)
	return kept("vocab/" .. name, function()
		local node, blob = Data.GetColumn("rowVocabs", "vocabs")
		local entry = node and node.columns and node.columns[name]
		if not entry then
			return nil
		end
		local held = Reader.all(blob, entry)
		local section = held["in"]
		if held.keys and held.values then
			return Data.GetPaired(section, held.keys, held.values)
		end
		return Data.GetIndexed(section, held.values)
	end)
end

--- The axes carrying a row family, which is what makes one inspectable.
-- Read off the payload rather than listed, so an axis that stops shipping
-- rows stops being offered without an edit here.
function Data.GetPartAxes()
	local out = {}
	for _, axis in ipairs(Data.GetAxes()) do
		if axisOf(axis .. "Rows") then
			out[#out + 1] = axis
		end
	end
	return out
end

--- How many spells this build carries.
function Data.GetNumSpells()
	local node = Data.GetColumn("spells", "ids")
	return node and Reader.size(node) or 0
end

--- The row a spell id sits at.
-- The ids ascend, so this is a halving rather than a scan and needs no index
-- built at load: eighteen reads against a quarter of a million rows.
-- @param spellID the spell id
-- @return the row, counted from zero, or nil
function Data.GetSpellIndexByID(spellID)
	local node, blob = Data.GetColumn("spells", "ids")
	if not node then
		return nil
	end
	return searched(blob, node, spellID, Reader.size(node) - 1)
end

--- Checkpoints into one axis's row pool, built once and kept.
local places = cache()

--- Where a spell's rows begin in an axis's pool, and how many there are.
-- @param axis the axis
-- @param row the spell's row
-- @return the first pooled row and the count, or nil where the axis is absent
function Data.GetRowRange(axis, row)
	local counts, blob = Data.GetColumn(axis .. "Rows", "counts")
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
	local counts, blob = Data.GetColumn(axis .. "Rows", "counts")
	if not counts then
		return 0
	end
	return Reader.number(blob, counts, row)
end

--- Where each kind's pool begins in one axis, and how far the pools reach.
-- The pools are laid end to end in the order `kinds` names them, so one number
-- says both which kind a row is and which slot of that kind's pool it sits at.
local pools = cache()

--- One axis's pools, read once off the payload.
-- @param axis the axis
-- @return an array of {kind, base} and the total, or nil where the axis is absent
local function poolsOf(axis)
	local found = pools[axis]
	if found then
		return found, found.total
	end
	local kinds, blob = Data.GetColumn(axis .. "Rows", "kinds")
	local sizes = Data.GetColumn(axis .. "Rows", "sizes")
	if not kinds or not sizes then
		return nil
	end
	found = {}
	local base = 0
	for at = 0, Reader.size(kinds) - 1 do
		found[#found + 1] = { kind = Reader.value(blob, kinds, at), base = base }
		base = base + Reader.number(blob, sizes, at)
	end
	found.total = base
	pools[axis] = found
	return found, base
end

--- Which pooled row one reference names.
-- @param axis the axis
-- @param ref a reference as the `refs` column carries it
-- @return the kind and the slot within its pool, or nil where the reference is
--         outside every pool
function Data.GetRowKind(axis, ref)
	local marks, total = poolsOf(axis)
	if not marks or ref < 0 or ref >= total then
		return nil
	end
	-- Backwards, so the first pool whose base the reference clears is its own.
	-- Seventeen kinds is the widest column any build ships, which is why this
	-- is a walk rather than a search.
	for at = #marks, 1, -1 do
		if ref >= marks[at].base then
			return marks[at].kind, ref - marks[at].base
		end
	end
	return nil
end

--- The reference sitting at one position of an axis's whole row order.
-- @param axis the axis
-- @param at a position, as `GetRowRange` counts them
-- @return the reference, or nil where the axis is absent
function Data.GetRowRef(axis, at)
	local refs, blob = Data.GetColumn(axis .. "Rows", "refs")
	if not refs then
		return nil
	end
	return Reader.number(blob, refs, at)
end

--- One of a row family's per-kind tables, as the payload writes it.
-- A kind carrying nothing at all ships as an empty map rather than as an empty
-- group, so the caller is told apart by whether there are columns to read.
-- @param axis the axis
-- @param family "values", "vocab" or "absent"
-- @param kind the kind's name
-- @return the node and the blob, or nil where the kind holds nothing
local function familyOf(axis, family, kind)
	local node, blob = Data.GetColumn(axis .. "Rows", family)
	local held = node and node.columns and node.columns[kind]
	return held, blob
end

--- What one kind stores, read once and kept.
local kinds = cache()

--- One kind's value columns, the vocabulary each is keyed by, and its absences.
-- The blob comes back too. It is one string per axis, so every family of every
-- kind sits in the same one, and handing it over is what stops each reader
-- resolving a column it was already given.
-- @param axis the axis
-- @param kind the kind's name
-- @return the value node, the vocabulary map, the absence map and the blob
local function kindOf(axis, kind)
	local held = kinds[axis]
	if not held then
		held = {}
		kinds[axis] = held
	end
	local found = held[kind]
	if not found then
		local values, blob = familyOf(axis, "values", kind)
		local vocab = familyOf(axis, "vocab", kind)
		local absent = familyOf(axis, "absent", kind)
		found = {
			values = values,
			blob = blob,
			vocab = vocab and Reader.all(blob, vocab) or {},
			absent = absent and Reader.all(blob, absent) or {},
		}
		held[kind] = found
	end
	return found.values, found.vocab, found.absent, found.blob
end

--- Which vocabulary each of a kind's properties is keyed by.
-- A property absent from this stores its own number and nothing resolves it.
-- @param axis the axis
-- @param kind the kind's name
-- @return a table of property name to vocabulary name
function Data.GetRowVocab(axis, kind)
	local _, vocab = kindOf(axis, kind)
	return vocab
end

--- Every value one pooled row stores, by property name.
-- The numbers as the pack holds them: what a vocabulary makes of one is asked
-- separately, because a caller wanting the id an action takes wants this and a
-- caller wanting a label wants that.
--
-- Read through `value` rather than `number` because a property that carries a
-- fraction anywhere in the build ships as a float column for every row of its
-- kind. Two do -- how much a scale changes a model and how much a speed aura
-- changes a speed -- and the fractions are real rather than rounding: the
-- game's own templates write them.
--
-- A property whose stored number is the one meaning "no value" is left out
-- rather than reported as that number. The sentinel is nought unless the kind
-- names another, which is what lets a real value of nought exist: a link word
-- is an index into a pool, so its first entry is a word and not an absence.
-- @param axis the axis
-- @param kind the kind's name
-- @param slot the row's slot within that kind's pool
-- @param target an optional table to fill instead of allocating one
-- @return a table of property name to stored number
function Data.GetRowValues(axis, kind, slot, target)
	local out = target or {}
	local values, _, absent, blob = kindOf(axis, kind)
	if not values or not values.columns then
		return out
	end
	for name, node in pairs(values.columns) do
		local value = Reader.value(blob, node, slot)
		if value ~= (absent[name] or 0) then
			out[name] = value
		end
	end
	return out
end

--- Forget every cache, so a reloaded payload is not read through stale offsets
-- or a stale pairing. Called when the payload changes, which today is only ever
-- a reload.
function Data.Reset()
	for _, held in ipairs(caches) do
		for key in pairs(held) do
			held[key] = nil
		end
	end
end

return Data

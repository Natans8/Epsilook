--- The kernel: a parsed query in, the spells that satisfy it out, one at a time.
--
-- The interpreter over the query tree. A query is alternation groups of
-- clauses; within a group the clauses conjoin, and a spell is an answer when
-- any group accepts it. A negated clause is the complement of its positive
-- reading, which is why a query of nothing but exclusions starts from every
-- spell. The kernel branches on the tree's structure and the declarations --
-- never on a column's name, a kind's name or a type's name -- so a kind
-- added on the web reaches it through the data. The one place a kind is
-- named is the table of readers for the spell's own rows, which the pack
-- ships as per-spell columns rather than as a row table, and that table is
-- keyed by the kind's identity so that a renamed door does not move it.
--
-- Inside a row scope the terms are again alternation groups of conjunctions,
-- and one row must satisfy a whole conjunction: each term compiles to a slot
-- test per kind and the conjunction is their product on the one slot. A
-- count term is the exception -- it asks about the set of rows the
-- conjunction's row terms leave -- so it is lifted out and tested against
-- that set's size, and a conjunction with no row terms counts every row.
--
-- Nothing is held. `Search.Find` returns an iterator that walks the spells in
-- order and yields each one that passes, so a first page costs what it costs
-- to reach the twentieth hit and a count costs the whole walk; a caller that
-- wants the next page resumes from the index it stopped at. What a clause
-- needs in order to answer quickly -- which rows of a name column hold the
-- word, which file ids spell a path -- is built the first time the clause is
-- asked and kept for the life of that one query.
--
-- A row is never materialised, and nothing is located twice. Compiling a
-- clause locates every column it will read and closes over the nodes; the
-- function that runs per spell then reads the one stored number it needs and
-- nothing else. A vocabulary-backed property is answered by a set of stored
-- numbers computed once from the vocabulary rather than by resolving each
-- row's text.
--
-- Nothing here touches a WoW global.

_G.Epsilook = _G.Epsilook or {}
local Epsilook = _G.Epsilook

local Search = {}
Epsilook.Search = Search

local Data = Epsilook.Data
local Match = Epsilook.Match
local Query = Epsilook.Query
local Reader = Epsilook.Reader
local Schema = Epsilook.Schema

local floor = math.floor

--- The `spellDelivery.flags` bits, as the build writes them.
local DELIVERY_CHANNELLED, DELIVERY_BREAKS_ON_MOVE = 1, 2

--- Which attribute column of `spellAttrs` answers a flag property of the
-- delivery kind. The catalogue names the property and the build names the
-- column, and neither declares the other; the web engine holds the same two
-- pairs, so a third would be a declaration on the property in the web's
-- catalogue, exported, and read here in its place.
local ATTRIBUTE_COLUMNS =
	{ unbreakable = "unbreakablechannel", unhindered = "actionsduringchannel" }

local function never()
	return false
end

--- Whether a flag word's bit is set.
local function hasBit(flags, bit)
	return floor(flags / bit) % 2 == 1
end

--- The per-spell columns, located once per mount.
local spells

local function spellColumns()
	if spells then
		return spells
	end
	local ids, blob = Data.GetColumn("spell", "spells", "ids")
	spells = {
		blob = blob,
		ids = ids,
		names = Data.GetColumn("spell", "spells", "names"),
		subtexts = Data.GetColumn("spell", "spells", "subtexts"),
		eras = Data.GetColumn("spell", "spells", "eras"),
	}
	spells.iconNames, spells.iconBlob = Data.GetColumn("spell", "iconNames", "names")
	spells.iconFids, spells.iconFidBlob = Data.GetColumn("spell", "iconFids", "fids")
	-- Every prose pool the section ships, whatever the build called them.
	local pools = {}
	for _, name in ipairs(Data.GetColumnNames("text", "spellText")) do
		local node, textBlob = Data.GetColumn("text", "spellText", name)
		if node.kind == "dedup" then
			pools[#pools + 1] = { name = name, pool = node.pool, of = node.of, blob = textBlob }
		end
	end
	spells.pools = pools
	local delivery, deliveryBlob = Data.GetColumn("mech", "spellDelivery", "spellIds")
	if delivery then
		spells.delivery = {
			blob = deliveryBlob,
			ids = delivery,
			castMs = Data.GetColumn("mech", "spellDelivery", "castMs"),
			durMs = Data.GetColumn("mech", "spellDelivery", "durMs"),
			flags = Data.GetColumn("mech", "spellDelivery", "flags"),
		}
	end
	local attrs, attrBlob = Data.GetColumn("mech", "spellAttrs", "byFlag")
	spells.attrs = attrs and { columns = attrs.columns, blob = attrBlob } or nil
	spells.expansionKeys = Data.ReadAll("spell", "expansions", "keys") or {}
	return spells
end

--- Forget what was read off the payload. Called when the payload loads.
function Search.Reset()
	spells = nil
end

--- The expansion ladder the pack declares, as rungs for the ordinal type.
-- A rung is named by its short form, and answers to its key and every alias.
function Search.Ladder()
	local keys = Data.ReadAll("spell", "expansions", "keys") or {}
	local shorts = Data.ReadAll("spell", "expansions", "shorts") or {}
	local aliases = Data.ReadAll("spell", "expansions", "aliases") or {}
	local rungs = {}
	for i, key in ipairs(keys) do
		local reads = { key }
		for _, alias in ipairs(aliases[i] or {}) do
			reads[#reads + 1] = alias
		end
		rungs[i] = { word = shorts[i] or key, reads = reads }
	end
	return rungs
end

--- One operand resolved against a property: the type that reads it and the value.
-- A typed operand names its type; a written one is read as a sentinel first,
-- then by the notations in order.
local function resolveOperand(prop, operand, notations)
	if operand.type then
		for _, typeName in ipairs(prop.types) do
			if typeName == operand.type then
				return typeName, operand.value
			end
		end
		return nil
	end
	local value, typeName = Schema.ParseValue(prop, operand.text, notations)
	if value == nil then
		return nil
	end
	return typeName, value
end

--- Whether an operand written as text names a flag property by one of its words.
local function flagWord(prop, expr)
	if prop.types[1] ~= "flag" or not expr.operand or not expr.operand.text then
		return false
	end
	if expr.op ~= "contains" and expr.op ~= "exact" then
		return false
	end
	local test = Match.Test(expr.op, "text", expr.operand)
	for _, word in ipairs(prop.spellings) do
		if test(word) then
			return true
		end
	end
	return false
end

--- The ways an expression reads against one property.
-- Each is the type the operand was read in, the test over a stored value of
-- that type, and -- where the test is a substring or anchored test on text --
-- the operator and operand a column scan can run instead of the test. A row
-- matches when any way passes. Nil where the expression cannot be read on
-- this property at all.
local function plansFor(prop, expr, notations)
	notations = notations or prop.types
	if expr.op == "anyOf" then
		local out = {}
		for _, alt in ipairs(expr.alternatives) do
			for _, plan in ipairs(plansFor(prop, alt, notations) or {}) do
				out[#out + 1] = plan
			end
		end
		return out
	end
	if expr.op == "present" then
		local out = {}
		for _, typeName in ipairs(notations) do
			out[#out + 1] = { type = typeName, test = Match.Test("present", typeName, {}) }
		end
		return out
	end
	if expr.op == "range" then
		local loType, lo = resolveOperand(prop, expr.lo, notations)
		local hiType, hi = resolveOperand(prop, expr.hi, notations)
		if not loType or loType ~= hiType then
			return nil
		end
		return {
			{
				type = loType,
				test = Match.Test("range", loType, { lo = { value = lo }, hi = { value = hi } }),
			},
		}
	end
	local out = {}
	if flagWord(prop, expr) then
		out[#out + 1] = { type = "flag", test = Match.Test("present", "flag", {}) }
	end
	local typeName, value = resolveOperand(prop, expr.operand, notations)
	if typeName then
		local op = expr.op == "contains" and Schema.BareOp(typeName) or expr.op
		if Schema.Accepts(typeName, op) then
			local plan = {
				type = typeName,
				test = Match.Test(op, typeName, { value = value, text = expr.operand.text }),
			}
			if Schema.IsTextual(typeName) and (op == "contains" or op == "exact") then
				plan.op, plan.written = op, Query.OperandText(expr.operand)
			end
			out[#out + 1] = plan
		end
	end
	return out
end

--- A test any of whose parts passing is a pass.
local function anyOf(tests)
	local n = #tests
	if n == 0 then
		return nil
	end
	if n == 1 then
		return tests[1]
	end
	return function(at)
		for i = 1, n do
			if tests[i](at) then
				return true
			end
		end
		return false
	end
end

--- The stored numbers of one vocabulary whose resolved value passes a plan.
-- A text vocabulary is scanned as a column where the plan allows; any other is
-- walked row by row. Cached for the life of a query: a scan is keyed by what
-- it scans for, so the eight kinds of a column that share one file vocabulary
-- scan it once, and a test that cannot be scanned is keyed by itself.
local function vocabHits(cache, vocab, plan)
	local key = plan.op and (vocab .. "\1" .. plan.op .. "\1" .. plan.written) or plan.test
	local hits = cache[key]
	if hits then
		return hits
	end
	hits = {}
	cache[key] = hits
	local found = Data.LocateVocab(vocab)
	if not found then
		return hits
	end
	local node, blob = found.values, found.blob
	local rows
	if plan.op and node.kind == "text" then
		rows = Match.ScanText(blob, node, plan.op, plan.written)
	else
		rows = {}
		for row = 0, Reader.size(node) - 1 do
			if plan.test(Reader.value(blob, node, row)) then
				rows[row] = true
			end
		end
	end
	for row in pairs(rows) do
		hits[Data.VocabKeyAt(vocab, row)] = true
	end
	return hits
end

--- The test for one property on a pooled row, by slot.
-- Everything the read needs is located here, once: the test that runs per
-- slot reads one number and looks it up.
-- @return a function from a slot to true or false, or nil where the
--   expression cannot be read on the property
local function poolPropTest(cache, axis, kind, prop, expr, notations)
	local plans = plansFor(prop, expr, notations)
	if not plans or #plans == 0 then
		return nil
	end
	local node, blob, absent = Data.GetStoredColumn(axis, kind.word, prop.name)
	if not node then
		return nil
	end
	local vocab = Data.GetVocabName(axis, kind.word, prop.name)
	local named = Schema.IsNamed(prop)
	local tests = {}
	for _, plan in ipairs(plans) do
		if vocab == nil or (named and plan.type == "id") then
			-- The stored number is the value: compare it directly.
			tests[#tests + 1] = plan.test
		elseif not named or plan.type == "text" then
			-- The stored number names a vocabulary entry: the entries that
			-- pass are found once, and a row passes when its number is one.
			local hits
			tests[#tests + 1] = function(stored)
				if not hits then
					hits = vocabHits(cache, vocab, plan)
				end
				return hits[stored] == true
			end
		end
	end
	local test = anyOf(tests)
	if not test then
		return nil
	end
	-- A handful of columns carry a float and spell it as text; the rest are
	-- numbers, read by the cheaper call.
	local read = node.kind == "int" and Reader.number or Reader.value
	return function(slot)
		local stored = read(blob, node, slot)
		return stored ~= absent and test(stored)
	end
end

--- A test over a per-spell text column, answered by one scan of the column
-- where the plan allows and by the plan's test per value otherwise. `at` maps
-- a spell to its row in the column; nil where the spell is the row.
local function textual(node, blob, plan, at)
	if not node then
		return nil
	end
	if plan.op then
		local hits
		return function(spell)
			if not hits then
				hits = Match.ScanText(blob, node, plan.op, plan.written)
			end
			local row = spell
			if at then
				row = at(spell)
			end
			return row ~= nil and hits[row] == true
		end
	end
	local test = plan.test
	return function(spell)
		local row = spell
		if at then
			row = at(spell)
		end
		if row == nil then
			return false
		end
		local value = Reader.value(blob, node, row)
		return value ~= "" and test(value)
	end
end

--- A forward-moving lookup of a spell's row in a section keyed by sorted spell
-- ids. The walk asks for spells in ascending order, so the row it wants is at
-- or after the last one found; a spell asked for out of order falls back to
-- the search. One per query, shared by every reader of that section.
local function keyedRows(cache, key, ids, blob)
	local held = cache[key]
	if held then
		return held
	end
	local rows = Reader.size(ids)
	local last, lastRow = -1, 0
	held = function(spellID)
		if spellID < last then
			return Reader.rowOf(blob, ids, spellID)
		end
		last = spellID
		local row = lastRow
		while row < rows do
			local found = Reader.number(blob, ids, row)
			if found >= spellID then
				lastRow = row
				return found == spellID and row or nil
			end
			row = row + 1
		end
		lastRow = rows
		return nil
	end
	cache[key] = held
	return held
end

--- The readers for the kinds the pack carries as per-spell columns rather
-- than as a row table, by kind identity. Each takes the located columns, the
-- property and one plan, and returns a test by spell, or nil where the
-- property has no reading. The pooled kinds need no entry here: their rows
-- are read generically off the row tables.
local SPELL_READERS = {}

SPELL_READERS["spell.name"] = function(cols, _, plan)
	return anyOf({ textual(cols.names, cols.blob, plan), textual(cols.subtexts, cols.blob, plan) })
end

SPELL_READERS["spell.desc"] = function(cols, _, plan)
	local tests = {}
	for _, pool in ipairs(cols.pools) do
		local of, blob = pool.of, pool.blob
		tests[#tests + 1] = textual(pool.pool, blob, plan, function(spell)
			local slot = Reader.number(blob, of, spell)
			return slot > 0 and slot or nil
		end)
	end
	return anyOf(tests)
end

SPELL_READERS["spell.icon"] = function(cols, prop, plan)
	if prop.name == "name" then
		return textual(cols.iconNames, cols.iconBlob, plan, Data.GetIconRow)
	elseif prop.name == "fid" and cols.iconFids then
		local fids, blob, test = cols.iconFids, cols.iconFidBlob, plan.test
		return function(spell)
			local row = Data.GetIconRow(spell)
			return row ~= nil and test(Reader.number(blob, fids, row))
		end
	end
	return nil
end

SPELL_READERS["spell.spell"] = function(cols, prop, plan, cache)
	local delivery = cols.delivery
	if not delivery then
		return nil
	end
	local ids, blob, test = cols.ids, cols.blob, plan.test
	local rowOf = keyedRows(cache, "delivery", delivery.ids, delivery.blob)
	local deliveryBlob = delivery.blob
	local name = prop.name
	if name == "cast" then
		local castMs = delivery.castMs
		return function(spell)
			local at = rowOf(Reader.number(blob, ids, spell))
			if at == nil then
				-- No delivery row is the instant complement: a cast of nought.
				return test(0)
			end
			local cast = Reader.number(deliveryBlob, castMs, at)
			return cast > 0 and test(cast)
		end
	elseif name == "channel" then
		local flags, durMs = delivery.flags, delivery.durMs
		return function(spell)
			local at = rowOf(Reader.number(blob, ids, spell))
			return at ~= nil
				and hasBit(Reader.number(deliveryBlob, flags, at), DELIVERY_CHANNELLED)
				and test(Reader.number(deliveryBlob, durMs, at))
		end
	elseif name == "breaksmove" then
		local flags = delivery.flags
		return function(spell)
			local at = rowOf(Reader.number(blob, ids, spell))
			return at ~= nil
				and hasBit(Reader.number(deliveryBlob, flags, at), DELIVERY_BREAKS_ON_MOVE)
				and test(1)
		end
	end
	local attrs = cols.attrs
	local column = ATTRIBUTE_COLUMNS[name]
	local node = column and attrs and attrs.columns[column]
	if not node then
		return nil
	end
	local held = keyedRows(cache, "attr." .. column, node, attrs.blob)
	return function(spell)
		return held(Reader.number(blob, ids, spell)) ~= nil and test(1)
	end
end

SPELL_READERS["id.id"] = function(cols, _, plan)
	local ids, blob, test = cols.ids, cols.blob, plan.test
	return function(spell)
		return test(Reader.number(blob, ids, spell))
	end
end

SPELL_READERS["id.xpac"] = function(cols, _, plan)
	local eras, blob, keys, test = cols.eras, cols.blob, cols.expansionKeys, plan.test
	return function(spell)
		local era = Reader.number(blob, eras, spell)
		local key = era >= 0 and keys[era + 1] or nil
		return key ~= nil and test(key)
	end
end

--- The test for one property of a kind the pack carries per spell, by spell.
local function spellPropTest(cache, kind, prop, expr, notations)
	local reader = SPELL_READERS[kind.id]
	local plans = reader and plansFor(prop, expr, notations)
	if not plans or #plans == 0 then
		return nil
	end
	local cols = spellColumns()
	local tests = {}
	for _, plan in ipairs(plans) do
		tests[#tests + 1] = reader(cols, prop, plan, cache)
	end
	return anyOf(tests)
end

--- The test for one property of one kind, by slot for a pooled kind and by
-- spell for a kind read per spell.
local function propTest(cache, kind, prop, expr, notations, virtual)
	if virtual then
		return spellPropTest(cache, kind, prop, expr, notations)
	end
	return poolPropTest(cache, kind.column, kind, prop, expr, notations)
end

--- The property tests of one kind for a content term: every property, each
-- reading the term by its own bare reading; only the plain ones for plain search.
local function contentTest(cache, kind, expr, plainOnly, virtual)
	local tests = {}
	for _, prop in ipairs(kind.props) do
		local notations = plainOnly and prop.plain or nil
		if not plainOnly or #notations > 0 then
			tests[#tests + 1] = propTest(cache, kind, prop, expr, notations, virtual)
		end
	end
	return anyOf(tests)
end

--- The rows of one spell on one axis, as a range into the reference list.
local function rowRange(axis, table_, spell, cursor)
	local at = cursor and cursor.at[axis]
	if at then
		return at, Reader.number(table_.countsBlob, table_.counts, spell)
	end
	return Data.GetRowRange(axis, spell)
end

--- Whether any row of a spell on an axis passes a kind-and-slot test.
-- @param kindFilter a kind word, or nil for every kind
-- @param rowTests tests by kind word, each taking a slot; nil means existence
local function anyRow(axis, table_, spell, cursor, kindFilter, rowTests)
	local at, count = rowRange(axis, table_, spell, cursor)
	if not at or count == 0 then
		return false
	end
	local refs, blob = table_.refs, table_.refsBlob
	local kinds, first, n = table_.kinds, table_.first, #table_.kinds
	for i = at, at + count - 1 do
		local ref = Reader.number(blob, refs, i)
		for k = 1, n do
			if ref < first[k + 1] then
				local kind = kinds[k]
				if kindFilter == nil or kind == kindFilter then
					if rowTests == nil then
						return true
					end
					local test = rowTests[kind]
					if test and test(ref - first[k]) then
						return true
					end
				end
				break
			end
		end
	end
	return false
end

--- How many rows of a spell on an axis are of one kind.
local function countKind(axis, table_, spell, cursor, kindWord)
	local at, count = rowRange(axis, table_, spell, cursor)
	if not at then
		return 0
	end
	local refs, blob = table_.refs, table_.refsBlob
	local kinds, first = table_.kinds, table_.first
	local found = 0
	for i = at, at + count - 1 do
		local ref = Reader.number(blob, refs, i)
		for k = 1, #kinds do
			if ref < first[k + 1] then
				if kinds[k] == kindWord then
					found = found + 1
				end
				break
			end
		end
	end
	return found
end

--- How many rows of a spell on an axis pass a kind-and-slot test.
-- @param kindFilter a kind word, or nil for every kind
-- @param rowTests tests by kind word, each taking a slot
local function countRows(axis, table_, spell, cursor, kindFilter, rowTests)
	local at, count = rowRange(axis, table_, spell, cursor)
	if not at then
		return 0
	end
	local refs, blob = table_.refs, table_.refsBlob
	local kinds, first, n = table_.kinds, table_.first, #table_.kinds
	local found = 0
	for i = at, at + count - 1 do
		local ref = Reader.number(blob, refs, i)
		for k = 1, n do
			if ref < first[k + 1] then
				local kind = kinds[k]
				if kindFilter == nil or kind == kindFilter then
					local test = rowTests[kind]
					if test and test(ref - first[k]) then
						found = found + 1
					end
				end
				break
			end
		end
	end
	return found
end

--- A count test on a number of rows.
local function countTest(expr)
	local plans = plansFor(Schema.COUNT_PROP, expr)
	if not plans or #plans == 0 then
		return nil
	end
	local tests = {}
	for i, plan in ipairs(plans) do
		tests[i] = plan.test
	end
	return anyOf(tests)
end

--- A predicate over a spell from tests by kind word, any of which passing passes.
local function anyKind(byKind)
	local tests = {}
	for _, test in pairs(byKind) do
		tests[#tests + 1] = test
	end
	return anyOf(tests) or never
end

--- A scope term's slot test on one kind, or nil where no row of the kind can
-- satisfy it: a kind word is the kind itself, content is the union over the
-- kind's properties, and a property term is the union over the kind's own
-- references.
local function termTest(cache, kind, ask, virtual)
	if ask.on == "kindWord" then
		if ask.kind == kind then
			return function()
				return true
			end
		end
		return nil
	elseif ask.on == "content" then
		return contentTest(cache, kind, ask.value, false, virtual)
	end
	local tests = {}
	for _, ref in ipairs(ask.props) do
		if ref.kind == kind then
			tests[#tests + 1] = propTest(cache, kind, ref.prop, ask.value, nil, virtual)
		end
	end
	return anyOf(tests)
end

--- One scope conjunction compiled for one kind: the product of its row
-- terms on one slot, a negated term negating per row. A term no row of the
-- kind can satisfy is false there, which a negation makes true, as it is on
-- the web.
local function conjunctionTest(cache, kind, rowTerms, virtual)
	local tests, n = {}, #rowTerms
	for i, term in ipairs(rowTerms) do
		tests[i] =
			{ test = termTest(cache, kind, term.ask, virtual) or never, negated = term["not"] }
	end
	return function(slot)
		for i = 1, n do
			local entry = tests[i]
			if entry.test(slot) == entry.negated then
				return false
			end
		end
		return true
	end
end

--- A scope's terms compiled into a spell predicate over a column's rows: any
-- conjunction holding of one row, its count terms of the rows that hold.
local function compileScope(cache, column, kinds, kindFilter, table_, virtual, runs)
	local filter = kindFilter and kindFilter.word or nil
	local alternatives = {}
	for _, run in ipairs(runs) do
		local rowTerms, countTests = {}, {}
		for _, term in ipairs(run) do
			if term.state == "ok" and term.ask then
				if term.ask.on == "count" then
					local counting = countTest(term.ask.value)
					if counting then
						countTests[#countTests + 1] = { test = counting, negated = term["not"] }
					end
				else
					rowTerms[#rowTerms + 1] = term
				end
			end
		end
		local byKind = {}
		for _, kind in ipairs(kinds) do
			byKind[kind.word] = conjunctionTest(cache, kind, rowTerms, virtual)
		end
		if virtual then
			-- A column read per spell has one reading per kind; a count of
			-- them is not a question it answers.
			if #countTests == 0 then
				alternatives[#alternatives + 1] = anyKind(byKind)
			end
		elseif #countTests == 0 then
			alternatives[#alternatives + 1] = function(spell, cursor)
				return anyRow(column, table_, spell, cursor, filter, byKind)
			end
		else
			local m = #countTests
			alternatives[#alternatives + 1] = function(spell, cursor)
				local size = countRows(column, table_, spell, cursor, filter, byKind)
				for i = 1, m do
					local entry = countTests[i]
					if entry.test(size) == entry.negated then
						return false
					end
				end
				return true
			end
		end
	end
	return anyOf(alternatives) or never
end

--- One clause's ask compiled into a spell predicate.
-- The compiled function takes the spell's row and the walk's cursor and says
-- whether the spell satisfies the ask's positive reading.
local function compileAsk(cache, ask)
	if ask.on == "plain" then
		-- Chipless search: the union over every column's rows of the
		-- properties declaring themselves plain.
		local virtualTests, pooled = {}, {}
		for _, column in ipairs(Schema.columns) do
			local table_ = Data.GetRowTable(column.key)
			local byKind, any = {}, false
			for _, kind in ipairs(Schema.KindsOf(column.key)) do
				local test = contentTest(cache, kind, ask.value, true, table_ == nil)
				if test then
					byKind[kind.word] = test
					any = true
				end
			end
			if any and table_ == nil then
				virtualTests[#virtualTests + 1] = anyKind(byKind)
			elseif any then
				pooled[#pooled + 1] = { axis = column.key, table_ = table_, byKind = byKind }
			end
		end
		local virtualTest = anyOf(virtualTests) or never
		local n = #pooled
		return function(spell, cursor)
			if virtualTest(spell) then
				return true
			end
			for i = 1, n do
				local entry = pooled[i]
				if anyRow(entry.axis, entry.table_, spell, cursor, nil, entry.byKind) then
					return true
				end
			end
			return false
		end
	end

	if ask.on == "prop" then
		local kind, prop = ask.ref.kind, ask.ref.prop
		local table_ = Data.GetRowTable(kind.column)
		local test = propTest(cache, kind, prop, ask.value, nil, table_ == nil)
		if not test then
			return never
		end
		if table_ == nil then
			return test
		end
		local byKind = { [kind.word] = test }
		return function(spell, cursor)
			return anyRow(kind.column, table_, spell, cursor, kind.word, byKind)
		end
	end

	-- A column or a kind, with a row test.
	local column = ask.on == "column" and ask.column or ask.kind.column
	local kindFilter = ask.on == "kind" and ask.kind or nil
	local kinds = kindFilter and { kindFilter } or Schema.KindsOf(column)
	local table_ = Data.GetRowTable(column)
	local virtual = table_ == nil
	local test = ask.test

	if test.is == "exists" then
		if virtual then
			-- A kind read per spell exists where any of its readings does.
			local byKind = {}
			for _, kind in ipairs(kinds) do
				byKind[kind.word] = contentTest(cache, kind, { op = "present" }, false, true)
			end
			return anyKind(byKind)
		end
		if kindFilter then
			return function(spell, cursor)
				return anyRow(column, table_, spell, cursor, kindFilter.word, nil)
			end
		end
		local counts, blob = table_.counts, table_.countsBlob
		return function(spell)
			return Reader.number(blob, counts, spell) > 0
		end
	end

	if test.is == "count" then
		local counting = countTest(test.value)
		if not counting or virtual then
			return never
		end
		if kindFilter then
			return function(spell, cursor)
				return counting(countKind(column, table_, spell, cursor, kindFilter.word))
			end
		end
		local counts, blob = table_.counts, table_.countsBlob
		return function(spell)
			return counting(Reader.number(blob, counts, spell))
		end
	end

	if test.is == "scope" then
		return compileScope(cache, column, kinds, kindFilter, table_, virtual, test.terms)
	end

	-- Content or properties: property tests by kind.
	local byKind = {}
	for _, kind in ipairs(kinds) do
		if test.is == "content" then
			byKind[kind.word] = contentTest(cache, kind, test.value, false, virtual)
		else
			local tests = {}
			for _, ref in ipairs(test.props) do
				if ref.kind == kind then
					tests[#tests + 1] = propTest(cache, kind, ref.prop, test.value, nil, virtual)
				end
			end
			byKind[kind.word] = anyOf(tests)
		end
	end
	if virtual then
		return anyKind(byKind)
	end
	local filter = kindFilter and kindFilter.word or nil
	return function(spell, cursor)
		return anyRow(column, table_, spell, cursor, filter, byKind)
	end
end

--- A parse, from text or from a tree already parsed.
local function parsed(query)
	if type(query) == "string" then
		return Query.Parse(query)
	end
	return query
end

--- A query compiled for one run: its groups as lists of predicates, and the
-- axes whose reference lists the walk keeps a cursor into.
function Search.Compile(query)
	local tree = parsed(query)
	local cache = {}
	local groups = {}
	local axisSet = {}
	for _, group in ipairs(tree.groups) do
		local positive, negative = {}, {}
		for _, index in ipairs(group) do
			local clause = tree.clauses[index]
			local ask = clause.ask
			if ask then
				local predicate = compileAsk(cache, ask)
				local bucket = clause["not"] and negative or positive
				bucket[#bucket + 1] = predicate
				if ask.on == "plain" then
					for _, axis in ipairs(Data.GetPartAxes()) do
						axisSet[axis] = true
					end
				else
					local column = ask.column
						or (ask.kind and ask.kind.column)
						or ask.ref.kind.column
					if Data.GetRowTable(column) then
						axisSet[column] = true
					end
				end
			end
		end
		groups[#groups + 1] = { positive = positive, negative = negative }
	end
	local axes = {}
	for axis in pairs(axisSet) do
		axes[#axes + 1] = { axis = axis, table_ = Data.GetRowTable(axis) }
	end
	return { tree = tree, groups = groups, axes = axes }
end

--- Whether one spell satisfies a compiled query.
local function passes(compiled, spell, cursor)
	local groups = compiled.groups
	if #groups == 0 then
		return true
	end
	for g = 1, #groups do
		local group = groups[g]
		local positive, negative = group.positive, group.negative
		local ok = true
		for i = 1, #positive do
			if not positive[i](spell, cursor) then
				ok = false
				break
			end
		end
		if ok then
			for i = 1, #negative do
				if negative[i](spell, cursor) then
					ok = false
					break
				end
			end
		end
		if ok then
			return true
		end
	end
	return false
end

--- The walk's cursor: where each axis's reference list stands for the spell
-- about to be tested, so a sequential walk never re-derives a row range.
local function cursorAt(compiled, spell)
	local cursor = { at = {} }
	for _, entry in ipairs(compiled.axes) do
		cursor.at[entry.axis] = Data.GetRowRange(entry.axis, spell)
	end
	return cursor
end

--- Advance the cursor past one spell.
local function advance(compiled, cursor, spell)
	local axes, at = compiled.axes, cursor.at
	for i = 1, #axes do
		local entry = axes[i]
		local table_ = entry.table_
		at[entry.axis] = at[entry.axis] + Reader.number(table_.countsBlob, table_.counts, spell)
	end
end

--- The spells satisfying a query, in order, one per call.
-- With a slice, a call that has examined that many spells without a hit
-- returns false rather than going on, so a caller running the walk across
-- frames can yield between calls; the next call carries on where it stopped.
-- Without one, a call returns only a hit or the end.
-- @param query text, or a tree from `Query.Parse`
-- @param fromIndex the spell row to start at, counted from zero; nil for the first
-- @param slice how many spells one call may examine before pausing, or nil for no pause
-- @return an iterator yielding the spell's row and its id, false on a pause, and nil when done
function Search.Find(query, fromIndex, slice)
	local compiled = Search.Compile(query)
	local cols = spellColumns()
	local ids, blob = cols.ids, cols.blob
	local total = Data.GetNumSpells()
	local spell = fromIndex or 0
	local cursor = cursorAt(compiled, spell)
	return function()
		local examined = 0
		while spell < total do
			local at = spell
			local hit = passes(compiled, at, cursor)
			advance(compiled, cursor, at)
			spell = spell + 1
			if hit then
				return at, Reader.number(blob, ids, at)
			end
			examined = examined + 1
			if slice and examined >= slice then
				return false
			end
		end
		return nil
	end
end

--- How many spells satisfy a query. A full walk.
function Search.Count(query)
	local found = 0
	for _ in Search.Find(query) do
		found = found + 1
	end
	return found
end

--- The last query compiled for `Matches`, so a caller testing many spells
-- against one tree compiles it once.
local lastTree, lastCompiled

--- Whether one spell satisfies a query.
-- @param query text, or a tree
-- @param spellID the spell id
-- @return true or false; false where the build has no such spell
function Search.Matches(query, spellID)
	local spell = Data.GetSpellIndexByID(spellID)
	if not spell then
		return false
	end
	local tree = parsed(query)
	if tree ~= lastTree then
		lastTree, lastCompiled = tree, Search.Compile(tree)
	end
	return passes(lastCompiled, spell, nil)
end

return Search

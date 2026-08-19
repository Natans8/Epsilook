--- The query language's declarations, made answerable.
--
-- The data addon carries the declarations the web engine was built from: the
-- grammar's own characters and words, its columns, the kinds each column
-- yields, the properties a kind carries and the types those properties are
-- read in. This file indexes them once and answers the questions the parser
-- and the evaluator ask -- which word is a head, which kind a word names
-- inside a column, how an operand reads against a property -- so that neither
-- of those files holds a word of the language itself. A door renamed or a
-- kind added on the web reaches the addon through the data and an edit
-- nowhere here.
--
-- Reading a value follows the web rule for rule: a sentinel word is read
-- before any notation, the notations are then tried in declaration order and
-- the first to accept the operand wins, and a range's two bounds are read in
-- one notation or not at all.
--
-- Nothing here touches a WoW global.

_G.Epsilook = _G.Epsilook or {}
local Epsilook = _G.Epsilook

local Schema = {}
Epsilook.Schema = Schema

local Text = Epsilook.Text

local floor, abs = math.floor, math.abs

--- The shape of declarations this file reads. Another is refused at load.
Schema.FORMAT = 2

--- The synthetic property behind the count word, so a cardinality reads its
-- operands like any numeric axis. Its word is read off the grammar at load.
Schema.COUNT_PROP = { types = { "count" }, plain = {}, sentinels = {}, synonyms = {} }

--- A set from a list of strings.
local function setOf(list)
	local out = {}
	for _, item in ipairs(list or {}) do
		out[item] = true
	end
	return out
end

--- The spellings a declaration answers to: its own word, its full name and
-- its synonyms, folded.
local function spellingsOf(word, full, synonyms)
	local out = { Text.fold(word) }
	if full then
		out[#out + 1] = Text.fold(full)
	end
	for _, synonym in ipairs(synonyms or {}) do
		out[#out + 1] = Text.fold(synonym)
	end
	return out
end

--- The top-level heads: every column key and synonym, every global kind's
-- spellings, and every property door with the door's own alternatives.
local function headsOf(columns, kinds)
	local heads = {}
	for _, column in ipairs(columns) do
		if column.head then
			heads[column.key] = { role = "column", column = column.key }
			for _, synonym in ipairs(column.synonyms) do
				heads[synonym] = { role = "column", column = column.key }
			end
		end
	end
	for _, kind in ipairs(kinds) do
		if kind.global then
			for _, spelling in ipairs(kind.spellings) do
				heads[spelling] = { role = "kind", kind = kind }
			end
		end
		for _, prop in ipairs(kind.props) do
			if prop.door then
				local head = { role = "prop", kind = kind, prop = prop }
				heads[prop.door] = head
				for i, spelling in ipairs(prop.spellings) do
					-- The property's own name is not a door unless it is the
					-- door; its full name and synonyms are.
					if i > 1 then
						heads[spelling] = heads[spelling] or head
					end
				end
			end
		end
	end
	return heads
end

--- Whether the declarations are loaded.
function Schema.IsLoaded()
	return Schema.kinds ~= nil
end

--- Index one exported schema.
-- @param declared the table the data addon assigns to `Epsilook.schema`
-- @return true, or false and a reason
function Schema.Load(declared)
	if type(declared) ~= "table" or declared.format ~= Schema.FORMAT then
		return false,
			"schema format "
				.. tostring(declared and declared.format)
				.. ", reader expects "
				.. Schema.FORMAT
	end

	Schema.grammar = declared.grammar
	Schema.COUNT_PROP.name = declared.grammar.countWord

	Schema.columns = declared.columns
	Schema.columnByKey = {}
	Schema.kindsOfColumn = {}
	for _, column in ipairs(declared.columns) do
		Schema.columnByKey[column.key] = column
		Schema.kindsOfColumn[column.key] = {}
	end

	Schema.kinds = declared.kinds
	Schema.kindById = {}
	for _, kind in ipairs(declared.kinds) do
		Schema.kindById[kind.id] = kind
		kind.spellings = kind.worded and spellingsOf(kind.word, kind.full, kind.synonyms) or {}
		kind.propByName = {}
		for _, prop in ipairs(kind.props) do
			kind.propByName[prop.name] = prop
			prop.spellings = spellingsOf(prop.name, prop.full, prop.synonyms)
		end
		local column = Schema.kindsOfColumn[kind.column]
		column[#column + 1] = kind
	end

	Schema.types = declared.types
	for _, declaredType in pairs(declared.types) do
		declaredType.acceptsSet = setOf(declaredType.accepts)
	end

	Schema.operators = {}
	Schema.prefixOperators = {}
	for _, op in ipairs(declared.operators) do
		Schema.operators[op.name] = op
		if op.level == "value" and op.form == "prefix" and op.symbol then
			Schema.prefixOperators[#Schema.prefixOperators + 1] = op
		end
	end
	-- Every spelling of every comparison, longest first so that `<=` is read
	-- before `<` is, and the characters one can begin with, so a head word
	-- ends at one.
	Schema.prefixSpellings = {}
	Schema.comparisonStarts = {}
	for _, op in ipairs(Schema.prefixOperators) do
		local symbols = { op.symbol }
		for _, alias in ipairs(op.aliases) do
			symbols[#symbols + 1] = alias
		end
		for _, symbol in ipairs(symbols) do
			Schema.prefixSpellings[#Schema.prefixSpellings + 1] = { symbol = symbol, op = op }
			Schema.comparisonStarts[symbol:sub(1, 1)] = true
		end
	end
	table.sort(Schema.prefixSpellings, function(a, b)
		return #a.symbol > #b.symbol
	end)

	Schema.roles = declared.roles
	Schema.targetWords = declared.targetWords
	Schema.colourNames = declared.colourNames
	Schema.colourTolerance = declared.colourTolerance
	Schema.heads = headsOf(Schema.columns, Schema.kinds)
	return true
end

--- The head a folded word opens, if any.
-- @param word a folded word
-- @return a head record, or nil
function Schema.HeadOf(word)
	return Schema.heads[word]
end

--- The word a head is written with.
function Schema.HeadWord(head)
	if head.role == "column" then
		return head.column
	elseif head.role == "kind" then
		return head.kind.word
	end
	return head.prop.door
end

--- The kind a folded word names inside a column.
-- @param column the column key
-- @param word a folded word
-- @return the kind, or nil
function Schema.KindIn(column, word)
	for _, kind in ipairs(Schema.kindsOfColumn[column] or {}) do
		for _, spelling in ipairs(kind.spellings) do
			if spelling == word then
				return kind
			end
		end
	end
	return nil
end

--- The property a folded word names on a kind.
-- @param kind the kind
-- @param word a folded word
-- @return the property, or nil
function Schema.PropIn(kind, word)
	for _, prop in ipairs(kind.props) do
		for _, spelling in ipairs(prop.spellings) do
			if spelling == word then
				return prop
			end
		end
	end
	return nil
end

--- The kinds a column yields, in declaration order.
function Schema.KindsOf(column)
	return Schema.kindsOfColumn[column] or {}
end

--- Whether a type accepts an operator.
function Schema.Accepts(typeName, opName)
	local declaredType = Schema.types[typeName]
	return declaredType ~= nil and declaredType.acceptsSet[opName] == true
end

--- Whether a type's values are numerals rather than words.
function Schema.IsQuantity(typeName)
	local declaredType = Schema.types[typeName]
	return declaredType ~= nil and declaredType.quantity == true
end

--- Whether a type is read as text, where a bare token is a substring.
function Schema.IsTextual(typeName)
	return typeName == "text" or typeName == "path" or typeName == "enum"
end

--- Which bare reading a type gives a token: a substring where it reads text,
-- equality everywhere else. The one rule the parser and the evaluator share.
function Schema.BareOp(typeName)
	return Schema.Accepts(typeName, "contains") and "contains" or "exact"
end

--- Whether a property names a thing with both an id and a name, so a row
-- carries two readings of one stored number.
function Schema.IsNamed(prop)
	return prop.types[1] == "id" and prop.types[2] == "text"
end

--- The ordered vocabulary ordinal values live in, lowest rank first, and the
-- rank every folded spelling reaches; set from the pack.
local ladder = {}
local rankOf = {}

--- Set the ordinal ladder.
-- @param rungs a list of {word, reads} lowest rank first
function Schema.SetLadder(rungs)
	ladder = rungs
	rankOf = {}
	for rank, rung in ipairs(rungs) do
		rankOf[Text.fold(rung.word)] = rank
		for _, spelling in ipairs(rung.reads or {}) do
			rankOf[Text.fold(spelling)] = rank
		end
	end
end

--- The loaded ladder, lowest rank first.
function Schema.GetLadder()
	return ladder
end

--- The rank a spelling names, whole or not at all.
-- Tried as written first, which is how a stored key arrives; folded only on a miss.
-- @param written a rung's name or any spelling declared for it
-- @return the rank counted from one, or nil
function Schema.OrdinalRank(written)
	return rankOf[written] or rankOf[Text.foldTrimmed(written)]
end

--- The three spellings of a numeral: a decimal, a whole number, a fraction with no leading digit.
local NUMERALS = { "%d+%.%d+", "%d+", "%.%d+" }

--- A written number split into its sign, its digits and its symbol.
-- @param text the folded operand
-- @param before whether the symbol sits before the number
-- @return sign, digits, symbol; or nil where the text is not a number with at most one symbol
local function splitNumber(text, before)
	for _, numeral in ipairs(NUMERALS) do
		if before then
			local sign, symbol, digits = text:match("^([+-]?)([^%d%.]+)(" .. numeral .. ")$")
			if sign then
				return sign, digits, symbol
			end
		end
		local sign, digits, symbol = text:match("^([+-]?)(" .. numeral .. ")(.*)$")
		if sign then
			return sign, digits, symbol
		end
	end
	return nil
end

--- Whether a notation's symbol or one of its aliases is the written one.
local function spelled(notation, symbol)
	if symbol == Text.fold(notation.unit) then
		return true
	end
	for _, alias in ipairs(notation.aliases) do
		if symbol == Text.fold(alias) then
			return true
		end
	end
	return false
end

--- One folded operand read in one notation.
-- @param notation the notation
-- @param storage "int" or "float"
-- @param text the folded operand
-- @param lifted whether the bare threshold and a required sign are relaxed,
--   which is how a range's two bounds are read together
-- @return the stored number, or nil where the text is not written in this notation
local function readNotation(notation, storage, text, lifted)
	local sign, digits, symbol = splitNumber(text, notation.position == "before")
	if not sign then
		return nil
	end
	if symbol == "" then
		local bare = notation.bare
		if bare == "never" then
			return nil
		end
		if type(bare) == "table" and not lifted then
			local size = tonumber(digits)
			if bare.atMost and size > bare.atMost then
				return nil
			end
			if bare.above and size <= bare.above then
				return nil
			end
		end
	elseif not spelled(notation, symbol) then
		return nil
	end
	local rule = notation.sign
	if rule == "required" and sign == "" and not lifted then
		return nil
	end
	if rule == "refused" and sign ~= "" then
		return nil
	end
	local magnitude = tonumber(sign .. digits)
	if not magnitude then
		return nil
	end
	local scaled = magnitude * notation.factor + notation.offset
	if storage == "int" then
		return floor(scaled + 0.5)
	end
	return scaled
end

--- A whole, non-negative number, or nil.
local function wholeNumber(text)
	return text:match("^%d+$") and tonumber(text) or nil
end

--- One operand read as a value of one type, by the type's own rule.
-- Mirrors the web's per-type readers: text is itself, a whole number is an
-- identity or a count, a numeric type dispatches over its notations, a colour
-- is a hex triplet or a name, a role is one of the closed set, an ordinal is a
-- rung of the ladder. A type with no reader here reads nothing.
-- @param typeName the type
-- @param written the operand as typed
-- @return the value, or nil where the operand is not of this type
function Schema.ParseType(typeName, written)
	local declaredType = Schema.types[typeName]
	if not declaredType then
		return nil
	end
	if Schema.IsTextual(typeName) then
		return written
	elseif typeName == "id" or typeName == "count" then
		return wholeNumber(written)
	elseif typeName == "ordinal" then
		if #ladder == 0 then
			return written
		end
		local rank = Schema.OrdinalRank(written)
		return rank and ladder[rank].word or nil
	elseif typeName == "colour" then
		local trimmed = written:match("^%s*(.-)%s*$")
		local hex = trimmed:match("^#?(%x%x%x%x%x%x)$")
		if hex then
			return tonumber(hex, 16)
		end
		return Schema.colourNames[Text.fold(trimmed)]
	elseif typeName == "bitmask" then
		local role = Text.foldTrimmed(written)
		return Schema.roles[role] and role or nil
	elseif #declaredType.notations > 0 then
		local folded = Text.foldTrimmed(written)
		if folded == "" then
			return nil
		end
		for _, notation in ipairs(declaredType.notations) do
			local value = readNotation(notation, declaredType.storage, folded, false)
			if value ~= nil then
				return value
			end
		end
	end
	return nil
end

--- A range's two bounds read in ONE notation of one type.
-- @return lo, hi; or nil where no notation reads both
function Schema.ParseTypePair(typeName, lo, hi)
	local declaredType = Schema.types[typeName]
	if not declaredType or #declaredType.notations == 0 then
		return nil
	end
	local l, h = Text.foldTrimmed(lo), Text.foldTrimmed(hi)
	if l == "" or h == "" then
		return nil
	end
	local storage = declaredType.storage
	for _, notation in ipairs(declaredType.notations) do
		local a = readNotation(notation, storage, l, false)
		local b = readNotation(notation, storage, h, false)
		if a ~= nil and b ~= nil then
			return a, b
		end
	end
	-- Bare bounds read together, and the larger of the two says which
	-- notation the pair is written in: `10-90` is a proportion because ninety
	-- is, even though ten alone would have read as a factor.
	local low, high = tonumber(l), tonumber(h)
	local larger = (low and high and abs(low) >= abs(high)) and l or h
	for _, notation in ipairs(declaredType.notations) do
		local a = readNotation(notation, storage, l, true)
		local b = readNotation(notation, storage, h, true)
		if a ~= nil and b ~= nil and readNotation(notation, storage, larger, false) ~= nil then
			return a, b
		end
	end
	return nil
end

--- The sentinel a written operand names on a property.
-- @return the stored value and the property's first type, or nil
function Schema.SentinelOf(prop, written)
	local folded = Text.foldTrimmed(written)
	for _, sentinel in ipairs(prop.sentinels or {}) do
		if Text.fold(sentinel.word) == folded then
			return sentinel.value, prop.types[1]
		end
	end
	return nil
end

--- One operand read as a property's value.
-- Sentinel words first, then the notations in declaration order.
-- @param prop the property
-- @param written the operand as typed
-- @param notations an optional subset of the property's types to read with
-- @return the value and the type that read it, or nil
function Schema.ParseValue(prop, written, notations)
	notations = notations or prop.types
	local value, typeName = Schema.SentinelOf(prop, written)
	if value ~= nil then
		for _, name in ipairs(notations) do
			if name == typeName then
				return value, typeName
			end
		end
	end
	for _, name in ipairs(notations) do
		local read = Schema.ParseType(name, written)
		if read ~= nil then
			return read, name
		end
	end
	return nil
end

--- The spelling a stored value of a type is written in.
-- A numeric type writes its display notation; everything else writes itself.
-- @param typeName the type
-- @param value the stored value
-- @return the text
function Schema.FormatType(typeName, value)
	local declaredType = Schema.types[typeName]
	if typeName == "colour" then
		return string.format("#%06x", value)
	end
	if typeName == "bitmask" then
		-- A target mask is written as the words of its set bits, in the
		-- declared order; a mask with none set is written as its number.
		local words = {}
		for _, entry in ipairs(Schema.targetWords) do
			if value % (entry.bit * 2) >= entry.bit then
				words[#words + 1] = entry.word
			end
		end
		if #words > 0 then
			return table.concat(words, ", ")
		end
	end
	if declaredType and #declaredType.notations > 0 then
		local notation = declaredType.notations[1]
		local shown = (value - notation.offset) / notation.factor
		-- Six decimals absorb a float column's representation error and keep
		-- every value the data holds; then the number is written as short as
		-- it is.
		shown = floor(shown * 1000000 + 0.5) / 1000000
		local written
		if shown == floor(shown) then
			written = string.format("%d", shown)
		else
			written = (string.format("%.6f", shown):gsub("0+$", ""))
		end
		if notation.sign == "required" and shown >= 0 then
			written = "+" .. written
		end
		if notation.position == "before" then
			return notation.unit .. written
		end
		return written .. notation.unit
	end
	return tostring(value)
end

--- A property's stored value written the way a pill prints it.
-- @param prop the property
-- @param value the stored value
-- @return the sentinel's word where one is declared, otherwise the first type's spelling
function Schema.FormatValue(prop, value)
	if type(value) == "number" then
		for _, sentinel in ipairs(prop.sentinels or {}) do
			if sentinel.value == value then
				return sentinel.word
			end
		end
	end
	return Schema.FormatType(prop.types[1], value)
end

return Schema

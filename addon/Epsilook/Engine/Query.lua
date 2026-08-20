--- The parser: query text in, a tree of plain data out.
--
-- The tree is the query language's, cut down to the grammar
-- the addon carries: plain terms, `head:value`, `-` to exclude, `|` or `or`
-- between clauses, a quoted phrase, a comparison, a range, a comma list, `*`
-- for existence, a row scope `head:{...}` whose terms one row must satisfy
-- together, and the ordering directive `sort:<door>`, `sort:-<door>` for the
-- other way, applied in the order written, bare `sort` ordering by id. Alternatives in parentheses and
-- patterns are refused with a message rather than read, so a query that
-- parses here means what the language says it means.
--
-- Every character and word the grammar uses is read off the exported schema at
-- load -- the bind, the phrase quote, the wildcard, the count and or words --
-- so this file spells none of the language itself. Every clause is data all
-- the way down: a clause holds a head and an ask, an ask an expression, an
-- expression its operands, tables with no functions in them, so the evaluator,
-- a formatter and a display can each read the same tree without having parsed
-- it. The tree's shape is the engine's own and is not a documented surface:
-- `Epsilook:ParseQuery` returns it opaque and `Epsilook:FindSpells` takes it
-- back.
--
-- A pasted spell link reads as the spell's id: the lexer rewrites it before
-- anything else sees the text, so `|Hspell:133|h[Fireball]|h` is `id:133`.
--
-- Nothing here touches a WoW global.

_G.Epsilook = _G.Epsilook or {}
local Epsilook = _G.Epsilook

local Query = {}
Epsilook.Query = Query

local Schema = Epsilook.Schema
local Text = Epsilook.Text

local sub, find = string.sub, string.find

--- The typed synonyms that reach the limit directive, as a set — built on
-- first use, since the schema's data mounts after this module loads.
local limitReads
local function isLimitRead(word)
	if not limitReads then
		limitReads = {}
		for _, read in ipairs(Schema.grammar.limitReads or {}) do
			limitReads[read] = true
		end
	end
	return limitReads[word] == true
end

local function isWs(c)
	return c == " " or c == "\t" or c == "\n" or c == "\r"
end

--- A pasted chat link to a spell, read as that spell's id.
local function linksToIds(text)
	local out = text
	out = out:gsub("|c%x%x%x%x%x%x%x%x|Hspell:(%d+)[^|]*|h%b[]|h|r", "id:%1")
	out = out:gsub("|Hspell:(%d+)[^|]*|h%b[]|h", "id:%1")
	return out
end

--- The interpretations of a value, as the language names them.
local function content(value)
	return { r = "content", value = value }
end
local function props(refs, value)
	return { r = "props", props = refs, value = value }
end
local function counted(value)
	return { r = "count", value = value }
end
local function fail(message)
	return { r = "fail", message = message }
end
local function empty(why)
	return { r = "empty", why = why }
end

--- A value expression for a prefix operator applied to one typed operand.
local function opExpr(opName, operand)
	return { op = opName, operand = operand }
end

--- Marks an operand as quoted, so its characters are matched as written.
local function verbatimly(operand)
	operand.verbatim = true
	return operand
end

--- A typed operand.
local function typed(typeName, value, written)
	return { type = typeName, value = value, written = written }
end

--- The text of one operand, as a reader wrote it.
-- @param operand a typed or written operand of the tree
-- @return the text
function Query.OperandText(operand)
	if operand.text then
		return operand.text
	end
	return operand.written or tostring(operand.value)
end

--- Merge the interpretations of a value's alternatives into one.
-- They must resolve the same way -- all content, all properties, all counts --
-- because one clause carries one question.
local function combineAlternatives(parts)
	local real = {}
	for _, part in ipairs(parts) do
		if part.r == "fail" then
			return part
		end
		if part.r ~= "empty" then
			real[#real + 1] = part
		end
	end
	if #real == 0 then
		return empty("nothing to read")
	end
	if #real == 1 then
		return real[1]
	end
	local shape = real[1].r
	local values = {}
	for _, part in ipairs(real) do
		if part.r ~= shape then
			return fail("the alternatives ask different questions")
		end
		values[#values + 1] = part.value
	end
	local value = { op = "anyOf", alternatives = values }
	if shape == "content" then
		return content(value)
	elseif shape == "count" then
		return counted(value)
	elseif shape == "props" then
		local refs, seen = {}, {}
		for _, part in ipairs(real) do
			for _, ref in ipairs(part.props) do
				local key = ref.kind.id .. "." .. ref.prop.name
				if not seen[key] then
					seen[key] = true
					refs[#refs + 1] = ref
				end
			end
		end
		return props(refs, value)
	end
	return fail("the alternatives ask different questions")
end

--- The comparison operator a value begins with, if any.
-- @return the operator and the operand after its symbol, or nil
local function prefixed(text)
	for _, spelling in ipairs(Schema.prefixSpellings) do
		local symbol = spelling.symbol
		if sub(text, 1, #symbol) == symbol then
			return spelling.op, sub(text, #symbol + 1)
		end
	end
	return nil
end

--- The operator one bare token is, whole, if any.
local function operatorAlone(text)
	for _, spelling in ipairs(Schema.prefixSpellings) do
		if spelling.symbol == text then
			return spelling.op
		end
	end
	return nil
end

--- Whether a text is a list of whole numbers joined by the list character.
local function isNumberList(text)
	local list = Schema.grammar.numberList
	local escaped = list:gsub("%p", "%%%0")
	return text:match("^%d+" .. escaped .. "%d+[%d" .. escaped .. "]*$") ~= nil
		and not text:find(list .. list, 1, true)
		and sub(text, -1) ~= list
end

--- Whether a property reads any value as a word rather than a numeral.
local function worded(prop)
	for _, typeName in ipairs(prop.types) do
		if not Schema.IsQuantity(typeName) then
			return true
		end
	end
	return false
end

--- Whether a property reads any value as a numeral.
local function counts(prop)
	for _, typeName in ipairs(prop.types) do
		if Schema.IsQuantity(typeName) then
			return true
		end
	end
	return false
end

--- Whether any of a property's types accepts an operator.
local function anyAccepts(prop, opName)
	for _, typeName in ipairs(prop.types) do
		if Schema.Accepts(typeName, opName) then
			return true
		end
	end
	return false
end

--- The reader over one property's declared notations.
-- The shared context a bound property, a count and a kind's claiming property
-- all read through; what differs between them is only what the resulting
-- value becomes, which `done` decides.
local function typedCtx(prop, word, done)
	local ctx = {}
	local wildcard = Schema.grammar.wildcard
	local range = Schema.grammar.range

	--- The string reading of a quoted operand: the first textual type answering the operator that reads it.
	local function stringReading(text, opName)
		for _, typeName in ipairs(prop.types) do
			if
				not Schema.IsQuantity(typeName)
				and Schema.Accepts(typeName, "contains")
				and Schema.Accepts(typeName, opName)
			then
				local value = Schema.ParseType(typeName, text)
				if value ~= nil then
					return value, typeName
				end
			end
		end
		return nil
	end
	--- The quote law: a quoted quantity is refused where the axis has a string reading to prefer.
	local function refusesQuote(text)
		if Schema.SentinelOf(prop, text) ~= nil or not worded(prop) then
			return false
		end
		local value, typeName = Schema.ParseValue(prop, text)
		if value ~= nil then
			return Schema.IsQuantity(typeName)
		end
		return counts(prop)
	end
	local function illTyped()
		return fail(word .. " takes " .. (prop.hint or "a value"))
	end
	local function quotedQuantity()
		return fail(
			word .. " takes " .. (prop.hint or "a value") .. ", and quotes make a string of it"
		)
	end
	local function bareValue(text)
		local value, typeName = Schema.ParseValue(prop, text)
		if value == nil then
			return illTyped()
		end
		return done(opExpr(Schema.BareOp(typeName), typed(typeName, value, text)))
	end
	local function openBound(bound, opName)
		for _, typeName in ipairs(prop.types) do
			if Schema.Accepts(typeName, "range") and Schema.Accepts(typeName, opName) then
				local value = Schema.ParseType(typeName, bound)
				if value ~= nil then
					return done(opExpr(opName, typed(typeName, value, bound)))
				end
			end
		end
		return nil
	end
	local function rangeParts(lo, hi)
		if lo == wildcard and hi ~= wildcard then
			return openBound(hi, "lte")
		end
		if hi == wildcard and lo ~= wildcard then
			return openBound(lo, "gte")
		end
		for _, typeName in ipairs(prop.types) do
			if Schema.Accepts(typeName, "range") then
				-- A unit written anywhere in the range is the phrase's default, so a
				-- bare bound beside a spelled one takes it before either is read.
				-- Each bound is then recorded as the phrase spelled it rather than as
				-- it was typed, since that is the notation it chose and the one it has
				-- to wear to read back as itself.
				local loText, hiText = Schema.WornPair(typeName, lo, hi)
				loText, hiText = loText or lo, hiText or hi
				local a, b = Schema.ParseTypePair(typeName, loText, hiText)
				if a ~= nil then
					local one, two = Schema.SharedNotation(typeName, loText, hiText, a, b)
					loText, hiText = one or loText, two or hiText
				else
					a, b = Schema.ParseType(typeName, loText), Schema.ParseType(typeName, hiText)
				end
				if a ~= nil and b ~= nil then
					return done({
						op = "range",
						lo = typed(typeName, a, loText),
						hi = typed(typeName, b, hiText),
					})
				end
			end
		end
		return nil
	end

	ctx.wordStar = true
	function ctx.operator(op, operand, phrase)
		if phrase then
			local value, typeName = stringReading(operand, op.name)
			if value ~= nil then
				return done(opExpr(op.name, verbatimly(typed(typeName, value, operand))))
			end
			if refusesQuote(operand) then
				return quotedQuantity()
			end
		end
		local value, typeName = Schema.ParseValue(prop, operand)
		if value == nil then
			return illTyped()
		end
		if not Schema.Accepts(typeName, op.name) then
			return fail(word .. " cannot answer " .. op.symbol)
		end
		return done(opExpr(op.name, typed(typeName, value, operand)))
	end
	function ctx.range(text)
		if not anyAccepts(prop, "range") then
			return nil
		end
		if #text > 1 and sub(text, -1) == range then
			local open = openBound(sub(text, 1, -2), "gte")
			if open then
				return open
			end
		end
		for k = 2, #text - 1 do
			if sub(text, k, k) == range then
				local result = rangeParts(sub(text, 1, k - 1), sub(text, k + 1))
				if result then
					return result
				end
			end
		end
		return nil
	end
	ctx.rangeParts = rangeParts
	ctx.bare = bareValue
	function ctx.phrase(text)
		local value, typeName = stringReading(text, "contains")
		if value ~= nil then
			-- Quotes are strict: the characters are matched as written.
			return done(opExpr("contains", verbatimly(typed(typeName, value, text))))
		end
		if refusesQuote(text) then
			return quotedQuantity()
		end
		return bareValue(text)
	end
	function ctx.star()
		return done({ op = "present" })
	end
	return ctx
end

--- The count word's context, the same for every query.
local countCtx

--- An operand read against one property, or one word shared by several kinds' properties.
local function propCtx(refs, word)
	return typedCtx(refs[1].prop, word, function(value)
		return props(refs, value)
	end)
end

--- Whether a bare operand is one of a flag property's own words.
-- A flag is a presence with no value behind it, so its own spellings are what
-- a reader types to select the rows carrying it. The spellings are the same
-- list the matcher compares against.
local function isFlagWord(prop, text)
	if prop.types[1] ~= "flag" then
		return false
	end
	local folded = Text.fold(text)
	for _, word in ipairs(prop.spellings) do
		if Text.fold(word) == folded then
			return true
		end
	end
	return false
end

--- An operand read against a kind: its properties claim it in declaration
-- order, and a comparison no property claims falls back to counting the
-- kind's rows, where the position allows one.
local function kindCtx(kind, countFallback)
	local ctx = {}
	local word = kind.word
	local refs = {}
	for _, prop in ipairs(kind.props) do
		refs[#refs + 1] = { kind = kind, prop = prop }
	end
	local subject = refs[1] and refs[1].prop or Schema.COUNT_PROP
	local function illTyped()
		return fail(word .. " takes " .. (subject.hint or "a value"))
	end
	--- The first property whose context answers a method, else the count's where the position allows.
	local function firstOf(method, ...)
		for _, ref in ipairs(refs) do
			local answer = propCtx({ ref }, word)[method](...)
			if answer then
				return answer
			end
		end
		if countFallback then
			return countCtx[method](...)
		end
		return nil
	end
	ctx.wordStar = true
	function ctx.operator(op, operand, phrase)
		local claimed = false
		for _, ref in ipairs(refs) do
			local value, typeName = Schema.ParseValue(ref.prop, operand)
			if value ~= nil then
				claimed = true
				if Schema.Accepts(typeName, op.name) then
					return propCtx({ ref }, word).operator(op, operand, phrase)
				end
			end
		end
		-- A quoted operand is a string, which the count question refuses like any quantity.
		if countFallback and not phrase and Schema.Accepts("count", op.name) then
			local value = Schema.ParseType("count", operand)
			if value ~= nil then
				return counted(opExpr(op.name, typed("count", value, operand)))
			end
		end
		if claimed then
			return fail(word .. " cannot answer " .. op.symbol)
		end
		return illTyped()
	end
	function ctx.range(text)
		return firstOf("range", text)
	end
	function ctx.rangeParts(lo, hi)
		return firstOf("rangeParts", lo, hi)
	end
	function ctx.bare(text)
		-- A flag stores no value, so no notation reads an operand into one:
		-- what selects the rows carrying it is the property's own word, which
		-- is what the matcher compares against too. Claimed before the
		-- notations, since a word is never also a quantity.
		local flags = {}
		for _, ref in ipairs(refs) do
			if isFlagWord(ref.prop, text) then
				flags[#flags + 1] = ref
			end
		end
		if #flags > 0 then
			return props(flags, opExpr("contains", { text = text }))
		end
		local claimants = {}
		for _, ref in ipairs(refs) do
			if Schema.ParseValue(ref.prop, text) ~= nil then
				claimants[#claimants + 1] = ref
			end
		end
		if #claimants == 0 then
			return illTyped()
		end
		if #claimants == 1 then
			return propCtx(claimants, word).bare(text)
		end
		return props(claimants, opExpr("contains", { text = text }))
	end
	--- A phrase is a string. Textual properties take it; failing those, word
	-- vocabularies -- sentinels, roles, rungs -- then anything that reads it.
	function ctx.phrase(text)
		local textual, wordy, readable = {}, {}, {}
		for _, ref in ipairs(refs) do
			local prop = ref.prop
			local value, typeName = Schema.ParseValue(prop, text)
			local isTextual = false
			for _, name in ipairs(prop.types) do
				if
					not Schema.IsQuantity(name)
					and Schema.Accepts(name, "contains")
					and Schema.ParseType(name, text) ~= nil
				then
					isTextual = true
				end
			end
			if isTextual then
				textual[#textual + 1] = ref
			end
			if
				Schema.SentinelOf(prop, text) ~= nil
				or (value ~= nil and not Schema.IsQuantity(typeName))
			then
				wordy[#wordy + 1] = ref
			end
			if value ~= nil then
				readable[#readable + 1] = ref
			end
		end
		if #textual == 1 then
			return propCtx(textual, word).phrase(text)
		elseif #textual > 0 then
			return props(textual, opExpr("contains", { text = text, verbatim = true }))
		elseif #wordy > 0 then
			return propCtx(wordy, word).phrase(text)
		elseif #readable > 0 then
			return propCtx(readable, word).bare(text)
		end
		return illTyped()
	end
	function ctx.star()
		return { r = "kindWord", kind = kind }
	end
	return ctx
end

--- An operand read against a whole column.
-- A comparison whose operand is a count is the count question; the anchor
-- keeps its meaning on content; anything else is content, because spell and
-- file names carry operators of their own. A lone word naming one of the
-- column's kinds tests the kind.
local function columnCtx(column)
	local ctx = {}
	ctx.wordStar = true
	function ctx.operator(op, operand, phrase, whole)
		if not phrase then
			local value = Schema.ParseType("count", operand)
			if value ~= nil then
				return counted(opExpr(op.name, typed("count", value, operand)))
			end
		end
		if op.name == "exact" then
			return content(opExpr("exact", { text = operand }))
		end
		return content(opExpr("contains", { text = whole }))
	end
	function ctx.range(text)
		return countCtx.range(text)
	end
	function ctx.rangeParts(lo, hi)
		return countCtx.rangeParts(lo, hi)
	end
	function ctx.bare(text, alone)
		if alone then
			local named = Schema.KindIn(column, Text.fold(text))
			if named then
				return { r = "kindWord", kind = named }
			end
		end
		return content(opExpr("contains", { text = text }))
	end
	function ctx.phrase(text)
		return content(opExpr("contains", { text = text, verbatim = true }))
	end
	function ctx.star()
		return { r = "exists" }
	end
	return ctx
end

--- A bare term at the top level: plain search. Operator characters are inert
-- here, so everything except the lone wildcard is content. One table, since
-- it closes over nothing.
local function asContent(text)
	return content(opExpr("contains", { text = text }))
end
local function nothing()
	return nil
end
local topCtx = {
	wordStar = false,
	operator = function(_, _, _, whole)
		return asContent(whole)
	end,
	range = nothing,
	rangeParts = nothing,
	bare = asContent,
	phrase = function(text)
		return content(opExpr("contains", { text = text, verbatim = true }))
	end,
	star = function()
		return content({ op = "present" })
	end,
}

--- The context a head's value is read in.
local function ctxFor(head)
	if head.role == "column" then
		return columnCtx(head.column)
	elseif head.role == "kind" then
		return kindCtx(head.kind, true)
	end
	return propCtx({ { kind = head.kind, prop = head.prop } }, head.prop.door)
end

--- Read one alternative: existence, a number list, a prefixed operator, a
-- range, or a plain word -- in that order.
local function alternative(text, ctx, alone)
	local grammar = Schema.grammar
	if text == "" then
		return empty("nothing to read")
	end
	if text == grammar.wildcard then
		return ctx.star()
	end
	if ctx.wordStar and Text.fold(text) == grammar.anyWord then
		return ctx.star()
	end
	if isNumberList(text) then
		local parts = {}
		for number in text:gmatch("%d+") do
			parts[#parts + 1] = ctx.bare(number, false)
		end
		return combineAlternatives(parts)
	end
	local op, operand = prefixed(text)
	if op then
		if operand == "" then
			return empty("nothing to compare with")
		end
		if op.name == "exact" and find(operand, grammar.wildcard, 1, true) then
			return fail("an anchored value cannot carry a pattern")
		end
		return ctx.operator(op, operand, false, text)
	end
	local ranged = ctx.range(text)
	if ranged then
		return ranged
	end
	if find(text, grammar.wildcard, 1, true) then
		return fail("patterns are not supported here")
	end
	return ctx.bare(text, alone)
end

--- Read a bare segment: glued alternation split, then each alternative read.
-- The split steps over escaped pairs, so a shielded alternation character is
-- part of the value rather than a fork in it.
local function bareAlternatives(text, ctx)
	local real = {}
	local or_ = Schema.grammar["or"]
	local escape = Schema.grammar.escape
	local cur = {}
	local i = 1
	while i <= #text do
		local c = sub(text, i, i)
		if c == escape and i < #text then
			cur[#cur + 1] = sub(text, i, i + 1)
			i = i + 2
		elseif c == or_ then
			if #cur > 0 then
				real[#real + 1] = table.concat(cur)
			end
			cur = {}
			i = i + 1
		else
			cur[#cur + 1] = c
			i = i + 1
		end
	end
	if #cur > 0 then
		real[#real + 1] = table.concat(cur)
	end
	if #real == 0 then
		return empty("nothing to read")
	end
	if #real == 1 then
		return alternative(real[1], ctx, true)
	end
	local parts = {}
	for _, part in ipairs(real) do
		parts[#parts + 1] = alternative(part, ctx, false)
	end
	return combineAlternatives(parts)
end

--- The phrase opening at `at`: its text with escapes resolved, and where it ends.
-- @return text, end position (one past the closing quote), closed
local function scanPhrase(text, at, limit)
	local phrase, escape = Schema.grammar.phrase, Schema.grammar.escape
	local out = {}
	local i = at + 1
	local closed = false
	while i <= limit do
		local c = sub(text, i, i)
		if c == escape and i < limit then
			out[#out + 1] = sub(text, i + 1, i + 1)
			i = i + 2
		elseif c == phrase then
			closed = true
			i = i + 1
			break
		else
			out[#out + 1] = c
			i = i + 1
		end
	end
	return table.concat(out), i, closed
end

--- Shape an interpreted value into an ask under its head.
local function askFor(head, interp)
	if head == nil then
		if interp.r == "content" then
			return { on = "plain", value = interp.value }
		end
		return { on = "plain", value = { op = "present" } }
	end
	local function testFor(i)
		if i.r == "content" then
			return { is = "content", value = i.value }
		elseif i.r == "props" then
			return { is = "props", props = i.props, value = i.value }
		elseif i.r == "count" then
			return { is = "count", value = i.value }
		end
		return { is = "exists" }
	end
	if head.role == "column" then
		if interp.r == "kindWord" then
			return { on = "kind", kind = interp.kind, test = { is = "exists" } }
		end
		return { on = "column", column = head.column, test = testFor(interp) }
	elseif head.role == "kind" then
		return { on = "kind", kind = head.kind, test = testFor(interp) }
	end
	local ref = { kind = head.kind, prop = head.prop }
	if interp.r == "kindWord" or interp.r == "exists" then
		return { on = "prop", ref = ref, value = { op = "present" } }
	end
	return { on = "prop", ref = ref, value = interp.value }
end

--- An inner bind's word resolved against a column or kind head: the count
-- axis, a kind of the column, a property, or nothing.
-- @return a context, or nil and a message where the word is foreign to the kind
local function innerBind(head, word)
	if word == Schema.grammar.countWord then
		return countCtx
	end
	if head.role == "kind" then
		local prop = Schema.PropIn(head.kind, word)
		if prop then
			return propCtx({ { kind = head.kind, prop = prop } }, word)
		end
		return nil, head.kind.word .. " has no property " .. word
	end
	local kind = Schema.KindIn(head.column, word)
	if kind then
		return kindCtx(kind, false)
	end
	local refs = {}
	for _, candidate in ipairs(Schema.KindsOf(head.column)) do
		local prop = Schema.PropIn(candidate, word)
		if prop then
			refs[#refs + 1] = { kind = candidate, prop = prop }
		end
	end
	if #refs > 0 then
		return propCtx(refs, word)
	end
	return nil
end

--- The parser over one query.
local Parser = {}
Parser.__index = Parser

local function newParser(text)
	local self = setmetatable({}, Parser)
	self.text = text
	self.clauses = {}
	self.problems = {}
	self.groups = {}
	self.current = {}
	self.sorts = {}
	self.limit = nil
	local grammar = Schema.grammar
	-- Characters that end the word scanned as a possible head.
	self.headEnds = {
		[grammar.bind] = true,
		[grammar.phrase] = true,
		[grammar.scope.open] = true,
		[grammar.scope.close] = true,
		[grammar.group.open] = true,
		[grammar.group.close] = true,
		[grammar["or"]] = true,
	}
	-- Values opening with a paren read as a construct this grammar left out.
	self.refused = {
		[grammar.group.open] = "alternatives in parentheses are not supported here; write a"
			.. grammar["or"]
			.. "b",
	}
	return self
end

function Parser:char(i)
	return sub(self.text, i, i)
end

function Parser:closeRun()
	if #self.current > 0 then
		self.groups[#self.groups + 1] = self.current
	end
	self.current = {}
end

--- Add a clause and file it into the current alternation group.
function Parser:push(span, negated, state, ask, problems)
	local index = #self.clauses + 1
	self.clauses[index] = { span = span, ["not"] = negated, state = state, ask = ask }
	if state == "ok" then
		self.current[#self.current + 1] = index
	end
	for _, problem in ipairs(problems or {}) do
		self.problems[#self.problems + 1] = {
			severity = problem.severity or "error",
			message = problem.message,
			at = span.start,
			length = span.stop - span.start + 1,
		}
	end
end

--- The end of the run at `i` that could be a head word: up to whitespace, a
-- structural character or a comparison.
function Parser:wordEnd(i, limit)
	local j = i
	while j <= limit do
		local c = self:char(j)
		if isWs(c) or self.headEnds[c] or Schema.comparisonStarts[c] then
			break
		end
		j = j + 1
	end
	return j
end

--- The end of an or-word standing alone at `i`, or `i` where none stands.
function Parser:orWordEnd(i, limit)
	local j = self:wordEnd(i, limit)
	if j <= i or Text.fold(sub(self.text, i, j - 1)) ~= Schema.grammar.orWord then
		return i
	end
	local nextChar = j <= limit and self:char(j) or ""
	if nextChar == "" or isWs(nextChar) or nextChar == Schema.grammar["or"] then
		return j
	end
	return i
end

--- The value token at `from`: its segments and where it ends.
-- A segment is bare text or a phrase; a token ends at whitespace.
function Parser:token(from, limit)
	local phrase = Schema.grammar.phrase
	local segs = {}
	local cur = {}
	local curStart = from
	local i = from
	local function flush(stop)
		if #cur > 0 then
			segs[#segs + 1] =
				{ form = "bare", text = table.concat(cur), start = curStart, stop = stop - 1 }
			cur = {}
		end
	end
	local escape = Schema.grammar.escape
	while i <= limit do
		local c = self:char(i)
		-- The escape shields the next character from every structural reading
		-- below; the pair joins the bare run as it was typed.
		if c == escape and i < limit and not isWs(self:char(i + 1)) then
			cur[#cur + 1] = c
			cur[#cur + 1] = self:char(i + 1)
			i = i + 2
		elseif isWs(c) then
			break
		elseif c == phrase then
			flush(i)
			local quoted, stop, closed = scanPhrase(self.text, i, limit)
			segs[#segs + 1] =
				{ form = "phrase", text = quoted, start = i, stop = stop - 1, closed = closed }
			i = stop
			curStart = i
		else
			cur[#cur + 1] = c
			i = i + 1
		end
	end
	flush(i)
	return segs, i
end

--- Interpret a token's segments as one value.
-- An operator glued to a phrase -- `="Fire Ball"` -- reads the phrase as the
-- operator's string operand. Otherwise the first segment is the value, and
-- anything glued after it is split off and read as terms of its own.
-- @return the interpretation, and the segments split off
function Parser:interpretSegs(segs, ctx, problems)
	if #segs == 0 then
		return empty("nothing to read"), {}
	end
	local first = segs[1]
	local main
	local used = 1
	local op = first.form == "bare" and operatorAlone(first.text) or nil
	if op and segs[2] and segs[2].form == "phrase" then
		main = ctx.operator(op, segs[2].text, true, first.text .. segs[2].text)
		used = 2
	elseif first.form == "phrase" then
		if not first.closed then
			problems[#problems + 1] = { severity = "warning", message = "the phrase is not closed" }
		end
		main = ctx.phrase(first.text)
	else
		main = bareAlternatives(first.text, ctx)
	end
	local extras = {}
	for k = used + 1, #segs do
		extras[#extras + 1] = segs[k]
	end
	if #extras > 0 then
		problems[#problems + 1] = {
			severity = "warning",
			message = "two values are glued together; a space separates them",
		}
	end
	return main, extras, segs[used].stop
end

--- Push an interpreted value as a clause.
function Parser:pushInterp(span, negated, head, interp, problems)
	if interp.r == "fail" then
		problems[#problems + 1] = { severity = "error", message = interp.message }
		self:push(span, negated, "invalid", nil, problems)
	elseif interp.r == "empty" then
		local what = head and (Schema.HeadWord(head) .. Schema.grammar.bind) or "the term"
		problems[#problems + 1] =
			{ severity = "error", message = what .. " has no value: " .. interp.why }
		self:push(span, negated, "invalid", nil, problems)
	else
		self:push(span, negated, "ok", askFor(head, interp), problems)
	end
end

--- Re-emit segments split off a glued token as terms of their own.
function Parser:emitExtras(extras)
	for _, seg in ipairs(extras) do
		local problems = {}
		local main = self:interpretSegs({ seg }, topCtx, problems)
		self:pushInterp({ start = seg.start, stop = seg.stop }, false, nil, main, problems)
	end
end

--- A bare term: plain search.
function Parser:term(start, negated, i, limit)
	local segs, stop = self:token(i, limit)
	if #segs == 0 then
		return stop
	end
	local problems = {}
	local main, extras, last = self:interpretSegs(segs, topCtx, problems)
	self:pushInterp({ start = start, stop = last }, negated, nil, main, problems)
	self:emitExtras(extras)
	return stop
end

--- A glued inner bind straight after the head's colon: `model:count<5`,
-- `model:file=foo`. Only an operator binds the word, and only a word the head
-- resolves; anything else keeps its content reading.
-- @return the position to continue from, or nil where this is not one
function Parser:innerGlue(start, negated, head, vpos, limit)
	local j = self:wordEnd(vpos, limit)
	if j <= vpos or j > limit or not Schema.comparisonStarts[self:char(j)] then
		return nil
	end
	local word = Text.fold(sub(self.text, vpos, j - 1))
	local ctx, foreign = innerBind(head, word)
	if not ctx then
		if foreign then
			local _, stop = self:token(j, limit)
			self:push(
				{ start = start, stop = stop - 1 },
				negated,
				"invalid",
				nil,
				{ { severity = "error", message = foreign } }
			)
			return stop
		end
		return nil
	end
	local segs, stop = self:token(j, limit)
	if #segs == 0 then
		return nil
	end
	local problems = {}
	local main, extras, last = self:interpretSegs(segs, ctx, problems)
	if main.r == "fail" or main.r == "empty" then
		self:pushInterp({ start = start, stop = last }, negated, head, main, problems)
	else
		local ask
		if main.r == "kindWord" then
			ask = { on = "kind", kind = main.kind, test = { is = "exists" } }
		else
			ask = askFor(head, main)
			-- Remembered so the clause writes back as it was read, with the
			-- property's name rather than the head's own reading of the value.
			ask.inner = true
		end
		self:push({ start = start, stop = last }, negated, "ok", ask, problems)
	end
	self:emitExtras(extras)
	return stop
end

--- The position after a balanced brace run opening at `open`, or past the
-- end where it never closes.
function Parser:skipBraces(open, limit)
	local grammar = Schema.grammar
	local depth, i = 0, open
	while i <= limit do
		local c = self:char(i)
		if c == grammar.escape and i < limit then
			i = i + 2
		elseif c == grammar.phrase then
			local _, stop = scanPhrase(self.text, i, limit)
			i = stop
		else
			if c == grammar.scope.open then
				depth = depth + 1
			elseif c == grammar.scope.close then
				depth = depth - 1
				if depth == 0 then
					return i + 1
				end
			end
			i = i + 1
		end
	end
	return limit + 1
end

--- Append one interpreted term to a scope's run, a failure or an empty
-- reading kept as a term that does not run.
function Parser:pushScopeTerm(run, negated, interp, problems, word)
	if interp.r == "fail" then
		problems[#problems + 1] = { severity = "error", message = interp.message }
		run[#run + 1] = { ["not"] = negated, state = "incomplete" }
	elseif interp.r == "empty" then
		problems[#problems + 1] =
			{ severity = "error", message = word .. " has no value: " .. interp.why }
		run[#run + 1] = { ["not"] = negated, state = "incomplete" }
	else
		local ask
		if interp.r == "content" then
			ask = { on = "content", value = interp.value }
		elseif interp.r == "props" then
			ask = { on = "props", props = interp.props, value = interp.value }
		elseif interp.r == "count" then
			ask = { on = "count", value = interp.value }
		elseif interp.r == "kindWord" then
			ask = { on = "kindWord", kind = interp.kind }
		else
			ask = { on = "content", value = { op = "present" } }
		end
		run[#run + 1] = { ["not"] = negated, state = "ok", ask = ask }
	end
end

--- One item inside a scope's body: a bind the head resolves, or a bare term.
-- A comparison reads across whitespace inside a scope, `{count > 5}`; a
-- colon binds only glued. A word the head does not know before a colon is
-- ordinary text; inside a kind's scope an unknown word is foreign, and the
-- caller refuses the clause.
-- @return the position to continue from, and a message where the item is foreign
function Parser:innerItem(head, negated, i, bodyEnd, run, problems)
	local grammar = Schema.grammar
	local j = self:wordEnd(i, bodyEnd)
	local sepAt = j
	if j > i and j <= bodyEnd and isWs(self:char(j)) then
		local k = j
		while k <= bodyEnd and isWs(self:char(k)) do
			k = k + 1
		end
		if k <= bodyEnd and Schema.comparisonStarts[self:char(k)] then
			sepAt = k
		end
	end
	local sep = sepAt <= bodyEnd and self:char(sepAt) or ""
	if j > i and (sep == grammar.bind or Schema.comparisonStarts[sep]) then
		local word = Text.fold(sub(self.text, i, j - 1))
		local ctx, foreign = innerBind(head, word)
		if foreign then
			return i, foreign
		end
		if ctx then
			local vpos = sep == grammar.bind and sepAt + 1 or sepAt
			local segs, stop = self:valueToken(vpos, bodyEnd)
			if #segs == 0 then
				problems[#problems + 1] =
					{ severity = "warning", message = word .. " has no value here and is ignored" }
				run[#run + 1] = { ["not"] = negated, state = "incomplete" }
				return vpos
			end
			local main, extras = self:interpretSegs(segs, ctx, problems)
			self:pushScopeTerm(run, negated, main, problems, word)
			for _, seg in ipairs(extras) do
				local more = self:interpretSegs({ seg }, ctxFor(head), problems)
				self:pushScopeTerm(run, false, more, problems, seg.text)
			end
			return stop
		end
	end
	local segs, stop = self:token(i, bodyEnd)
	if #segs == 0 then
		return i + 1
	end
	local main, extras = self:interpretSegs(segs, ctxFor(head), problems)
	self:pushScopeTerm(run, negated, main, problems, sub(self.text, i, stop - 1))
	for _, seg in ipairs(extras) do
		local more = self:interpretSegs({ seg }, ctxFor(head), problems)
		self:pushScopeTerm(run, false, more, problems, seg.text)
	end
	return stop
end

--- A value token inside a scope, where a comparison reads across whitespace
-- on both sides: a lone operator followed by space and an operand is one
-- value, `{count > 5}`. Nothing bridges towards an alternation, an exclusion
-- or a brace.
function Parser:valueToken(vpos, limit)
	local grammar = Schema.grammar
	local segs, stop = self:token(vpos, limit)
	if #segs ~= 1 or segs[1].form ~= "bare" or not operatorAlone(segs[1].text) then
		return segs, stop
	end
	local k = stop
	while k <= limit and isWs(self:char(k)) do
		k = k + 1
	end
	if k == stop or k > limit then
		return segs, stop
	end
	local c = self:char(k)
	if
		c == grammar["or"]
		or c == grammar.negate
		or c == grammar.scope.close
		or c == grammar.scope.open
	then
		return segs, stop
	end
	local more, after = self:token(k, limit)
	if #more == 0 then
		return segs, stop
	end
	-- A bare operand joins the operator as one segment, `>5`; a phrase stays
	-- its own, as the interpreter reads an operator glued to a phrase.
	if more[1].form == "bare" then
		segs[1] = {
			form = "bare",
			text = segs[1].text .. more[1].text,
			start = segs[1].start,
			stop = more[1].stop,
		}
		table.remove(more, 1)
	end
	for _, seg in ipairs(more) do
		segs[#segs + 1] = seg
	end
	return segs, after
end

--- Whether a scope term states a bare value of the row: no negation, no operator.
local function statesBareValue(term)
	if term.state ~= "ok" or term["not"] or not term.ask then
		return false
	end
	local ask = term.ask
	if ask.on == "kindWord" or ask.on == "count" then
		return false
	end
	-- A flag word states no value: it says one of the row's properties is set,
	-- which holds alongside whatever the row's other properties say, so two of
	-- them are satisfiable together and conjoin like any other pair.
	if ask.on == "props" then
		local allFlags = true
		for _, ref in ipairs(ask.props) do
			if ref.prop.types[1] ~= "flag" then
				allFlags = false
				break
			end
		end
		if allFlags then
			return false
		end
	end
	local op = ask.value.op
	return op == "contains" or op == "anyOf"
end

--- On a kind a spell has at most one row of, several bare values in one run
-- each become their own alternative, since one row cannot be two things;
-- whatever else the run stated keeps every alternative company.
-- A text subject is the exception the rationale draws itself: bare values
-- there are substring claims, and two substrings can both describe one row,
-- so they stay the conjunction the reader wrote.
local function alternateWhereSingle(head, runs)
	if head.role ~= "kind" or head.kind.single ~= true then
		return runs
	end
	local subject = head.kind.props and head.kind.props[1]
	if subject then
		for _, held in ipairs(subject.types) do
			if held == "text" or held == "path" then
				return runs
			end
		end
	end
	local out = {}
	for _, run in ipairs(runs) do
		local loose, rest = {}, {}
		for _, term in ipairs(run) do
			if statesBareValue(term) then
				loose[#loose + 1] = term
			else
				rest[#rest + 1] = term
			end
		end
		if #loose < 2 then
			out[#out + 1] = run
		else
			for _, term in ipairs(loose) do
				local option = { term }
				for _, other in ipairs(rest) do
					option[#option + 1] = other
				end
				out[#out + 1] = option
			end
		end
	end
	return out
end

--- A row scope after the head's colon: `head:{inner}`. The inner terms are
-- again alternation groups of conjunctions, each term a bind the head
-- resolves or a bare value, and one row must satisfy a whole conjunction. A
-- brace inside the scope has nothing to refer to and refuses the clause. A
-- run of nothing but negations is refused too: inside a scope negation
-- refines and needs a positive anchor. A scope never closed runs to the end
-- of the text, with a warning.
-- @param start where the clause began
-- @param negated whether the clause is excluded
-- @param head the column or kind head
-- @param brace the position of the opening brace
-- @param limit the end of the text
-- @return the position to continue from
function Parser:scope(start, negated, head, brace, limit)
	local grammar = Schema.grammar
	local open, close = grammar.scope.open, grammar.scope.close
	local i, closeAt, inner = brace + 1, nil, nil
	while i <= limit do
		local c = self:char(i)
		if c == grammar.escape and i < limit then
			i = i + 2
		elseif c == grammar.phrase then
			local _, stop = scanPhrase(self.text, i, limit)
			i = stop
		elseif c == open then
			inner = inner or i
			i = i + 1
		elseif c == close then
			if not inner then
				closeAt = i
			end
			break
		else
			i = i + 1
		end
	end
	if inner then
		local stop = self:skipBraces(brace, limit)
		self:push({ start = start, stop = stop - 1 }, negated, "invalid", nil, {
			{ message = "a scope inside a scope has nothing to refer to" },
		})
		return stop
	end
	local bodyEnd = closeAt and closeAt - 1 or limit
	local after = closeAt and closeAt + 1 or limit + 1
	local problems = {}
	local runs, run = {}, {}
	i = brace + 1
	while i <= bodyEnd do
		local c = self:char(i)
		if isWs(c) then
			i = i + 1
		elseif c == grammar["or"] then
			runs[#runs + 1] = run
			run = {}
			i = i + 1
		else
			local word = self:orWordEnd(i, bodyEnd)
			if word > i then
				runs[#runs + 1] = run
				run = {}
				i = word
			else
				local termNot, skip = false, false
				local nextChar = i < bodyEnd and self:char(i + 1) or ""
				if c == grammar.negate and not nextChar:match("^[%d.]") then
					if nextChar == "" or isWs(nextChar) or nextChar == grammar["or"] then
						problems[#problems + 1] = { message = "the minus excludes nothing" }
						run[#run + 1] = { ["not"] = true, state = "incomplete" }
						i, skip = i + 1, true
					else
						termNot, i = true, i + 1
					end
				end
				if not skip then
					local stop, foreign = self:innerItem(head, termNot, i, bodyEnd, run, problems)
					if foreign then
						problems[#problems + 1] = { message = foreign }
						self:push(
							{ start = start, stop = after - 1 },
							negated,
							"invalid",
							nil,
							problems
						)
						return after
					end
					i = stop > i and stop or i + 1
				end
			end
		end
	end
	runs[#runs + 1] = run
	runs = alternateWhereSingle(head, runs)
	for _, each in ipairs(runs) do
		local ok, anchored = 0, false
		for _, term in ipairs(each) do
			if term.state == "ok" then
				ok = ok + 1
				if not term["not"] then
					anchored = true
				end
			end
		end
		if ok > 0 and not anchored then
			problems[#problems + 1] =
				{ message = "a scope needs a positive term; a negation inside it only refines" }
			self:push({ start = start, stop = after - 1 }, negated, "invalid", nil, problems)
			return after
		end
	end
	if not closeAt then
		problems[#problems + 1] = { severity = "warning", message = "the scope is not closed" }
	end
	local test = { is = "scope", terms = runs }
	local ask
	if head.role == "column" then
		ask = { on = "column", column = head.column, test = test }
	else
		ask = { on = "kind", kind = head.kind, test = test }
	end
	self:push({ start = start, stop = after - 1 }, negated, "ok", ask, problems)
	return after
end

--- `head:` and whatever follows the colon.
function Parser:bound(start, negated, head, vpos, limit)
	local c = vpos <= limit and self:char(vpos) or ""
	if c == "" or isWs(c) then
		self:push(
			{ start = start, stop = vpos - 1 },
			negated,
			"invalid",
			nil,
			{ { message = Schema.HeadWord(head) .. Schema.grammar.bind .. " needs a value" } }
		)
		return vpos
	end
	local refused = self.refused[c]
	if refused then
		local _, stop = self:token(vpos, limit)
		self:push(
			{ start = start, stop = stop - 1 },
			negated,
			"invalid",
			nil,
			{ { message = refused } }
		)
		return stop
	end
	if c == Schema.grammar.scope.open then
		if head.role == "prop" then
			local stop = self:skipBraces(vpos, limit)
			self:push({ start = start, stop = stop - 1 }, negated, "invalid", nil, {
				{ message = Schema.HeadWord(head) .. " takes a value, not a scope" },
			})
			return stop
		end
		return self:scope(start, negated, head, vpos, limit)
	end
	if head.role ~= "prop" then
		local glued = self:innerGlue(start, negated, head, vpos, limit)
		if glued then
			return glued
		end
	end
	local segs, stop = self:token(vpos, limit)
	local problems = {}
	local main, extras, last = self:interpretSegs(segs, ctxFor(head), problems)
	self:pushInterp({ start = start, stop = last or stop - 1 }, negated, head, main, problems)
	self:emitExtras(extras)
	return stop
end

--- An ordering directive: `sort:` and a door word, which must resolve to
-- a head -- a column, a kind or a property. The exclusion before the word
-- or before the sort word means the other way round, and both together mean
-- it still: `sort:-cast`, `-sort:cast`, `-sort:-cast`. The directive is kept
-- apart from the clauses, since it selects nothing. A bare `sort` orders by
-- the default door, the spell's id.
-- @param vpos where the door word starts, or nil for a bare sort
-- @return the position to continue from
function Parser:sorted(start, negated, vpos, limit)
	local grammar = Schema.grammar
	local text, stop = grammar.sortDefault, vpos
	if vpos then
		local segs
		segs, stop = self:token(vpos, limit)
		text = segs[1] and segs[1].form == "bare" and segs[1].text or ""
	else
		stop = start + #grammar.sortWord + (negated and #grammar.negate or 0)
	end
	local descending = negated
	if text:sub(1, #grammar.negate) == grammar.negate then
		descending = true
		text = text:sub(#grammar.negate + 1)
	end
	local head = text ~= "" and Schema.HeadOf(Text.fold(text)) or nil
	local span = { start = start, stop = stop - 1 }
	if not head then
		local example = grammar.sortWord .. grammar.bind
		self:push(span, negated, "invalid", nil, {
			{
				message = grammar.sortWord
					.. " takes a head word, as in "
					.. example
					.. "name or "
					.. example
					.. grammar.negate
					.. "model",
			},
		})
		return stop
	end
	self.sorts[#self.sorts + 1] = { head = head, descending = descending, span = span }
	return stop
end

--- The results-limiting directive: the limit word and a whole number. A
-- display directive like the sort -- it selects nothing, the count stays the
-- query's truth, and only what is listed trims. The last one written wins;
-- a negated or numberless one is refused, since neither has a reading.
function Parser:limited(start, negated, vpos, limit)
	local grammar = Schema.grammar
	local segs, stop = self:token(vpos, limit)
	local text = segs[1] and segs[1].form == "bare" and segs[1].text or ""
	local count = text:match("^%d+$") and tonumber(text) or nil
	local span = { start = start, stop = stop - 1 }
	if negated or not count or count < 1 then
		self:push(span, negated, "invalid", nil, {
			{ message = grammar.limitWord .. " takes how many to list, as in " .. grammar.limitWord .. grammar.bind .. "20" },
		})
		return stop
	end
	self.limit = count
	return stop
end

--- One clause starting at `i`. Returns the position to continue from.
function Parser:clause(i, limit)
	local grammar = Schema.grammar
	local start = i
	local negated = false
	if self:char(i) == grammar.negate then
		local nextChar = i < limit and self:char(i + 1) or ""
		if nextChar == "" or isWs(nextChar) or nextChar == grammar["or"] then
			self:push(
				{ start = start, stop = i },
				true,
				"invalid",
				nil,
				{ { message = "the minus excludes nothing" } }
			)
			return i + 1
		end
		negated = true
		i = i + 1
	end
	local j = self:wordEnd(i, limit)
	if j > i then
		local word = Text.fold(sub(self.text, i, j - 1))
		if word == grammar.sortWord then
			local after = j <= limit and self:char(j) or ""
			if after == grammar.bind then
				return self:sorted(start, negated, j + 1, limit)
			elseif after == "" or isWs(after) then
				return self:sorted(start, negated, nil, limit)
			end
		end
		if
			(word == grammar.limitWord or isLimitRead(word))
			and j <= limit
			and self:char(j) == grammar.bind
		then
			return self:limited(start, negated, j + 1, limit)
		end
		local head = Schema.HeadOf(word)
		if head then
			local c = j <= limit and self:char(j) or ""
			if c == grammar.bind then
				return self:bound(start, negated, head, j + 1, limit)
			end
			if Schema.comparisonStarts[c] then
				return self:bound(start, negated, head, j, limit)
			end
		end
	end
	return self:term(start, negated, i, limit)
end

--- Parse the whole text.
function Parser:run()
	local or_ = Schema.grammar["or"]
	local limit = #self.text
	local i = 1
	while i <= limit do
		local c = self:char(i)
		if isWs(c) then
			i = i + 1
		elseif c == or_ then
			self:closeRun()
			i = i + 1
		else
			local word = self:orWordEnd(i, limit)
			if word > i then
				self:closeRun()
				i = word
			else
				local stop = self:clause(i, limit)
				i = stop > i and stop or i + 1
			end
		end
	end
	self:closeRun()
	return {
		text = self.text,
		clauses = self.clauses,
		groups = self.groups,
		sorts = self.sorts,
		limit = self.limit,
		problems = self.problems,
	}
end

--- Parse query text.
-- @param text the query as typed
-- @return the parse: clauses, the alternation groups over them (disjunctive
--   normal form, as indices into clauses), the sort directives in order, the
--   problems found, and the text the positions index
function Query.Parse(text)
	countCtx = countCtx or typedCtx(Schema.COUNT_PROP, Schema.grammar.countWord, counted)
	return newParser(Text.foldTypography(linksToIds(text))):run()
end

--- Whether an expression writes its own operator symbol, so no colon separates it from its head.
local function symbolled(expr)
	local op = Schema.operators[expr.op]
	return op ~= nil and op.symbol ~= nil and op.form == "prefix"
end

--- An operand written back, quoted where it carries a space or a quote.
local function quoted(operand)
	local grammar = Schema.grammar
	local written = Query.OperandText(operand)
	if written:find("%s") or written:find(grammar.phrase, 1, true) then
		local escaped = written:gsub(grammar.phrase, grammar.escape .. grammar.phrase)
		return grammar.phrase .. escaped .. grammar.phrase
	end
	return written
end

--- One value expression written back as query text.
local function formatExpr(expr)
	local grammar = Schema.grammar
	if expr.op == "present" then
		return grammar.wildcard
	elseif expr.op == "anyOf" then
		local parts = {}
		for _, alt in ipairs(expr.alternatives) do
			parts[#parts + 1] = formatExpr(alt)
		end
		return table.concat(parts, grammar["or"])
	elseif expr.op == "range" then
		return Query.OperandText(expr.lo) .. grammar.range .. Query.OperandText(expr.hi)
	elseif expr.op == "contains" then
		return quoted(expr.operand)
	end
	return Schema.operators[expr.op].symbol .. quoted(expr.operand)
end

--- One scope term written back: its word and value, the exclusion before it.
local function formatTerm(term)
	local grammar = Schema.grammar
	local ask = term.ask
	local out
	if ask.on == "kindWord" then
		out = ask.kind.word
	elseif ask.on == "content" then
		out = formatExpr(ask.value)
	elseif ask.on == "count" then
		out = grammar.countWord
			.. (symbolled(ask.value) and "" or grammar.bind)
			.. formatExpr(ask.value)
	else
		local prop = ask.props[1].prop
		out = prop.name .. (symbolled(ask.value) and "" or grammar.bind) .. formatExpr(ask.value)
	end
	if term["not"] then
		out = grammar.negate .. out
	end
	return out
end

--- A scope's runs written back inside braces, terms a space apart and runs
-- an or apart; the terms that do not run are left out.
local function formatScope(runs)
	local grammar = Schema.grammar
	local groups = {}
	for _, run in ipairs(runs) do
		local words = {}
		for _, term in ipairs(run) do
			if term.state == "ok" and term.ask then
				words[#words + 1] = formatTerm(term)
			end
		end
		groups[#groups + 1] = table.concat(words, " ")
	end
	return grammar.scope.open
		.. table.concat(groups, " " .. grammar["or"] .. " ")
		.. grammar.scope.close
end

--- One clause written back as query text.
-- The operator replaces the colon on a bind that has one: `cast>2s`, never
-- `cast:>2s`. An inner bind keeps its property's name: `model:file=foo`. A
-- kind's existence is spelled through its column, which is the shortest form
-- the language has for it.
local function formatClause(clause)
	local grammar = Schema.grammar
	local ask = clause.ask
	if not ask then
		return nil
	end
	local out
	if ask.on == "plain" then
		out = formatExpr(ask.value)
	elseif ask.on == "prop" then
		local head = ask.ref.prop.door or (ask.ref.kind.word .. grammar.bind .. ask.ref.prop.name)
		out = head .. (symbolled(ask.value) and "" or grammar.bind) .. formatExpr(ask.value)
	else
		local test = ask.test
		local head
		if ask.on == "column" then
			head = ask.column
		elseif ask.kind.global then
			head = ask.kind.word
		else
			head = ask.kind.column .. grammar.bind .. ask.kind.word
		end
		if test.is == "exists" then
			out = ask.on == "column" and (head .. grammar.bind .. grammar.wildcard)
				or (ask.kind.column .. grammar.bind .. ask.kind.word)
		elseif test.is == "scope" then
			out = head .. grammar.bind .. formatScope(test.terms)
		elseif ask.inner then
			local word = test.is == "count" and grammar.countWord or test.props[1].prop.name
			out = head .. grammar.bind .. word .. formatExpr(test.value)
		else
			out = head .. (symbolled(test.value) and "" or grammar.bind) .. formatExpr(test.value)
		end
	end
	if clause["not"] then
		out = grammar.negate .. out
	end
	return out
end

--- Write a parse back as query text, one clause a word, `|` between groups,
-- the sort directives after in their order.
-- @param parsed a parse
-- @return the text
function Query.Format(parsed)
	local grammar = Schema.grammar
	local groups = {}
	for _, group in ipairs(parsed.groups) do
		local words = {}
		for _, index in ipairs(group) do
			words[#words + 1] = formatClause(parsed.clauses[index])
		end
		groups[#groups + 1] = table.concat(words, " ")
	end
	local out = table.concat(groups, " " .. grammar["or"] .. " ")
	for _, sort in ipairs(parsed.sorts) do
		local word = grammar.sortWord
			.. grammar.bind
			.. (sort.descending and grammar.negate or "")
			.. Schema.HeadWord(sort.head)
		out = out == "" and word or (out .. " " .. word)
	end
	return out
end

return Query

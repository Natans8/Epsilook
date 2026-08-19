--- The parser: query text in, a tree of plain data out.
--
-- The tree is the one the web engine's parser emits, cut down to the grammar
-- the addon carries: plain terms, `head:value`, `-` to exclude, `|` or `or`
-- between clauses, a quoted phrase, a comparison, a range, a comma list and
-- `*` for existence. Row scopes in braces, alternatives in parentheses and
-- patterns are refused with a message rather than read, so a query that parses
-- here means the same thing on the web.
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

--- The interpretations of a value, as the web's parser names them.
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
				local a, b = Schema.ParseTypePair(typeName, lo, hi)
				if a == nil then
					a, b = Schema.ParseType(typeName, lo), Schema.ParseType(typeName, hi)
				end
				if a ~= nil and b ~= nil then
					return done({
						op = "range",
						lo = typed(typeName, a, lo),
						hi = typed(typeName, b, hi),
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
				return done(opExpr(op.name, typed(typeName, value, operand)))
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
			return done(opExpr("contains", typed(typeName, value, text)))
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
			return props(textual, opExpr("contains", { text = text }))
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
		return content(opExpr("contains", { text = text }))
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
	phrase = asContent,
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
		return fail("patterns are not supported here; the web app reads them")
	end
	return ctx.bare(text, alone)
end

--- Read a bare segment: glued alternation split, then each alternative read.
local function bareAlternatives(text, ctx)
	local real = {}
	local or_ = Schema.grammar["or"]
	local escaped = or_:gsub("%p", "%%%0")
	for part in (text .. or_):gmatch("([^" .. escaped .. "]*)" .. escaped) do
		if part ~= "" then
			real[#real + 1] = part
		end
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
	-- Values opening with a bracket read as a construct this grammar left out.
	self.refused = {
		[grammar.scope.open] = "row scopes in braces are not supported here; the web app reads them",
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
	while i <= limit do
		local c = self:char(i)
		if isWs(c) then
			break
		end
		if c == phrase then
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
		local head = Schema.HeadOf(Text.fold(sub(self.text, i, j - 1)))
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
		problems = self.problems,
	}
end

--- Parse query text.
-- @param text the query as typed
-- @return the parse: clauses, the alternation groups over them (disjunctive
--   normal form, as indices into clauses), the problems found, and the text
--   the positions index
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

--- One clause written back as query text.
-- The operator replaces the colon on a bind that has one: `cast>2s`, never
-- `cast:>2s`. An inner bind keeps its property's name: `model:file=foo`. A
-- kind's existence is spelled through its column, the shortest form the web's
-- simplifier converges on.
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

--- Write a parse back as query text, one clause a word, `|` between groups.
-- @param parsed a parse
-- @return the text
function Query.Format(parsed)
	local groups = {}
	for _, group in ipairs(parsed.groups) do
		local words = {}
		for _, index in ipairs(group) do
			words[#words + 1] = formatClause(parsed.clauses[index])
		end
		groups[#groups + 1] = table.concat(words, " ")
	end
	return table.concat(groups, " " .. Schema.grammar["or"] .. " ")
end

return Query

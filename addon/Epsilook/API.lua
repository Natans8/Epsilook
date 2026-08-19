--- Epsilook's public surface: pure data, no presentation.
--
-- Everything a caller can ask Epsilook is here, and nothing here knows what
-- will be done with the answer. A chat command renders these tables as
-- bracketed links; a frame renders them as rows and buttons; another addon may
-- read them and render nothing at all. One engine, several interfaces, and
-- what keeps that true is that this file never names a frame, a colour, a link
-- or a chat channel.
--
-- Naming follows the library this client already carries: `GetNum*` for a
-- count, `Get*DataBy*(key, target)` for a record with an optional table to
-- fill, `Get*By*` for one field, `Find*` for a search returning an iterator,
-- `Is*` for a predicate.
--
-- Nothing here performs anything. A record carries the ids an action would
-- need and `GetActions` says which actions an axis affords, but doing one is
-- the caller's business: the same list is safe to click in a frame and unsafe
-- to click from old chat scrollback, and only the interface knows which it is.
--
-- The raw payload stays reachable at `Epsilook.data`, `Epsilook.index` and
-- `Epsilook.schema` on purpose, with the reader and the layers beside them.
-- This surface is the supported way to ask a question; the tables underneath
-- are there to be read, dumped and explored.
--
-- The data loads on first use. Every call here mounts it if it is not mounted,
-- so a macro can ask a question without a step before it; `LoadData` is the
-- explicit door for a caller that wants the cost up front.
--
-- Records:
--   SpellData   id, name, subtext, icon, iconName, schoolID, school, expansion
--   SpellText   description, aura, encounter
--   PartData    axis, kind, slot, values (property name to value; a named
--               property is a table of id and text)
--   Action      key, label, needs, effect, revert
--   DataInfo    pack, built, format, variation, homes

_G.Epsilook = _G.Epsilook or {}
local Epsilook = _G.Epsilook

local Data = Epsilook.Data
local Reader = Epsilook.Reader
local Schema = Epsilook.Schema
local Query = Epsilook.Query
local Search = Epsilook.Search

--- Which promise this surface keeps.
-- Raised when a field changes meaning or leaves, never when one is added, so a
-- consumer can test it once and rely on what it read.
Epsilook.API_VERSION = 1

--- Whether the payload is mounted and the declarations indexed.
function Epsilook:IsDataLoaded()
	return Data.IsLoaded() and Schema.IsLoaded()
end

--- Mount the data and index the declarations, once.
-- @return true, or false and a reason
function Epsilook:LoadData()
	if self:IsDataLoaded() then
		return true
	end
	local ok, reason = Data.Load()
	if not ok then
		return false, reason
	end
	ok, reason = Schema.Load(Data.GetSchema())
	if not ok then
		return false, reason
	end
	Schema.SetLadder(Search.Ladder())
	Search.Reset()
	return true
end

--- The data, mounted; raises where it cannot be, since every caller below
-- would otherwise fail one step later with less to say.
local function mounted(self)
	local ok, reason = self:LoadData()
	if not ok then
		error("Epsilook: " .. tostring(reason), 3)
	end
end

--- What the payload holds and where it came from.
-- @param target an optional table to fill instead of allocating one
-- @return a DataInfo, or nil where nothing could be mounted
function Epsilook:GetDataInfo(target)
	if not self:LoadData() then
		return nil
	end
	return Data.GetInfo(target)
end

--- Every axis the payload is split across, in the order it ships them.
-- These are files, not questions: some carry a spell's parts and some carry
-- the spell itself. `GetPartAxes` is the one a dossier walks.
function Epsilook:GetAxes()
	mounted(self)
	return Data.GetAxes()
end

--- The axes a spell can be inspected on, in the order a dossier shows them.
function Epsilook:GetPartAxes()
	mounted(self)
	return Data.GetPartAxes()
end

--- How many spells this build carries.
function Epsilook:GetNumSpells()
	mounted(self)
	return Data.GetNumSpells()
end

--- The row a spell id sits at, for the by-index calls.
-- @param spellID the spell id
-- @return a row counted from zero, or nil where this build has no such spell
function Epsilook:GetSpellIndexByID(spellID)
	mounted(self)
	return Data.GetSpellIndexByID(spellID)
end

--- One row of a column, from whichever axis file carries its section.
-- @return the value, or the fallback where the column is absent or the row is outside it
local function cell(section, column, row, fallback)
	local axis = Data.GetAxisOf(section)
	if not axis then
		return fallback
	end
	local node, blob = Data.GetColumn(axis, section, column)
	if not node or row < 0 or row >= Reader.size(node) then
		return fallback
	end
	return Reader.value(blob, node, row)
end

--- What each bit of a spell's school mask is called.
-- Seven values that have not changed since the game shipped, so they are a
-- table here rather than a section in the payload.
local SCHOOLS = {
	[1] = "Physical",
	[2] = "Holy",
	[4] = "Fire",
	[8] = "Nature",
	[16] = "Frost",
	[32] = "Shadow",
	[64] = "Arcane",
}

--- One spell's name.
-- @param spellID the spell id
-- @return the name, or nil where this build has no such spell
function Epsilook:GetSpellNameByID(spellID)
	local row = self:GetSpellIndexByID(spellID)
	if not row then
		return nil
	end
	return cell("spells", "names", row, nil)
end

--- One spell's whole record, by row.
-- @param index a row counted from zero
-- @param target an optional table to fill instead of allocating one
-- @return a SpellData, or nil where the row is outside this build
function Epsilook:GetSpellDataByIndex(index, target)
	mounted(self)
	local ids, blob = Data.GetColumn("spell", "spells", "ids")
	if not ids or index < 0 or index >= Reader.size(ids) then
		return nil
	end
	local out = target or {}
	out.id = Reader.number(blob, ids, index)
	out.name = cell("spells", "names", index, "")
	out.subtext = cell("spells", "subtexts", index, "")
	-- The spell carries an index into the pack's icon pool rather than a file
	-- id, because thousands of spells share a few thousand icons; both the id
	-- and the name are one lookup from it.
	local at = Data.GetIconRow(index)
	out.icon = at and cell("iconFids", "fids", at, 0) or 0
	out.iconName = at and cell("iconNames", "names", at, "") or ""
	out.schoolID = cell("spells", "schools", index, 0)
	out.school = SCHOOLS[out.schoolID] or ""
	local era = cell("spells", "eras", index, -1)
	local labels = Data.ReadAll("spell", "expansions", "labels") or {}
	out.expansion = era >= 0 and labels[era + 1] or ""
	return out
end

--- One spell's whole record, by id.
-- @param spellID the spell id
-- @param target an optional table to fill instead of allocating one
-- @return a SpellData, or nil where this build has no such spell
function Epsilook:GetSpellDataByID(spellID, target)
	local row = self:GetSpellIndexByID(spellID)
	if not row then
		return nil
	end
	return self:GetSpellDataByIndex(row, target)
end

--- The prose the pack cooked for a spell: its description, what its aura
-- says while it is on you, and its encounter text, each empty where the
-- spell has none. The aura text is what a buff's tooltip shows.
-- @param spellID the spell id
-- @param target an optional table to fill instead of allocating one
-- @return a table with description, aura, encounter; or nil where there is no such spell
function Epsilook:GetSpellTextByID(spellID, target)
	local row = self:GetSpellIndexByID(spellID)
	if not row then
		return nil
	end
	local out = target or {}
	for name, column in pairs({
		description = "descriptions",
		aura = "auras",
		encounter = "encounters",
	}) do
		local node, blob = Data.GetColumn("text", "spellText", column)
		local slot = node and Reader.number(blob, node.of, row) or 0
		out[name] = slot > 0 and Reader.text(blob, node.pool, slot) or ""
	end
	return out
end

--- How many rows of each axis a spell has.
-- What a result line shows to say what a spell is made of, and what a dossier
-- head counts. One pass over the axes rather than a call each.
-- @param spellID the spell id
-- @param target an optional table to fill instead of allocating one
-- @return a table of axis name to count, or nil where there is no such spell
function Epsilook:GetPartCounts(spellID, target)
	local row = self:GetSpellIndexByID(spellID)
	if not row then
		return nil
	end
	local out = target or {}
	for _, axis in ipairs(Data.GetPartAxes()) do
		out[axis] = Data.GetNumRows(axis, row)
	end
	return out
end

--- How many rows of one axis a spell has.
-- @param spellID the spell id
-- @param axis one of GetPartAxes()
-- @return a count, zero where the spell has none
function Epsilook:GetNumParts(spellID, axis)
	local row = self:GetSpellIndexByID(spellID)
	if not row then
		return 0
	end
	return Data.GetNumRows(axis, row)
end

--- One part of one spell: the n'th row it has on an axis.
-- The row's properties are read by name as the catalogue declares them and
-- resolved the way the web engine resolves them: a property whose first two
-- notations are an id and a name carries both, one whose number names a
-- vocabulary entry carries that entry, and any other carries its number. One
-- generic read, no per-kind code.
-- @param spellID the spell id
-- @param axis one of GetPartAxes()
-- @param n which of the spell's rows on that axis, counted from one
-- @param target an optional table to fill instead of allocating one
-- @return a PartData, or nil where the spell has no such row
function Epsilook:GetPartDataByIndex(spellID, axis, n, target)
	local row = self:GetSpellIndexByID(spellID)
	if not row then
		return nil
	end
	local at, count = Data.GetRowRange(axis, row)
	if not at or n < 1 or n > count then
		return nil
	end
	local refs, blob = Data.GetColumn(axis, axis .. "Rows", "refs")
	local ref = Reader.number(blob, refs, at + n - 1)
	local kindWord, slot = Data.LocateRow(axis, ref)
	local kind = kindWord and Schema.kindById[axis .. "." .. kindWord]
	if not kind then
		return nil
	end
	local out = target or {}
	out.axis, out.kind, out.slot = axis, kindWord, slot
	local values = {}
	out.values = values
	for _, prop in ipairs(kind.props) do
		local stored = Data.GetStored(axis, kindWord, slot, prop.name)
		if stored ~= nil then
			local vocab = Data.GetVocabName(axis, kindWord, prop.name)
			local resolved = vocab and Data.ResolveVocab(vocab, stored)
			if Schema.IsNamed(prop) then
				values[prop.name] = type(resolved) == "string" and { id = stored, text = resolved }
					or stored
			elseif vocab then
				values[prop.name] = resolved
			else
				values[prop.name] = stored
			end
		end
	end
	return out
end

--- A spell's stored value of one property, written the way a pill prints it.
-- @param kindWord the kind's word, as PartData.kind carries it
-- @param axis the axis
-- @param propName the property
-- @param value the value, as PartData.values carries it
-- @return the text
function Epsilook:FormatPartValue(axis, kindWord, propName, value)
	local kind = Schema.kindById[axis .. "." .. kindWord]
	local prop = kind and kind.propByName[propName]
	if not prop then
		return tostring(value)
	end
	if type(value) == "table" then
		return value.text
	end
	return Schema.FormatValue(prop, value)
end

--- The id that places a model in the world, by its file id.
-- What `.gob spawn` takes, and nought where no gameobject display is known
-- for the file. Negative where the command reads the sign: a positive number
-- is a gameobject template, a negative one a display.
-- @param fid the model's file id
-- @return the spawn id, or nil where the file is unknown
function Epsilook:GetSpawnIDByFile(fid)
	mounted(self)
	return Data.Lookup("model", "files", "fids", "gobs", fid)
end

--- The Epsilon emotes performing an animation, by animation id.
-- @param animID the animation id
-- @return the one-shot emote id and the looping emote id, each nought where none exists
function Epsilook:GetEmotesByAnim(animID)
	mounted(self)
	return cell("animEmoteOneshots", "emotes", animID, 0),
		cell("animEmoteLoops", "emotes", animID, 0)
end

--- What an interface may offer for a part of one axis.
-- Declared once and read by every interface, so a chat line and a frame cannot
-- disagree about what a model affords, nor about which of those changes the
-- world. `effect` is "read" where repeating it is harmless and offering it from
-- stale output is safe, and "world" where neither is true. `needs` names the
-- PartData value the action takes.
-- @param axis one of GetPartAxes()
-- @return an array of Action, empty where the axis affords nothing
function Epsilook:GetActions(axis)
	return Epsilook.ACTIONS[axis] or {}
end

Epsilook.ACTIONS = {
	model = {
		{ key = "spawn", label = "Spawn", needs = "file", effect = "world", revert = "" },
	},
	sound = {
		{ key = "play", label = "Play", needs = "file", effect = "read", revert = "stop" },
		{ key = "stop", label = "Stop", needs = "file", effect = "read", revert = "" },
		{ key = "playKit", label = "Play Kit", needs = "kit", effect = "read", revert = "stopKit" },
		{ key = "stopKit", label = "Stop Kit", needs = "kit", effect = "read", revert = "" },
	},
	anim = {
		{ key = "anim", label = "Anim", needs = "anim", effect = "world", revert = "resetAnim" },
		{ key = "stand", label = "Stand", needs = "anim", effect = "world", revert = "resetStand" },
		{ key = "animkit", label = "Kit", needs = "id", effect = "world", revert = "" },
		{ key = "resetAnim", label = "Reset", needs = "", effect = "world", revert = "" },
		{ key = "resetStand", label = "Reset", needs = "", effect = "world", revert = "" },
	},
}

--- Parse query text.
-- @param text the query as typed
-- @return the query, opaque, and a list of problems each with message, at and length;
--   the query evaluates what parsed and ignores what did not
function Epsilook:ParseQuery(text)
	mounted(self)
	local tree = Query.Parse(text)
	return tree, tree.problems
end

--- A parsed query written back as text.
-- @param query a query from ParseQuery
-- @return the text
function Epsilook:FormatQuery(query)
	mounted(self)
	return Query.Format(query)
end

--- Whether a parsed query asks anything at all.
-- @param query a query from ParseQuery
-- @return true where at least one clause evaluates
function Epsilook:IsQueryEmpty(query)
	return #query.groups == 0
end

--- The query language as data, for a help surface: the columns with their
-- hints, every top-level head with its role and hint, and the operators.
-- Read off the declarations the data carries, so it cannot fall behind them.
-- @return a table with columns, heads, operators
function Epsilook:GetQueryHelp()
	mounted(self)
	local columns = {}
	for _, column in ipairs(Schema.columns) do
		columns[#columns + 1] = { key = column.key, label = column.label, hint = column.hint }
	end
	local heads = {}
	for word, head in pairs(Schema.heads) do
		local hint
		if head.role == "column" then
			hint = Schema.columnByKey[head.column].hint
		elseif head.role == "kind" then
			hint = head.kind.hint
		else
			hint = head.prop.hint
		end
		heads[#heads + 1] = { word = word, role = head.role, hint = hint }
	end
	table.sort(heads, function(a, b)
		return a.word < b.word
	end)
	local operators = {}
	for _, op in ipairs(Schema.prefixOperators) do
		operators[#operators + 1] = { symbol = op.symbol, hint = op.hint }
	end
	return { columns = columns, heads = heads, operators = operators }
end

--- The spells satisfying a query, one per call.
-- @param query text, or a query from ParseQuery
-- @param fromIndex the spell row to start at, counted from zero; nil for the first
-- @param slice how many spells one call may examine before returning false to
--   let the caller yield, or nil to return only hits and the end
-- @return an iterator yielding the spell's row and its id, false on a pause, then nil
function Epsilook:FindSpells(query, fromIndex, slice)
	mounted(self)
	return Search.Find(query, fromIndex, slice)
end

--- How many spells satisfy a query. A full walk.
-- @param query text, or a query from ParseQuery
function Epsilook:GetNumMatches(query)
	mounted(self)
	return Search.Count(query)
end

--- Whether one spell satisfies a query.
-- @param query text, or a query from ParseQuery
-- @param spellID the spell id
function Epsilook:IsMatch(query, spellID)
	mounted(self)
	return Search.Matches(query, spellID)
end

return Epsilook

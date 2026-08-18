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
-- count, `Get*DataBy*` for a whole record with an optional table to fill,
-- `Get*By*` for one field, `Find*` for a search returning an iterator, `Is*`
-- for a predicate.
--
-- Nothing here performs anything. A record carries the ids an action would
-- need and `GetActions` says which actions an axis affords, but doing one is
-- the caller's business: the same list is safe to click in a frame and unsafe
-- to click from old chat scrollback, and only the interface knows which it is.
--
-- The raw payload stays reachable at `Epsilook.data` and `Epsilook.index` on
-- purpose. This surface is the supported way to ask a question; the tables
-- underneath are there to be read, dumped and explored.
--
-- ## Records
--
-- SpellData   id, name, subtext, icon, iconName, iconIndex, schoolID, school
-- PartData    axis, kind, values, named, ids
-- Action      key, label, needs, effect, revert
-- DataInfo    pack, built, variation, supplied, absent
--
-- A part carries its properties twice and neither is a spelling of the other.
-- `values` holds what the pack stores, which is the id an action takes, and
-- `named` holds what that number's vocabulary made of it, which is what a
-- person reads. A property with no vocabulary appears only in `values`. They
-- are flat tables of the same keys or fewer, so neither has a shape to test
-- for, and a caller reads whichever half its question is about.
--
-- Property ORDER is not carried, because the payload does not carry it: the
-- columns are a table and Lua does not order one. Which property leads is a
-- rendering decision in any case, and rendering is not this file's business.

local _, ns = ...

local Epsilook = _G.Epsilook or {}
_G.Epsilook = Epsilook

local Data = (ns and ns.Data) or Epsilook.Data
local Reader = (ns and ns.Reader) or Epsilook.Reader

--- Which promise this surface keeps.
-- Raised when a field changes meaning or leaves, never when one is added, so a
-- consumer can test it once and rely on what it read.
Epsilook.API_VERSION = 1

--- Whether the payload is loaded and can be asked anything.
function Epsilook:IsDataLoaded()
	return Data ~= nil and Data.IsLoaded()
end

--- What the payload holds and what it leaves to the client.
-- @param target an optional table to fill instead of allocating one
-- @return a DataInfo, or nil before the payload is loaded
function Epsilook:GetDataInfo(target)
	return Data and Data.GetInfo(target)
end

--- Every axis the payload is split across, in the order it ships them.
-- These are files, not questions: some carry a spell's parts and some carry
-- the spell itself. `GetPartAxes` is the one a dossier walks.
-- @return an array of axis names
function Epsilook:GetAxes()
	return Data and Data.GetAxes() or {}
end

--- The axes a spell can be inspected on, in the order a dossier shows them.
-- An axis is inspectable when it carries a row family, which the payload says
-- for itself rather than being listed here a second time.
-- @return an array of axis names
function Epsilook:GetPartAxes()
	return Data and Data.GetPartAxes() or {}
end

--- How many spells this build carries.
function Epsilook:GetNumSpells()
	return Data and Data.GetNumSpells() or 0
end

--- The row a spell id sits at, for the by-index calls.
-- @param spellID the spell id
-- @return a row counted from zero, or nil where this build has no such spell
function Epsilook:GetSpellIndexByID(spellID)
	return Data and Data.GetSpellIndexByID(spellID)
end

--- One column of the spell section, by row.
local function field(column, row, fallback)
	local node, blob = Data.GetColumn("spells", column)
	if not node or row >= Reader.size(node) then
		return fallback
	end
	return Reader.value(blob, node, row)
end

--- One row of a section that ships as a single bare column.
local function bare(section, column, row)
	local node, blob = Data.GetColumn(section, column)
	if not node or row < 0 or row >= Reader.size(node) then
		return nil
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
	return field("names", row, nil)
end

--- One spell's whole record, by row.
-- @param index a row counted from zero
-- @param target an optional table to fill instead of allocating one
-- @return a SpellData, or nil where the row is outside this build
function Epsilook:GetSpellDataByIndex(index, target)
	if not Data then
		return nil
	end
	local ids, blob = Data.GetColumn("spells", "ids")
	if not ids or index < 0 or index >= Reader.size(ids) then
		return nil
	end
	local out = target or {}
	out.id = Reader.number(blob, ids, index)
	out.name = field("names", index, "")
	out.subtext = field("subtexts", index, "")
	-- The spell carries an INDEX into the pack's icon pool rather than a file
	-- id, because thousands of spells share a few thousand icons. Both the id
	-- and the name are one lookup from it, and both are what a caller wants:
	-- the id draws the texture, the name is what a person searches for.
	-- Counted from one, so that nought can mean the spell has no icon at all.
	-- Read as though it were counted from zero it is off by one, and the
	-- wrong icon is not a thing anybody notices by looking.
	out.iconIndex = field("icons", index, 0)
	local at = out.iconIndex - 1
	out.icon = out.iconIndex > 0 and bare("iconFids", "fids", at) or 0
	out.iconName = out.iconIndex > 0 and bare("iconNames", "names", at) or ""
	out.schoolID = field("schools", index, 0)
	out.school = SCHOOLS[out.schoolID] or ""
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
	for _, axis in ipairs(self:GetPartAxes()) do
		out[axis] = Data.GetNumRows(axis, row)
	end
	return out
end

--- How many rows of one axis a spell has.
-- @param spellID the spell id
-- @param axis one of GetAxes()
-- @return a count, zero where the spell has none
function Epsilook:GetNumParts(spellID, axis)
	local row = self:GetSpellIndexByID(spellID)
	if not row then
		return 0
	end
	return Data.GetNumRows(axis, row)
end

--- What an interface may offer for a part of one axis.
-- Declared once and read by every interface, so a chat line and a frame cannot
-- disagree about what a model affords, nor about which of those changes the
-- world. `effect` is "read" where repeating it is harmless and offering it from
-- stale output is safe, and "world" where neither is true.
--
-- `needs` names the id the action takes, which `SUPPLIES` below says how a part
-- of that axis produces. `GetPartActions` is what pairs the two; an action
-- naming an id no part supplies could never be offered, and a test says so.
-- @param axis one of GetAxes()
-- @return an array of Action, empty where the axis affords nothing
function Epsilook:GetActions(axis)
	return Epsilook.ACTIONS[axis] or {}
end

Epsilook.ACTIONS = {
	model = {
		{ key = "spawn", label = "Spawn", needs = "gob", effect = "world", revert = "" },
	},
	sound = {
		{ key = "play", label = "Play", needs = "file", effect = "read", revert = "stop" },
		{ key = "stop", label = "Stop", needs = "file", effect = "read", revert = "" },
		{ key = "playKit", label = "Play Kit", needs = "kit", effect = "read", revert = "stopKit" },
		{ key = "stopKit", label = "Stop Kit", needs = "kit", effect = "read", revert = "" },
	},
	anim = {
		-- Two commands and two ids. One command plays an animation over
		-- whatever the character is doing and the other sets the pose it
		-- stands in, and the build ships an emote of each kind per animation,
		-- most animations having both. So an interface offering one id to both
		-- commands would be offering the wrong number to one of them.
		--
		-- TODO: settle which column feeds which command in game. That a
		-- one-shot emote is what a one-shot command takes is read off the
		-- column names and nothing else, and a name is not a measurement.
		{
			key = "anim",
			label = "Anim",
			needs = "emoteOneshot",
			effect = "world",
			revert = "resetAnim",
		},
		{
			key = "stand",
			label = "Stand",
			needs = "emoteLoop",
			effect = "world",
			revert = "resetStand",
		},
		{ key = "animkit", label = "Kit", needs = "animkit", effect = "world", revert = "" },
		{ key = "resetAnim", label = "Reset", needs = "", effect = "world", revert = "" },
		{ key = "resetStand", label = "Reset", needs = "", effect = "world", revert = "" },
	},
	fx = {},
	mech = {},
}

--- One id as an action can take it, which nought never is.
-- Wherever the build has an id to give and none to give for a row, it writes
-- nought, so a caller handed that number would act on whatever it names.
-- @param found what the payload or a lookup answered
-- @return the id, or nil
local function real(found)
	if not found or found == 0 then
		return nil
	end
	return found
end

--- The emote that performs one animation, where the build knows of one.
-- @param section which kind of emote, as the payload names the column
-- @param anim the animation id, or nil where the row names none
-- @return the emote id, or nil
local function emote(section, anim)
	local found = Data.GetIndexed(section)
	return anim and found and real(found(anim)) or nil
end

--- How a part of one axis produces the id an action needs.
-- Keyed the way `ACTIONS` is and by the same `needs` word, so the two are one
-- declaration read from either end.
--
-- A part that yields nothing here is simply not offered that action, which is
-- how a kind declines one without being named anywhere: a replacement row
-- gives two animations and no single one to play, so it produces no emote.
local SUPPLIES = {
	model = {
		-- The id is passed on exactly as the pack holds it, sign included: the
		-- command reads that sign to tell a spawnable template from a display,
		-- and a caller that tidied it away would spawn something else.
		--
		-- The lean variation leaves this column to the client, so nothing here
		-- answers on that build and no model part offers a spawn. Closing that
		-- is the client seam `Data.GetSupplier` names and nothing yet composes.
		gob = function(values)
			local gobs = Data.GetPaired("files", "fids", "gobs")
			return values.file and gobs and real(gobs(values.file)) or nil
		end,
	},
	sound = {
		file = function(values)
			return values.file
		end,
		kit = function(values)
			return values.kit
		end,
	},
	anim = {
		-- One kind of this axis carries an `id` and it is the animation kit, so
		-- naming that kind is not what makes this right today. It is what keeps
		-- it right: `id` is the plainest name a property has, two model kinds
		-- already use it for something else, and a kind of this axis gaining
		-- one would otherwise be handed to the command as a kit.
		animkit = function(values, kind)
			return kind == "kit" and values.id or nil
		end,
		emoteOneshot = function(values)
			return emote("animEmoteOneshots", values.anim)
		end,
		emoteLoop = function(values)
			return emote("animEmoteLoops", values.anim)
		end,
	},
}

--- Which ids a part of one axis can ever produce.
-- The other end of `ACTIONS`: an action needs one of these words or it can
-- never be offered on anything. Derived from the one declaration rather than
-- listed a second time, so the two cannot disagree.
-- @param axis one of GetAxes()
-- @return an array of `needs` words, in a stable order
function Epsilook:GetSupplies(axis)
	local out = {}
	for need in pairs(SUPPLIES[axis] or {}) do
		out[#out + 1] = need
	end
	table.sort(out)
	return out
end

--- One of a reused record's tables, emptied.
-- A caller passing a table to fill gets the part it asked for and nothing left
-- over from the last one, which a property unset on this row would otherwise
-- be indistinguishable from.
-- @param held the table, or nil
-- @return the same table with nothing in it, or nil
local function wiped(held)
	if not held then
		return nil
	end
	for key in pairs(held) do
		held[key] = nil
	end
	return held
end

--- What each of a row's stored numbers means, where a vocabulary says.
-- @param axis the axis
-- @param kind the row's kind
-- @param values the row's stored numbers
-- @param target an optional table to fill
-- @return a table of property name to what its number is called
local function named(axis, kind, values, target)
	local out = target or {}
	local vocab = Data.GetRowVocab(axis, kind)
	for name, value in pairs(values) do
		local which = vocab[name]
		local look = which and Data.GetVocabulary(which)
		local found = look and look(value)
		if found ~= nil then
			out[name] = found
		end
	end
	return out
end

--- Which ids a row can hand to an action of its axis.
-- @param axis the axis
-- @param kind the row's kind
-- @param values the row's stored numbers
-- @param target an optional table to fill
-- @return a table of an action's `needs` word to the id it takes
local function supplied(axis, kind, values, target)
	local out = target or {}
	for need, supply in pairs(SUPPLIES[axis] or {}) do
		local found = supply(values, kind)
		if found ~= nil then
			out[need] = found
		end
	end
	return out
end

--- One part, by where it sits in the axis's whole row order.
-- The position rather than the spell, because finding where a spell's rows
-- begin means walking the counts forward from a checkpoint -- up to a thousand
-- reads. A caller listing a spell's parts does that once and counts from
-- there; doing it per part is what makes a long list cost the walk again for
-- every row it shows.
-- @param axis the axis
-- @param at a position, as `Data.GetRowRange` counts them
-- @param target an optional table to fill
-- @return a PartData, or nil where the position names no row
local function partAt(axis, at, target)
	local kind, slot = Data.GetRowKind(axis, Data.GetRowRef(axis, at))
	if not kind then
		return nil
	end
	local out = target or {}
	out.axis, out.kind = axis, kind
	out.values = Data.GetRowValues(axis, kind, slot, wiped(out.values))
	out.named = named(axis, kind, out.values, wiped(out.named))
	out.ids = supplied(axis, kind, out.values, wiped(out.ids))
	return out
end

--- One of a spell's parts on one axis.
-- Counted from ONE, as a list is. A spell's own index is a row of the pack and
-- counted from zero; this is a position among what a single spell has.
-- @param spellID the spell id
-- @param axis one of GetPartAxes()
-- @param index which part, counted from one
-- @param target an optional table to fill instead of allocating one
-- @return a PartData, or nil where the spell, the axis or the part is absent
function Epsilook:GetPartDataByIndex(spellID, axis, index, target)
	local row = Data and self:GetSpellIndexByID(spellID)
	if not row then
		return nil
	end
	local at, count = Data.GetRowRange(axis, row)
	if not at or index < 1 or index > count then
		return nil
	end
	return partAt(axis, at + index - 1, target)
end

--- Every part a spell has on one axis, in the order the pack ships them.
-- The spell is located once for the whole walk, and so is where its rows
-- begin: both are searches, and a list of parts is exactly where paying for
-- them per row adds up.
-- @param spellID the spell id
-- @param axis one of GetPartAxes()
-- @return an iterator yielding an index and a PartData
function Epsilook:IterateParts(spellID, axis)
	local row = Data and self:GetSpellIndexByID(spellID)
	local at, count
	if row then
		at, count = Data.GetRowRange(axis, row)
	end
	local index = 0
	return function()
		index = index + 1
		if not at or index > count then
			return nil
		end
		return index, partAt(axis, at + index - 1)
	end
end

--- Which of its axis's actions a part can actually offer.
-- The rule in one place: an action needs an id and the part either has it or
-- does not, except for the ones that need nothing and are always offered.
-- @param part a PartData
-- @param target an optional table to fill instead of allocating one
-- @return an array of Action
function Epsilook:GetPartActions(part, target)
	local out = wiped(target) or {}
	for _, action in ipairs(self:GetActions(part.axis)) do
		if action.needs == "" or part.ids[action.needs] ~= nil then
			out[#out + 1] = action
		end
	end
	return out
end

-- TODO: FindSpells, GetNumMatches, ParseQuery and FormatQuery. All four need
-- the language and evaluate layers, which are not written. Their shapes are
-- settled, so a display can be built against them before they answer.

return Epsilook

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
-- SpellData   id, name, subtext, icon, school, flags, delivery
-- PartData    label, full, ids, detail
-- Action      key, label, needs, effect, revert
-- DataInfo    pack, built, variation, supplied, absent

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
	return Data and Data.GetInfo(target) or nil
end

--- The axes a spell can be inspected on, in the order a dossier shows them.
-- @return an array of axis names
function Epsilook:GetAxes()
	return Data and Data.GetAxes() or {}
end

--- How many spells this build carries.
function Epsilook:GetNumSpells()
	return Data and Data.GetNumSpells() or 0
end

--- The row a spell id sits at, for the by-index calls.
-- @param spellID the spell id
-- @return a row counted from zero, or nil where this build has no such spell
function Epsilook:GetSpellIndexByID(spellID)
	return Data and Data.GetSpellIndexByID(spellID) or nil
end

--- One text column of the spell section, by row.
local function spellText(column, row)
	local node, blob = Data.GetColumn("spell", "spells", column)
	if not node or row >= Reader.size(node) then
		return ""
	end
	return Reader.value(blob, node, row)
end

--- One spell's name.
-- @param spellID the spell id
-- @return the name, or nil where this build has no such spell
function Epsilook:GetSpellNameByID(spellID)
	local row = self:GetSpellIndexByID(spellID)
	if not row then
		return nil
	end
	return spellText("names", row)
end

--- One spell's whole record, by row.
-- @param index a row counted from zero
-- @param target an optional table to fill instead of allocating one
-- @return a SpellData, or nil where the row is outside this build
function Epsilook:GetSpellDataByIndex(index, target)
	if not Data then
		return nil
	end
	local ids, blob = Data.GetColumn("spell", "spells", "ids")
	if not ids or index < 0 or index >= Reader.size(ids) then
		return nil
	end
	local out = target or {}
	out.id = Reader.number(blob, ids, index)
	out.name = spellText("names", index)
	out.subtext = spellText("subtexts", index)
	out.school = spellText("schools", index)
	out.icon = 0
	out.flags = out.flags or {}
	out.delivery = ""
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
	for _, axis in ipairs(self:GetAxes()) do
		local count = Data.GetNumRows(axis, row)
		if count > 0 or out[axis] then
			out[axis] = count
		end
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
-- @param axis one of GetAxes()
-- @return an array of Action, empty where the axis affords nothing
function Epsilook:GetActions(axis)
	return Epsilook.ACTIONS[axis] or {}
end

Epsilook.ACTIONS = {
	model = {
		{ key = "spawn", label = "Spawn", needs = "display", effect = "world", revert = "" },
	},
	sound = {
		{ key = "play", label = "Play", needs = "file", effect = "read", revert = "stop" },
		{ key = "stop", label = "Stop", needs = "file", effect = "read", revert = "" },
		{ key = "playKit", label = "Play Kit", needs = "kit", effect = "read", revert = "stopKit" },
		{ key = "stopKit", label = "Stop Kit", needs = "kit", effect = "read", revert = "" },
	},
	anim = {
		{ key = "anim", label = "Anim", needs = "emote", effect = "world", revert = "resetAnim" },
		{
			key = "stand",
			label = "Stand",
			needs = "emote",
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

-- TODO: GetPartDataByIndex, FindParts, FindSpells, GetNumMatches, ParseQuery
-- and FormatQuery. The first two need the row families materialised through
-- `Data.GetRowRange`; the last four need the language and evaluate layers,
-- which are not written. Their shapes are settled, so a display can be built
-- against them before they answer.

return Epsilook

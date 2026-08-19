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
--   SpellData   id, name, subtext, icon, iconName, schoolID, school,
--               expansion, range, rangeMin, rangeMelee, rangeWeapon
--   SpellText   description, aura, encounter
--   PartData    axis, kind, slot, values (property name to value; a named
--               property is a table of id and text)
--   Action      key, label, needs, kind, except, via, effect, revert, hint
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
	-- The spell carries a band rather than a distance, since a build draws on
	-- a couple of hundred of them for every spell it has. No band is a spell
	-- that reaches no further than its caster.
	local band = Data.GetRangeBand(index)
	out.range = band and cell("spellRanges", "maxYards", band, 0) or 0
	out.rangeMin = band and cell("spellRanges", "minYards", band, 0) or 0
	local reach = band and cell("spellRanges", "flags", band, 0) or 0
	out.rangeMelee = reach % 2 == 1
	out.rangeWeapon = math.floor(reach / 2) % 2 == 1
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

--- Whether a spell has a row of one kind on an axis.
-- What decides whether an action that needs such a row is offered at all: a
-- spell with no aura row has nothing for `.aura` to apply.
-- @param spellID the spell id
-- @param axis one of GetPartAxes()
-- @param kindWord the kind's word, as PartData.kind carries it
-- @return true or false
function Epsilook:HasPartOfKind(spellID, axis, kindWord)
	local row = self:GetSpellIndexByID(spellID)
	if not row then
		return false
	end
	local at, count = Data.GetRowRange(axis, row)
	if not at then
		return false
	end
	local table_ = Data.GetRowTable(axis)
	for i = at, at + count - 1 do
		local kind = Data.LocateRow(axis, Reader.number(table_.refsBlob, table_.refs, i))
		if kind == kindWord then
			return true
		end
	end
	return false
end

--- One part of one spell: the n'th row it has on an axis.
-- The row's properties are read by name as the catalogue declares them and
-- resolved the way the declarations call for: a property whose first two
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

--- The columns a part carries beyond its declared properties, each named by
-- the section the pack ships for it: an effect carries the two implicit
-- targets it resolves and the aura it applies, a screen part the screen
-- effect it draws. The catalogue does not declare them, so no query reads
-- them; a surface that shows a part in full shows them.
local EXTRAS = {
	{ name = "targetA", section = "implicitTargetNames" },
	{ name = "targetB", section = "implicitTargetNames" },
	{ name = "aura", section = "auraNames" },
	{ name = "screen", section = "screens" },
}

--- What a part carries beyond its declared properties, named, in a fixed
-- order; a column the part lacks or holds nought in is left out. The naming
-- sections are maps from the number to its name, read whole once.
-- @param part a PartData
-- @return a list of { name, value, text }
function Epsilook:GetPartExtras(part)
	mounted(self)
	local out = {}
	for _, extra in ipairs(EXTRAS) do
		local value = Data.GetCarried(part.axis, part.kind, part.slot, extra.name)
		if value and value ~= 0 then
			local text
			if extra.section == "screens" then
				text = Data.Lookup("fx", "screens", "ids", "names", value) or ""
			else
				local axis = Data.GetAxisOf(extra.section)
				local names = axis and Data.ReadAll(axis, extra.section, "names") or {}
				-- The map's keys are text, as the pack writes every key.
				text = names[tostring(value)] or ""
			end
			out[#out + 1] = { name = extra.name, value = value, text = text }
		end
	end
	return out
end

--- What a screen effect paints, by its id: its name, the colour it fogs
-- the view with, the colour it multiplies over and the one it adds, each -1
-- where the effect paints none, the hue words the build gave it, and the
-- textures it draws. A screen part carries the id as an extra.
-- @param screenID the screen effect id
-- @return a table with name, fog, mul, add, hues, and textures, a list of
--   { role, fid } with the finished art (role 0) before the masks it is
--   shaped by (role 1); or nil where unknown
function Epsilook:GetScreenEffect(screenID)
	mounted(self)
	local name = Data.Lookup("fx", "screens", "ids", "names", screenID)
	if name == nil then
		return nil
	end
	local textures = {}
	local ids = Data.ReadAll("fx", "screenTextures", "screenIds") or {}
	local roles = Data.ReadAll("fx", "screenTextures", "roles") or {}
	local fids = Data.ReadAll("fx", "screenTextures", "fids") or {}
	for i = 1, #ids do
		if ids[i] == screenID then
			textures[#textures + 1] = { role = roles[i], fid = fids[i] }
		end
	end
	return {
		name = name,
		fog = Data.Lookup("fx", "screens", "ids", "fogColors", screenID),
		mul = Data.Lookup("fx", "screens", "ids", "mulColors", screenID),
		add = Data.Lookup("fx", "screens", "ids", "addColors", screenID),
		hues = Data.Lookup("fx", "screens", "ids", "hues", screenID) or "",
		textures = textures,
	}
end

--- A file the pack names: its id and its path, the path empty where the
-- pack has none.
local function file(fid)
	local path = Data.ResolveVocab("files", fid)
	return { id = fid, text = type(path) == "string" and path or "" }
end

--- The displays a creature wears, by creature id, where the pack carries
-- the pairs: what a morph or a summon stores is the creature, what the
-- game shows and what `.morph` and its kin take is a display. A creature
-- can wear several; the game picks one when it appears, and the first is
-- the one a click sends.
-- @param creatureID the creature id
-- @return a list of { id, file }, the display id and its model file as
--   { id, text }, in slot order; empty where the creature is unknown here
function Epsilook:GetDisplaysByCreature(creatureID)
	mounted(self)
	local out = {}
	local displays, blob = Data.GetColumn("model", "creatureDisplays", "displayIds")
	local fids = Data.GetColumn("model", "creatureDisplays", "fids")
	for _, row in ipairs(Data.RowsOf("model", "creatureDisplays", "creatureIds", creatureID)) do
		out[#out + 1] = {
			id = Reader.value(blob, displays, row),
			file = file(Reader.value(blob, fids, row)),
		}
	end
	return out
end

--- The display a creature wears first, by creature id: the one a command
-- is handed for a creature.
-- @param creatureID the creature id
-- @return the display id, or nil where the creature is unknown here
function Epsilook:GetDisplayByCreature(creatureID)
	local first = self:GetDisplaysByCreature(creatureID)[1]
	return first and first.id or nil
end

--- The textures a display paints over its model, by display id: none for
-- a display painting the model's own, and none for a humanoid display,
-- whose skin is a customization rather than a file.
-- @param displayID the display id
-- @return a list of { id, text }, the texture files in slot order
function Epsilook:GetDisplaySkins(displayID)
	mounted(self)
	local out = {}
	local fids, blob = Data.GetColumn("model", "displaySkins", "fids")
	for _, row in ipairs(Data.RowsOf("model", "displaySkins", "displayIds", displayID)) do
		out[#out + 1] = file(Reader.value(blob, fids, row))
	end
	return out
end

--- How a part comes to name a creature display: through a creature that
-- wears one, stored under a vocabulary of creatures, or the display
-- itself, stored under a vocabulary of displays or as a kind's own id.
Epsilook.DISPLAY_SOURCES = {
	creatures = { morphs = true, creatures = true },
	displays = { mounts = true },
	kinds = { ["model.display"] = "id" },
}

--- The displays a part names, each with what the pack knows of it: a part
-- naming a creature names every display the creature wears, with its
-- model file; a part naming a display outright names that one, whose
-- model the part already carries.
-- @param part a PartData
-- @return a list of { id, file, skins }: the display id, its model file
--   as { id, text } or nil where the part carries it itself, and its
--   textures as GetDisplaySkins gives them; empty for a part naming none
function Epsilook:GetPartDisplays(part)
	mounted(self)
	local out = {}
	local function display(id, modelFile)
		out[#out + 1] = { id = id, file = modelFile, skins = self:GetDisplaySkins(id) }
	end
	local kind = Schema.kindById[part.axis .. "." .. part.kind]
	local own = self.DISPLAY_SOURCES.kinds[part.axis .. "." .. part.kind]
	for _, prop in ipairs(kind and kind.props or {}) do
		-- The stored number, whichever way the value resolved: a vocabulary
		-- of text hands the part the word alone.
		local stored = Data.GetStored(part.axis, part.kind, part.slot, prop.name)
		local vocab = Data.GetVocabName(part.axis, part.kind, prop.name)
		if stored ~= nil and stored ~= 0 then
			if self.DISPLAY_SOURCES.creatures[vocab] then
				for _, worn in ipairs(self:GetDisplaysByCreature(stored)) do
					display(worn.id, worn.file)
				end
			elseif self.DISPLAY_SOURCES.displays[vocab] or prop.name == own then
				display(stored, nil)
			end
		end
	end
	return out
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
-- PartData value the action takes; `kind`, where set, the one kind of part
-- that takes it, and `except` the set of kinds that do not; `via`, where
-- set, how the value becomes what the action sends -- `creatureDisplay` is
-- the first display of the creature the value names, as a morph and a
-- summon store the creature and the commands take a display, and `factor`
-- is a percent change as the multiplier a command takes. An action
-- naming a property and no kind is taken by every kind carrying that
-- property. The order is the order a line
-- offers them, and the first action a part takes is the one a shift-click
-- hands over.
-- @param axis one of GetPartAxes()
-- @return an array of Action, empty where the axis affords nothing
function Epsilook:GetActions(axis)
	return Epsilook.ACTIONS[axis] or {}
end

Epsilook.ACTIONS = {
	model = {
		{
			key = "add",
			label = "Add",
			needs = "id",
			kind = "item",
			effect = "world",
			revert = "",
			hint = "Adds the item to your bags",
		},
		{
			key = "lookup",
			label = "Lookup",
			needs = "file",
			kind = "item",
			effect = "read",
			revert = "",
			hint = "Looks it up by its model's name, since nothing here names it",
		},
		{
			key = "native",
			label = "Native",
			needs = "id",
			kind = "display",
			effect = "world",
			revert = "",
			hint = "Your native form",
		},
		{
			key = "morph",
			label = "Morph",
			needs = "id",
			kind = "display",
			effect = "world",
			revert = "",
			hint = "Morph into it",
		},
		{
			key = "mount",
			label = "Mount",
			needs = "id",
			kind = "display",
			effect = "world",
			revert = "",
			hint = "Mount it",
		},
		{
			key = "native",
			label = "Native",
			needs = "name",
			kind = "mount",
			effect = "world",
			revert = "",
			hint = "Your native form",
		},
		{
			key = "morph",
			label = "Morph",
			needs = "name",
			kind = "mount",
			effect = "world",
			revert = "",
			hint = "Morph into it",
		},
		{
			key = "mount",
			label = "Mount",
			needs = "name",
			kind = "mount",
			effect = "world",
			revert = "",
			hint = "Mount it",
		},
		{
			key = "spawn",
			label = "Spawn",
			needs = "file",
			except = { item = true, mount = true, display = true },
			effect = "world",
			revert = "",
			hint = "Spawns the model where you stand",
		},
	},
	sound = {
		{
			key = "play",
			label = "Play",
			needs = "file",
			effect = "read",
			revert = "stop",
			hint = "Plays the file, for you only",
		},
		{
			key = "stop",
			label = "Stop",
			needs = "file",
			effect = "read",
			revert = "",
			hint = "Stops it",
		},
		{
			key = "playKit",
			label = "Play Kit",
			needs = "kit",
			effect = "read",
			revert = "stopKit",
			hint = "Plays the kit, for you only",
		},
		{
			key = "stopKit",
			label = "Stop Kit",
			needs = "kit",
			effect = "read",
			revert = "",
			hint = "Stops it",
		},
	},
	fx = {
		{
			key = "summon",
			label = "Spawn",
			needs = "creature",
			effect = "world",
			revert = "",
			hint = "Spawns the creature where you stand",
		},
		{
			key = "native",
			label = "Native",
			needs = "creature",
			via = "creatureDisplay",
			effect = "world",
			revert = "",
			hint = "Your native form, the creature's first display",
		},
		{
			key = "morph",
			label = "Morph",
			needs = "creature",
			via = "creatureDisplay",
			effect = "world",
			revert = "",
			hint = "Morph into the creature's first display",
		},
		{
			key = "mount",
			label = "Mount",
			needs = "creature",
			via = "creatureDisplay",
			effect = "world",
			revert = "",
			hint = "Mount it creature's first display",
		},
		{
			key = "spawn",
			label = "Spawn",
			needs = "object",
			kind = "object",
			effect = "world",
			revert = "",
			hint = "Spawns the object where you stand",
		},
	},
	anim = {
		{
			key = "animKit",
			label = "Kit",
			needs = "id",
			kind = "kit",
			effect = "world",
			revert = "",
			hint = "Plays the kit on you",
		},
		{
			key = "anim",
			label = "Anim",
			needs = "anim",
			effect = "world",
			revert = "",
			hint = "Plays it on you, once",
		},
		{
			key = "stand",
			label = "Emote",
			needs = "anim",
			effect = "world",
			revert = "",
			hint = "Holds it as your standing pose",
		},
		{
			key = "anim",
			label = "Anim",
			needs = "to",
			kind = "replace",
			effect = "world",
			revert = "",
			hint = "Plays the replacing animation, once",
		},
		{
			key = "stand",
			label = "Emote",
			needs = "to",
			kind = "replace",
			effect = "world",
			revert = "",
			hint = "Holds the replacing animation as your pose",
		},
		-- A passenger row carries one role, so each role takes both actions
		-- and a line offers the pair for whichever role it has.
		{
			key = "anim",
			label = "Anim",
			needs = "enter",
			kind = "passenger",
			effect = "world",
			revert = "",
			hint = "Plays the entering animation, once",
		},
		{
			key = "stand",
			label = "Emote",
			needs = "enter",
			kind = "passenger",
			effect = "world",
			revert = "",
			hint = "Holds the entering animation as your pose",
		},
		{
			key = "anim",
			label = "Anim",
			needs = "sit",
			kind = "passenger",
			effect = "world",
			revert = "",
			hint = "Plays the seated animation, once",
		},
		{
			key = "stand",
			label = "Emote",
			needs = "sit",
			kind = "passenger",
			effect = "world",
			revert = "",
			hint = "Holds the seated animation as your pose",
		},
		{
			key = "anim",
			label = "Anim",
			needs = "exit",
			kind = "passenger",
			effect = "world",
			revert = "",
			hint = "Plays the leaving animation, once",
		},
		{
			key = "stand",
			label = "Emote",
			needs = "exit",
			kind = "passenger",
			effect = "world",
			revert = "",
			hint = "Holds the leaving animation as your pose",
		},
	},
	mech = {
		{
			key = "speed",
			label = "Speed",
			needs = "amount",
			kind = "speed",
			via = "factor",
			effect = "world",
			revert = "",
			hint = "Sets your speed, in every mode",
		},
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
-- @return true where no clause evaluates and nothing is sorted; a query of
--   nothing but a sort asks for every spell, in that order
function Epsilook:IsQueryEmpty(query)
	return #query.groups == 0 and #query.sorts == 0
end

--- Whether a parsed query orders its answer, which costs a walk over every
-- spell before the first result.
-- @param query a query from ParseQuery
-- @return true where the query carries a sort directive
function Epsilook:IsQuerySorted(query)
	return #query.sorts > 0
end

--- The query language as data, for a help surface: the columns with their
-- hints, every top-level head with its role, its column and hint, and the operators.
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
		local hint, column
		if head.role == "column" then
			hint, column = Schema.columnByKey[head.column].hint, head.column
		elseif head.role == "kind" then
			hint, column = head.kind.hint, head.kind.column
		else
			hint, column = head.prop.hint, head.kind.column
		end
		heads[#heads + 1] = { word = word, role = head.role, column = column, hint = hint }
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

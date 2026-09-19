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
--   SkyData     id, name, file, celestialFile, flags, param, presets,
--               conditions, conditionWords, flat, zones, maps, spell, spells
--   SkyLight    top, middle, band1, band2, smog, fog, sun, ambient, direct,
--               horizon, ground, river, ocean, endFog, fogEnd, shadow, cloud

_G.Epsilook = _G.Epsilook or {}
local Epsilook = _G.Epsilook

local Data = Epsilook.Data
local Text = Epsilook.Text
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
	local ok, reason, problem = Data.Load()
	if not ok then
		return false, reason, problem
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

--- What stands between this reader and its data, found out without loading
-- the data: whether it is installed, whether it may load, and whether the two
-- halves came from the same download. Cheap enough to ask at login, since the
-- data loads on demand and is most of the addon's weight.
-- @return nil where nothing does, or a problem record: `code` one of
--   "missing", "disabled", "unloadable", "layout", "release"; `hard` where
--   the data cannot be read at all; `reason` the client's own code where it
--   gave one; `data` and `reader` what each side declares where they differ
function Epsilook:GetDataProblem()
	return Data.Problem()
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

--- When a spell's effects land, where they do not all land at the cast.
--
-- Three numbers, any of which may be absent. `launch` is how long after the cast
-- the server runs the effects that wait for it. A spell whose payload travels
-- carries either a `velocity` in yards a second, the missile's own speed, or a
-- `delay` in seconds, a flat wait the server takes instead; which of the two it
-- is was decided when the pack was built, so a reader takes whichever is there
-- rather than choosing.
-- @param spellID the spell
-- @return a record of launch, velocity and delay, or nil where the spell has
--   no clock of its own and everything lands at the cast
function Epsilook:GetSpellClock(spellID)
	mounted(self)
	local node, blob = Data.GetColumn("mech", "spellTimeline", "spellIds")
	local row = node and Reader.rowOf(blob, node, spellID)
	if not row then
		return nil
	end
	local function at(column, scale)
		local held, bytes = Data.GetColumn("mech", "spellTimeline", column)
		if not held then
			return nil
		end
		-- A column is stored as whatever suits its values, so the reader is the
		-- one the node asks for rather than the one a number suggests.
		local read = Reader.number
		if held.kind ~= "int" then
			read = Reader.value
		end
		local value = read(bytes, held, row)
		if not value or value == 0 then
			return nil
		end
		return value / scale
	end
	return {
		launch = at("launchMs", 1000),
		delay = at("delayMs", 1000),
		velocity = at("velocity", 1),
	}
end

--- The vocabulary a property's values are read out of, or nil where they are
-- not words. What a value means depends on the vocabulary behind it -- an id
-- into the creatures is not an id into the items -- so a reader deciding how to
-- draw a value asks this rather than guessing from the number.
-- @param axis the part's axis
-- @param kind the part's kind
-- @param prop the property's storage name
function Epsilook:GetPartVocabulary(axis, kind, prop)
	mounted(self)
	return Data.GetVocabName(axis, kind, prop)
end

--- One property as the pack stores it, before any vocabulary is read over it.
-- The number the game's own tables hold, which is what another tool calls the
-- same thing and what a selector is keyed by.
-- @param axis the part's axis
-- @param kind the part's kind
-- @param slot the part's slot, as a PartData carries it
-- @param prop the property's storage name
function Epsilook:GetPartStored(axis, kind, slot, prop)
	mounted(self)
	return Data.GetStored(axis, kind, slot, prop)
end

--- A value a row carries beyond its own properties, or nil. A row holds what
-- every row of its kind holds; a few carry one more thing that belongs to them
-- alone, and this is how that is asked for by name.
-- @param axis the part's axis
-- @param kind the part's kind
-- @param slot the part's slot, as a PartData carries it
-- @param name what is carried
function Epsilook:GetPartCarried(axis, kind, slot, name)
	mounted(self)
	return Data.GetCarried(axis, kind, slot, name)
end

--- Text folded the way this engine compares it, so that a caller matching a
-- word against the language matches it the way a query would.
-- @param text the text
function Epsilook:Fold(text)
	return Text.fold(text)
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
		local stored = Schema.Stored(axis, kindWord, slot, prop)
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

--- What a discriminated row's columns are ids into, once its selector has
-- decided. A mechanics part carries both misc values raw; this says what
-- the effect or aura beside them makes of each.
-- @param table the source table, "SpellEffect" for a mechanics part
-- @param column the selector column, "Effect" or "EffectAura"
-- @param value the selector's value, the effect or aura id
-- @return a list of { column, holds, into, scale }, each what one column holds
--   under this meaning: a reference into `into`, a value or a mask of values
--   the vocabulary `into` names, an amount in the unit `into` names where it
--   has one (a word the descriptions write after a number: "percent",
--   "seconds", "yards", "degrees" and the like), a parameter another slot
--   decides, an argument the spell's own server script reads, or a column
--   the server never reads; empty where the pack declares nothing for the
--   value. `scale` is what an amount is divided by before it reads in its
--   unit: a thousand for milliseconds read as seconds, one where it is not scaled
function Epsilook:GetSelectorReads(table, column, value)
	mounted(self)
	local tables = Data.ReadAll("mech", "selectors", "tables") or {}
	local columns = Data.ReadAll("mech", "selectors", "columns") or {}
	local values = Data.ReadAll("mech", "selectors", "values") or {}
	local slotColumns = Data.ReadAll("mech", "selectors", "slotColumns") or {}
	local holds = Data.ReadAll("mech", "selectors", "holds") or {}
	local intos = Data.ReadAll("mech", "selectors", "intos") or {}
	local scales = Data.ReadAll("mech", "selectors", "scales") or {}
	local untils = Data.ReadAll("mech", "selectors", "untils") or {}
	local out = {}
	-- One row per slot, so a selector reading several columns is several
	-- rows agreeing on the first three. A reading a later patch retired
	-- carries that patch as `until`, empty where it still holds; the table
	-- is the same on every pack, so the caller judges it against the pack.
	for i = 1, #values do
		if tables[i] == table and columns[i] == column and values[i] == value then
			out[#out + 1] = {
				column = slotColumns[i],
				holds = holds[i],
				into = intos[i],
				scale = scales[i] or 1,
				["until"] = untils[i] or "",
			}
		end
	end
	return out
end

--- The words a raw value names, once GetSelectorReads has said its column
-- holds a value or a mask of values of a vocabulary.
-- @param into the vocabulary, as GetSelectorReads returns it
-- @param holds "vocabulary" or "mask", as GetSelectorReads returns it
-- @param value the raw value on the row
-- @return a list of words in the vocabulary's order: the one the value
--   names, or each one a mask's bits set; empty where it names nothing
function Epsilook:GetSlotWords(into, holds, value)
	mounted(self)
	local vocabularies = Data.ReadAll("mech", "selectorVocabularies", "vocabularies") or {}
	local values = Data.ReadAll("mech", "selectorVocabularies", "values") or {}
	local words = Data.ReadAll("mech", "selectorVocabularies", "words") or {}
	local out = {}
	for i = 1, #values do
		if vocabularies[i] == into then
			local key = values[i]
			local named
			if holds == "mask" then
				-- A mask vocabulary's values are single bits, so arithmetic
				-- answers whether one is set without a bit library; a negative
				-- mask is read as the 32 bits it stores, so -1 sets every one.
				local bits = value
				if bits < 0 then
					bits = bits + 4294967296
				end
				named = math.floor(bits / key) % 2 == 1
			else
				named = key == value
			end
			if named then
				out[#out + 1] = words[i]
			end
		end
	end
	return out
end

--- The name of the thing a raw value points at, once GetSelectorReads has
-- said its column is a reference into a table.
-- @param into the table, as GetSelectorReads returns it
-- @param id the raw value on the row
-- @return the name; nil where the pack names nothing under that id
function Epsilook:GetReferenceName(into, id)
	mounted(self)
	local tables = Data.ReadAll("mech", "referenceNames", "tables") or {}
	local ids = Data.ReadAll("mech", "referenceNames", "ids") or {}
	local names = Data.ReadAll("mech", "referenceNames", "names") or {}
	for i = 1, #ids do
		if ids[i] == id and tables[i] == into then
			local name = names[i]
			if name == "" then
				return nil
			end
			return name
		end
	end
	return nil
end

--- The rows of a "mech" section sorted by spell that belong to one spell.
-- A binary search over the payload, so nothing is read into a table.
-- @return the first row and the last, counted from nought; the first is past
--   the last where the section carries nothing for the spell
local function spellRows(section, spellID)
	local node, blob = Data.GetColumn("mech", section, "spellIds")
	if not node then
		return 0, -1
	end
	local first = 0
	local before = Reader.rowAtMost(blob, node, spellID - 1)
	if before then
		first = before + 1
	end
	local last = first - 1
	while last + 1 < Reader.size(node) and Reader.number(blob, node, last + 1) == spellID do
		last = last + 1
	end
	return first, last
end

--- The numbers each of a spell's effects carries beyond its mechanics part.
-- The amount is resolved at the build's level cap, the way the spell's own
-- description prints it, and its unit is the one GetSelectorReads gives the
-- effect's "EffectBasePoints" column.
-- @param spellID the spell
-- @return a list of records in effect order: `index` counts from nought as a
--   mechanics part does; `amount`; `radius` and `maxRadius` in yards;
--   `facing` in degrees; `chain` and `pvp`, what each further chained target
--   and a player target multiply the amount by, one where unchanged;
--   `spellPower` and `attackPower`, the shares of each the amount adds;
--   `perLevel` and `perResource`, what it gains per caster level and per
--   spent combo point; `spread`, the fraction the amount rolls within half of
--   either way; `multiplier`, the value multiplier, nought except on the
--   drains, burns, leeches, health funnels, mana shields and jumps the core
--   reads it for;
--   `mechanic`, a "spell_mechanics" value; `item`, the id of an item the
--   effect creates. Empty where the spell carries none
function Epsilook:GetEffectAmounts(spellID)
	mounted(self)
	local out = {}
	local first, last = spellRows("effectAmounts", spellID)
	for row = first, last do
		-- Each column ships in the fixed point its scale undoes.
		local function at(column, scale)
			return cell("effectAmounts", column, row, 0) / scale
		end
		out[#out + 1] = {
			index = at("orders", 1),
			amount = at("amounts", 10),
			radius = at("radii", 10),
			maxRadius = at("maxRadii", 10),
			facing = at("facings", 10),
			chain = at("chains", 100),
			pvp = at("pvps", 100),
			spellPower = at("spellPowers", 1000),
			attackPower = at("attackPowers", 1000),
			perLevel = at("perLevels", 10),
			perResource = at("perResources", 10),
			spread = at("spreads", 1000),
			multiplier = at("multipliers", 100),
			mechanic = at("mechanics", 1),
			item = at("items", 1),
		}
	end
	return out
end

--- The cone or line a spell's area takes in front of its caster.
-- @param spellID the spell
-- @return { degrees, width }, the cone's angle and the line's width in yards,
--   either nought where the area is not that shape; nil where it is neither
function Epsilook:GetSpellCone(spellID)
	mounted(self)
	local row, last = spellRows("spellCones", spellID)
	if row > last then
		return nil
	end
	return {
		degrees = cell("spellCones", "degrees", row, 0) / 10,
		width = cell("spellCones", "widths", row, 0) / 10,
	}
end

--- The two kits a music set or an ambience plays, by day and by night.
-- @param section "zoneMusic" or "ambiences"
-- @param id the set's id
-- @return { day, night }, either kit nought where the set has none; or nil
--   where the pack names no such set
local function kitPair(section, id)
	local day = Data.Lookup("fx", section, "ids", "dayKits", id)
	if day == nil then
		return nil
	end
	return { day = day, night = Data.Lookup("fx", section, "ids", "nightKits", id) or 0 }
end

--- What a screen effect does, by its id. A row bundles four independent
-- things: the paint it puts on the frame, the light preset it swaps the sky
-- to, the sound it swaps to, and the hour it pins the day to; most rows
-- carry only some of them. A screen part carries the id as an extra.
-- @param screenID the screen effect id
-- @return a table with name; fog, mul and add, the colours it paints with,
--   each -1 where it paints none; hues, the build's words for them;
--   textures, a list of { role, fid } with the finished art (role 0) before
--   the masks it is shaped by (role 1); sky, the LightParams it swaps to, or
--   nought, with skyFadeIn and skyFadeOut in milliseconds; hour, the minute
--   of the day it pins, or -1; music and ambience, each { name?, day, night }
--   kits or nil where the row names none; or nil where the screen is unknown
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
	local musicID = Data.Lookup("fx", "screens", "ids", "musicIds", screenID) or 0
	local music = musicID ~= 0 and kitPair("zoneMusic", musicID) or nil
	if music then
		music.name = Data.Lookup("fx", "zoneMusic", "ids", "names", musicID) or ""
	end
	local ambienceID = Data.Lookup("fx", "screens", "ids", "ambienceIds", screenID) or 0
	return {
		name = name,
		fog = Data.Lookup("fx", "screens", "ids", "fogColors", screenID),
		mul = Data.Lookup("fx", "screens", "ids", "mulColors", screenID),
		add = Data.Lookup("fx", "screens", "ids", "addColors", screenID),
		hues = Data.Lookup("fx", "screens", "ids", "hues", screenID) or "",
		textures = textures,
		sky = Data.Lookup("fx", "screens", "ids", "skyParams", screenID) or 0,
		skyFadeIn = Data.Lookup("fx", "screens", "ids", "skyFadeIns", screenID) or 0,
		skyFadeOut = Data.Lookup("fx", "screens", "ids", "skyFadeOuts", screenID) or 0,
		hour = Data.Lookup("fx", "screens", "ids", "hours", screenID) or -1,
		music = music,
		ambience = ambienceID ~= 0 and kitPair("ambiences", ambienceID) or nil,
	}
end

--- A file the pack names: its id and its path, the path empty where the
-- pack has none.
local function file(fid)
	local path = Data.ResolveVocab("files", fid)
	return { id = fid, text = type(path) == "string" and path or "" }
end

--- The displays one section pairs against the id it is keyed on. Every
-- section of the kind holds the same three columns, so the section and its
-- key are the whole of what tells one from another.
-- @param section the section's name
-- @param keys the column it is keyed on
-- @param id the id to look up
local function wears(section, keys, id)
	local out = {}
	local displays, blob = Data.GetColumn("model", section, "displayIds")
	local fids = Data.GetColumn("model", section, "fids")
	for _, row in ipairs(Data.RowsOf("model", section, keys, id)) do
		out[#out + 1] = {
			id = Reader.value(blob, displays, row),
			file = file(Reader.value(blob, fids, row)),
		}
	end
	return out
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
	return wears("creatureDisplays", "creatureIds", creatureID)
end

--- The displays a shapeshift form wears, by form id. A form is stored as a
-- number into the forms and shown as a name, which says what the caster
-- turns into without saying what that looks like; this is the rest of the
-- way, and the pack has carried it since the form names were shipped.
-- @param formID the shapeshift form id
-- @return a list of { id, file }, as GetDisplaysByCreature gives them
function Epsilook:GetDisplaysByForm(formID)
	mounted(self)
	return wears("shapeshiftDisplays", "formIds", formID)
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
	-- A vocabulary of things that WEAR a display, to the reader that finds the
	-- ones it wears. Teaching this one more is a row rather than a branch.
	worn = {
		morphs = "GetDisplaysByCreature",
		creatures = "GetDisplaysByCreature",
		shapeshifts = "GetDisplaysByForm",
	},
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
		local stored = Schema.Stored(part.axis, part.kind, part.slot, prop)
		local vocab = Data.GetVocabName(part.axis, part.kind, prop.name)
		if stored ~= nil and stored ~= 0 then
			local reader = self.DISPLAY_SOURCES.worn[vocab]
			if reader then
				for _, worn in ipairs(self[reader](self, stored)) do
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

-- The sky. It is the one family here whose subject is not a spell: a skybox
-- belongs to a stretch of the world, and Epsilon's own spells are an edge into
-- it rather than the thing it hangs off. So these read by skybox id, and the
-- spell is a field on the record.

--- Which run of rows in a side section belongs to each skybox, built once.
-- The three side sections are written in skybox order, so a run is a first row
-- and a length; walking the key column once beats a search per call, and there
-- are a couple of thousand rows in the largest of them.
local skyRuns = {}

local function runsOf(section)
	local found = skyRuns[section]
	if found then
		return found
	end
	found = {}
	local keys = Data.ReadAll("sky", section, "skyboxIds") or {}
	for row = 1, #keys do
		local run = found[keys[row]]
		if run then
			run[2] = run[2] + 1
		else
			found[keys[row]] = { row - 1, 1 }
		end
	end
	skyRuns[section] = found
	return found
end

--- The words for each bit of a condition mask, read once.
local function conditionWords()
	return Data.ReadAll("sky", "skyConditions", "words") or {}
end

--- A packed colour as four channels.
-- Every sky colour ships as the client stores it, one number holding alpha,
-- red, green and blue. Unpacking is one decision, so it lives here rather than
-- in each interface that draws one.
-- @param packed a colour from a SkyLight
-- @return r, g, b, a, each from zero to one
function Epsilook:UnpackColor(packed)
	packed = packed or 0
	local b = packed % 256
	local g = math.floor(packed / 256) % 256
	local r = math.floor(packed / 65536) % 256
	local a = math.floor(packed / 16777216) % 256
	return r / 255, g / 255, b / 255, a / 255
end

--- How many sky domes this build carries.
function Epsilook:GetNumSkies()
	mounted(self)
	local node = Data.GetColumn("sky", "skyboxes", "ids")
	return node and Reader.size(node) or 0
end

--- The row a skybox id sits at.
-- @param skyboxID the LightSkybox id
-- @return the row, counted from zero, or nil
function Epsilook:GetSkyIndexByID(skyboxID)
	mounted(self)
	local node, blob = Data.GetColumn("sky", "skyboxes", "ids")
	return node and Reader.rowOf(blob, node, skyboxID) or nil
end

--- The places a dome is seen, zones before maps.
-- A zone is the only naming of a place the client ships; a map is the fallback
-- for a light no zone names, and a map the dome is the whole sky of says so.
-- @param skyboxID the LightSkybox id
-- @return a list of zone names, a list of map names, a list of whole-map names
function Epsilook:GetSkyPlaces(skyboxID)
	mounted(self)
	local run = runsOf("skyPlaces")[skyboxID]
	local zones, maps, whole = {}, {}, {}
	if not run then
		return zones, maps, whole
	end
	local kinds = Data.ReadAll("sky", "skyPlaces", "kinds") or {}
	local names = Data.ReadAll("sky", "skyPlaces", "names") or {}
	for at = run[1] + 1, run[1] + run[2] do
		local kind, name = kinds[at], names[at]
		if kind == 0 then
			zones[#zones + 1] = name
		else
			maps[#maps + 1] = name
			if kind == 2 then
				whole[#whole + 1] = name
			end
		end
	end
	return zones, maps, whole
end

--- Every spell that sets a dome, and the preset each one sets. A spell
-- reaches a dome through the screen effect its aura names, so a retail spell
-- that darkens the sky is here beside a private server's spell that exists
-- only to set the preset.
-- @param skyboxID the LightSkybox id
-- @return a list of spell ids, and a parallel list of the LightParams each sets
function Epsilook:GetSkySpells(skyboxID)
	mounted(self)
	local run = runsOf("skySpells")[skyboxID]
	local spells, params = {}, {}
	if not run then
		return spells, params
	end
	local ids = Data.ReadAll("sky", "skySpells", "spells") or {}
	local presets = Data.ReadAll("sky", "skySpells", "paramIds") or {}
	for at = run[1] + 1, run[1] + run[2] do
		spells[#spells + 1] = ids[at]
		params[#params + 1] = presets[at]
	end
	return spells, params
end

--- One dome's whole record, by row.
-- @param index a row counted from zero
-- @param target an optional table to fill instead of allocating one
-- @return a SkyData, or nil where the row is outside this build
function Epsilook:GetSkyDataByIndex(index, target)
	mounted(self)
	local ids, blob = Data.GetColumn("sky", "skyboxes", "ids")
	if not ids or index < 0 or index >= Reader.size(ids) then
		return nil
	end
	local out = target or {}
	out.id = Reader.number(blob, ids, index)
	out.name = cell("skyboxes", "names", index, "")
	out.file = cell("skyboxes", "files", index, 0)
	out.celestialFile = cell("skyboxes", "celestialFiles", index, 0)
	out.flags = cell("skyboxes", "skyFlags", index, 0)
	out.param = cell("skyboxes", "params", index, 0)
	out.presets = cell("skyboxes", "presets", index, 0)
	out.conditions = cell("skyboxes", "conditions", index, 0)
	out.flat = cell("skyboxes", "flat", index, 0) == 1
	-- Bit nought is the plain sky and needs no saying, so the words start at one.
	local words = conditionWords()
	out.conditionWords = {}
	for bit = 1, #words - 1 do
		if math.floor(out.conditions / 2 ^ bit) % 2 == 1 and words[bit + 1] ~= "" then
			out.conditionWords[#out.conditionWords + 1] = words[bit + 1]
		end
	end
	out.zones, out.maps = self:GetSkyPlaces(out.id)
	local spells, params = self:GetSkySpells(out.id)
	out.spells = spells
	-- The spell to offer first is the one setting the preset the row stands for.
	out.spell = spells[1]
	for at = 1, #spells do
		if params[at] == out.param then
			out.spell = spells[at]
			break
		end
	end
	return out
end

--- One dome's whole record, by id.
-- @param skyboxID the LightSkybox id
-- @param target an optional table to fill instead of allocating one
-- @return a SkyData, or nil where this build has no such dome
function Epsilook:GetSkyDataByID(skyboxID, target)
	local row = self:GetSkyIndexByID(skyboxID)
	if not row then
		return nil
	end
	return self:GetSkyDataByIndex(row, target)
end

--- The names of the SkyLight fields, in the order the ramp columns ship.
local SKY_LIGHT_FIELDS = {
	{ "top", "skyTopColors" },
	{ "middle", "skyMiddleColors" },
	{ "band1", "skyBand1Colors" },
	{ "band2", "skyBand2Colors" },
	{ "smog", "skySmogColors" },
	{ "fog", "skyFogColors" },
	{ "sun", "sunColors" },
	{ "ambient", "ambientColors" },
	{ "direct", "directColors" },
	{ "horizon", "horizonAmbientColors" },
	{ "ground", "groundAmbientColors" },
	{ "river", "riverCloseColors" },
	{ "ocean", "oceanCloseColors" },
	{ "endFog", "endFogColors" },
}

--- One channel of a packed colour, blended between two stops.
local function blend(from, to, part)
	local out = 0
	for shift = 0, 3 do
		local unit = 2 ^ (shift * 8)
		local a = math.floor(from / unit) % 256
		local b = math.floor(to / unit) % 256
		out = out + math.floor(a + (b - a) * part + 0.5) * unit
	end
	return out
end

--- What the sky holds at one moment of the day.
-- The ramp ships as stops rather than as a fixed set of hours, so any moment
-- can be asked for; between two stops the colours are blended, and the day
-- wraps, so a moment after the last stop reads back towards the first.
-- @param skyboxID the LightSkybox id
-- @param time a half-minute of the day, from zero to 2879
-- @param target an optional table to fill instead of allocating one
-- @return a SkyLight, or nil where the dome has no ramp
function Epsilook:GetSkyLight(skyboxID, time, target)
	mounted(self)
	local run = runsOf("skyRamps")[skyboxID]
	if not run then
		return nil
	end
	local times = Data.ReadAll("sky", "skyRamps", "times") or {}
	local first, count = run[1] + 1, run[2]
	time = time % 2880

	-- The stop at or before the moment, and the one after it, wrapping the day.
	local before = first + count - 1
	for at = first, first + count - 1 do
		if times[at] > time then
			before = at - 1
			break
		end
	end
	if before < first then
		before = first + count - 1
	end
	local after = before + 1
	if after > first + count - 1 then
		after = first
	end
	local span = (times[after] - times[before]) % 2880
	local part = span > 0 and (((time - times[before]) % 2880) / span) or 0

	local out = target or {}
	for at = 1, #SKY_LIGHT_FIELDS do
		local name, column = SKY_LIGHT_FIELDS[at][1], SKY_LIGHT_FIELDS[at][2]
		local values = Data.ReadAll("sky", "skyRamps", column)
		out[name] = values and blend(values[before], values[after], part) or 0
	end
	for _, pair in ipairs({
		{ "fogEnd", "fogEnds" },
		{ "shadow", "shadowOpacities" },
		{ "cloud", "cloudDensities" },
	}) do
		local values = Data.ReadAll("sky", "skyRamps", pair[2])
		local from, to = values and values[before] or 0, values and values[after] or 0
		out[pair[1]] = from + (to - from) * part
	end
	return out
end

--- Every dome whose name, zone, map or spell contains the text.
-- @param text what to look for, folded to lower case; empty returns every dome
-- @return a list of skybox ids
function Epsilook:FindSkies(text)
	mounted(self)
	local wanted = (text or ""):lower()
	local ids = Data.ReadAll("sky", "skyboxes", "ids") or {}
	local names = Data.ReadAll("sky", "skyboxes", "names") or {}
	local out = {}
	for row = 1, #ids do
		local hit = wanted == "" or names[row]:lower():find(wanted, 1, true) ~= nil
		if not hit then
			local zones, maps = self:GetSkyPlaces(ids[row])
			for _, list in ipairs({ zones, maps }) do
				for at = 1, #list do
					if list[at]:lower():find(wanted, 1, true) then
						hit = true
						break
					end
				end
				if hit then
					break
				end
			end
		end
		if not hit and tonumber(wanted) then
			local spells = self:GetSkySpells(ids[row])
			for at = 1, #spells do
				if spells[at] == tonumber(wanted) then
					hit = true
					break
				end
			end
		end
		if hit then
			out[#out + 1] = ids[row]
		end
	end
	return out
end

--- What an interface may offer for one sky dome.
-- The same shape as `ACTIONS`, and read the same way: this says what a dome
-- affords, never that anything was done. `needs` names the SkyData field the
-- action takes.
Epsilook.SKY_ACTIONS = {
	{
		key = "area",
		label = "Area skybox",
		needs = "spell",
		effect = "world",
		revert = "",
		hint = "Sets the sky of the area you are standing in",
	},
	{
		key = "zone",
		label = "Zone skybox",
		needs = "spell",
		effect = "world",
		revert = "",
		hint = "Sets the sky of the whole zone",
	},
	{
		key = "aura",
		label = "Aura",
		needs = "spell",
		effect = "world",
		revert = "unaura",
		hint = "Puts the sky on you alone",
	},
	{
		key = "cast",
		label = "Cast",
		needs = "spell",
		effect = "world",
		revert = "",
		hint = "Casts it, so anything watching sees it too",
	},
}

--- What an interface may offer for a dome.
-- @return an array of Action
function Epsilook:GetSkyActions()
	return Epsilook.SKY_ACTIONS
end

--- The command one sky action sends, as text.
-- Returned rather than sent: this surface performs nothing, and only the
-- interface knows whether a click came from a frame or from old scrollback.
-- @param key an action key from GetSkyActions
-- @param skyboxID the LightSkybox id
-- @return the command without its leading dot, or nil where the dome has no spell
function Epsilook:GetSkyCommand(key, skyboxID)
	local sky = self:GetSkyDataByID(skyboxID)
	if not sky or not sky.spell then
		return nil
	end
	if key == "area" then
		return "phase shift area skybox " .. sky.spell
	elseif key == "zone" then
		return "phase shift zone skybox " .. sky.spell
	elseif key == "aura" then
		return "aura " .. sky.spell
	elseif key == "cast" then
		return "cast " .. sky.spell
	end
	return nil
end

return Epsilook

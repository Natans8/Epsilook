--- The dossier: everything one spell is made of, printed, with its actions.
--
-- The second interface over the API. A head line names the spell; then one
-- block per axis that carries rows for it, one line per part, shaped the way
-- the server's own info commands print a thing: a cyan label, the part's
-- subject, and the actions the axis affords. Sounds are grouped under the
-- kit they come from, the kit's actions on the kit's line and each file's on
-- its own. A part whose subject the server can be handed by hand -- a model
-- for `.gob spawn`, an animation for `.mod anim`, a kit by its id -- carries
-- it as a link: its tooltip holds every value the part has, and a shift-click
-- hands the chat box the game's own link or the number, as a shift-click on
-- any link would. A part that names another spell shows the game's own
-- spell link and that spell's actions; an item shows with the client's icon
-- and quality colour. A part nothing takes by hand is plain text with its
-- values beside it. Every link is absolute -- spell, axis, row -- so a dossier in
-- old scrollback still does what it says, and a "world" action is exactly as
-- dangerous from there as it was when printed, which is why the sound
-- actions carry their stop beside them.
--
-- The actions are Epsilon's commands and the client's own sound calls; this
-- file is the one place that knows which is which. Rendering is apart from
-- printing, so the lines are tested bare.

_G.Epsilook = _G.Epsilook or {}
local Epsilook = _G.Epsilook

local Inspect = {}
Epsilook.Inspect = Inspect

local Shell = Epsilook.Shell
local GOLD, WHITE, CYAN, GREY, RED =
	Shell.COLOURS.gold,
	Shell.COLOURS.white,
	Shell.COLOURS.cyan,
	Shell.COLOURS.grey,
	Shell.COLOURS.red
local END = "|r"

--- The verbs of the links this file draws: a part's own link, a group's,
-- an axis's count on a result line, and the copy that hands the chat box
-- the number a command takes.
Inspect.PART = "part"
Inspect.GROUP = "group"
Inspect.LIST = "list"
Inspect.COPY = "copy"
Inspect.COPYGROUP = "copygroup"

--- The copy verb a line's verb draws, and the line verb a copy stands for.
-- A copy on a group's line hands what the group's actions take and one on a
-- part's line what the part's do, so the two are told apart the way the
-- lines themselves are.
local COPY_VERB = { [Inspect.PART] = Inspect.COPY, [Inspect.GROUP] = Inspect.COPYGROUP }
local COPY_LINE = { [Inspect.COPY] = Inspect.PART, [Inspect.COPYGROUP] = Inspect.GROUP }

--- How an axis's parts are grouped, where they are: `prop` is the property
-- whose value the group shares, and the group's line leads with the
-- actions that take that property, the parts following indented with the
-- rest. `kind`, where set, names the one kind that groups -- an anim kit's
-- animations under their kit, while a loose animation stands on its own --
-- and the group's label; without it the property is the label. `with` names
-- the other properties that belong to the group rather than to each part
-- under it -- what a sound kit is FOR is the kit's, so it is said once on the
-- kit's line and not again on every file the kit plays. Every
-- sound comes from a kit; an animation comes from a kit or from nowhere.
Inspect.GROUPS = {
	sound = { prop = "kit", with = { type = true } },
	anim = { prop = "id", kind = "kit" },
}

--- The grouping a part falls under, or nil where it stands on its own.
local function groupOf(part)
	local group = Inspect.GROUPS[part.axis]
	if
		group
		and (group.kind == nil or group.kind == part.kind)
		and part.values[group.prop] ~= nil
	then
		return group
	end
	return nil
end

--- Whether a value belongs to the group's own line rather than to each part
-- under it: the property the group is keyed by, and any the grouping declares
-- beside it.
local function grouped(grouping, name)
	if not grouping then
		return false
	end
	return name == grouping.prop or (grouping.with ~= nil and grouping.with[name] == true)
end

--- How many parts an axis's tooltip lists before it says how many more.
Inspect.LISTED = 12

--- The values shown beside a linked subject on the line, by axis, where the
-- line would be blind without them: the point a model attaches at, keyed by
-- the property's storage name.
Inspect.BESIDE = { model = { where = true } }

--- The axes whose every part is a link whatever it can be handed, because
-- the tooltip is where the part's detail lives: an effect's implicit targets
-- and the aura it applies, an aura's own target.
Inspect.DETAILED = { mech = true }

--- The kinds whose row carries one of several same-shaped properties, so
-- the property's NAME is part of what the line says: a passenger's
-- animation is what it plays entering, sitting or leaving, and the line
-- names the role after the animation.
Inspect.ROLED = { ["anim.passenger"] = true }

--- The kinds whose texture draws, and how large: on the line where the
-- shape fits one -- a chain's strip is long and thin -- and in the part's
-- tooltip, larger, for every textured kind; a dissolve is a square tile, a
-- screen a full-screen overlay.
Inspect.TEXTURES = {
	["fx.chain"] = { line = { height = 16, width = 64 }, tip = { height = 32, width = 128 } },
	["fx.dissolve"] = { tip = { height = 96, width = 96 } },
	["fx.screen"] = { tip = { height = 90, width = 160 }, mask = { height = 45, width = 80 } },
}

--- A white square the client ships, painted by the colour arguments of the
-- texture escape, so a colour shows as itself.
local SWATCH = "Interface/Buttons/WHITE8X8"

--- A school's colour as the client's combat log paints it, by school mask:
-- the player's own setting where the log is loaded, the client's defaults
-- otherwise, nothing under a bare interpreter.
-- @param mask the school mask
-- @return r, g, b in 0..1, or nil
local function schoolColour(mask)
	local array
	if _G.CombatLog_Color_ColorArrayBySchool then
		array = _G.CombatLog_Color_ColorArrayBySchool(mask)
	elseif _G.COMBATLOG_DEFAULT_COLORS then
		local colours = _G.COMBATLOG_DEFAULT_COLORS.schoolColoring
		array = colours and colours[mask]
	end
	if array then
		return array.r, array.g, array.b
	end
	return nil
end

--- Text in a colour given as r, g, b in 0..1: the colour decorates the word
-- and is not itself a value, so no swatch.
local function tinted(r, g, b, text)
	local R, G, B = math.floor(r * 255 + 0.5), math.floor(g * 255 + 0.5), math.floor(b * 255 + 0.5)
	return string.format("|cff%02x%02x%02x", R, G, B) .. text .. END
end

--- How far a spell reaches, as the head line writes it.
-- A melee or weapon band carries a placeholder distance the client replaces
-- with the caster's own reach, so there the word is the whole answer and the
-- number would be a promise the game does not keep. Everything else is
-- written by the catalogue, which is what turns no reach at all into `self`
-- and a band with no far edge into `unlimited`.
-- @param spell a SpellData
-- @return the far edge as written, and the near edge where the band has one
local function reach(spell)
	if spell.rangeMelee then
		return "melee"
	end
	if spell.rangeWeapon then
		return "weapon"
	end
	local far = Epsilook:FormatPartValue("spell", "range", "yards", spell.range)
	if spell.rangeMin > 0 then
		return far, Epsilook:FormatPartValue("spell", "range", "min", spell.rangeMin)
	end
	return far
end

--- The head line: the spell's name as a link, its id, the known mark where
-- the player knows it, school written in the school's own colour, expansion
-- and how far it reaches, then the spell's own actions.
function Inspect.HeadLine(spell)
	local parts = { Shell.SpellLink(spell), GOLD .. spell.id .. END }
	if Shell.Known(spell.id) then
		parts[#parts + 1] = GOLD .. "[known]" .. END
	end
	if spell.subtext ~= "" then
		parts[#parts + 1] = GREY .. spell.subtext .. END
	end
	if spell.school ~= "" then
		local r, g, b = schoolColour(spell.schoolID)
		parts[#parts + 1] = r and tinted(r, g, b, spell.school) or spell.school
	end
	if spell.expansion ~= "" then
		parts[#parts + 1] = spell.expansion
	end
	local far, near = reach(spell)
	parts[#parts + 1] = GREY .. "range " .. far .. END
	if near then
		parts[#parts + 1] = GREY .. "min " .. near .. END
	end
	if spell.iconName ~= "" then
		parts[#parts + 1] = GREY .. "icon " .. spell.iconName .. END
	end
	return Shell.Said(
		table.concat(parts, "  ") .. Shell.DASH .. Shell.SpellActionLinks(spell.id, "dossier")
	)
end

--- What an axis is called on a title: the column's own label.
function Inspect.Label(axis)
	local column = Epsilook.Schema.columnByKey[axis]
	return column and column.label or axis
end

--- The values a part carries, each written, in the catalogue's order.
-- @param part a PartData
-- @return a list of { name, text, id, path, number, colour, stored, vocab }:
--   the property, its value as written, the stored id where the value
--   resolved from one, whether it is a file path, whether it is a bare id,
--   the packed colour where it is one, the stored number itself, and the
--   vocabulary the number was read through, where it was
function Inspect.Values(part)
	local kind = Epsilook.Schema.kindById[part.axis .. "." .. part.kind]
	local out = {}
	for _, prop in ipairs(kind and kind.props or {}) do
		local value = part.values[prop.name]
		if value ~= nil then
			out[#out + 1] = {
				name = prop.name,
				-- What a line or tooltip PRINTS for the property: its spoken word. The name above stays the
				-- storage key every data read keys by.
				label = prop.word or prop.name,
				text = Epsilook:FormatPartValue(part.axis, part.kind, prop.name, value),
				id = type(value) == "table" and value.id or nil,
				path = prop.types[1] == "path",
				number = prop.types[1] == "id" and type(value) ~= "table",
				colour = prop.types[1] == "colour" and value or nil,
				stored = Epsilook.Data.GetStored(part.axis, part.kind, part.slot, prop.name),
				vocab = Epsilook.Data.GetVocabName(part.axis, part.kind, prop.name),
			}
		end
	end
	return out
end

--- A colour painted as itself: a swatch in the colour, then its hex in the
-- colour.
local function painted(colour)
	local r = math.floor(colour / 65536) % 256
	local g = math.floor(colour / 256) % 256
	local b = colour % 256
	local hex = string.format("%02x%02x%02x", r, g, b)
	return "|T"
		.. SWATCH
		.. ":8:8:0:0:8:8:0:8:0:8:"
		.. r
		.. ":"
		.. g
		.. ":"
		.. b
		.. "|t"
		.. "|cff"
		.. hex
		.. "#"
		.. hex
		.. END
end

--- A value as plain text: a path cut to its file name, a colour painted, and
-- the id where a name that resolved from one is blank.
--- A path's last segment.
local function basename(path)
	return path:match("([^/\\]+)$") or path
end

--- The file extensions that tell a reader nothing: every model is an m2 and
-- every texture a blp, so down a list of them the suffix is the same word
-- over and over. A sound keeps its own, because a kit's files come in several
-- formats and which one this is is the informative part.
local MUTE_EXTENSION = { m2 = true, blp = true }

--- A file name with an extension that says nothing taken off.
local function unextended(text)
	local stem, extension = text:match("^(.+)%.(%w+)$")
	if stem and MUTE_EXTENSION[extension:lower()] then
		return stem
	end
	return text
end

local function plain(value)
	if value.path then
		return basename(value.text)
	end
	if value.colour then
		return painted(value.colour)
	end
	if value.id and value.text == "" then
		return tostring(value.id)
	end
	return value.text
end

--- A value as one piece of text for a line: the plain text, and where a
-- name resolved from an id both, written `name - id` as the server writes
-- them.
local function written(value)
	if value.id and value.text ~= "" then
		return value.text .. " - " .. value.id
	end
	return plain(value)
end

--- The values written bare beside a subject, without their word: a phrase
-- that reads on its own, and an attachment point, which can only be where
-- the model hangs. Keyed by the property's storage name.
local BARE = { how = true, where = true }

--- A value beside a subject on a line: its name in grey and the value, a
-- target written as who it is on.
local function beside(value)
	if value.name == "target" then
		return GREY .. "on " .. END .. value.text
	elseif BARE[value.name] then
		return written(value)
	end
	return GREY .. value.label .. " " .. END .. written(value)
end

--- A value joined to the line before it: one more field, after the dash
-- the line's fields are split by.
local function joined(value)
	return Shell.DASH .. beside(value)
end

--- What the client shows for an item: its name where the pack has none and
-- the client has it loaded, its icon, and the colour of its quality. Each
-- falls back to the pack's own where the client has nothing.
-- @param id the item id
-- @param name the pack's name for it
-- @return the name, the icon's file id or nil, and the colour code or nil
local function itemShown(id, name)
	local icon, colour
	if _G.GetItemInfoInstant then
		icon = select(5, _G.GetItemInfoInstant(id))
	end
	if _G.GetItemInfo then
		local known, _, quality = _G.GetItemInfo(id)
		if known and name == "" then
			name = known
		end
		if quality and _G.GetItemQualityColor then
			local hex = select(4, _G.GetItemQualityColor(quality))
			colour = hex and "|c" .. hex or nil
		end
	end
	return name, icon, colour
end

--- The values with one moved to the front.
local function leading(values, i)
	if i == 1 then
		return values
	end
	local out = { values[i] }
	for j, other in ipairs(values) do
		if j ~= i then
			out[#out + 1] = other
		end
	end
	return out
end

--- The file id behind a list's path value, where it has one: what a texture
-- escape draws.
local function pathFid(values)
	for _, value in ipairs(values) do
		if value.path and value.stored then
			return value.stored
		end
	end
	return nil
end

--- The subject of a list of values: the first that names something, moved
-- to the front -- a bare id yields to a name beside it, so a kit shows by
-- its animation rather than its number, and a blank name yields to the id
-- or the file beside it. A target is who a part plays on, never what it is,
-- and is not a subject.
-- @param values as Inspect.Values gives them
-- @return the values with the subject first, possibly empty
local function led(values)
	for i, value in ipairs(values) do
		if value.text ~= "" and not value.number and value.name ~= "target" then
			return leading(values, i)
		end
	end
	for i, value in ipairs(values) do
		if (value.text ~= "" or value.id) and value.name ~= "target" then
			return leading(values, i)
		end
	end
	return {}
end

--- The subject of a part, as shown on its line.
-- @param part a PartData
-- @return the text, or nil for a part that says nothing
function Inspect.Subject(part)
	local first = led(Inspect.Values(part))[1]
	return first and written(first) or nil
end

--- A value as the tooltip writes it: a path whole; a word the pack read
-- out of a vocabulary with the number it stands for beside it, since the
-- number is what the game's own tables hold and what another tool calls
-- it; every other value as the line writes it.
local function detailed(value)
	if value.path then
		return value.text
	end
	if value.vocab and not value.id and not value.colour and value.text ~= "" then
		return value.text .. " - " .. value.stored
	end
	return written(value)
end

--- Fill a tooltip with a part: its kind as the title and what the kind
-- means under it, then one line per value, a path written whole and a
-- vocabulary word with its number, then what the part carries beyond its
-- properties -- an effect's implicit targets and the aura it applies --
-- then the creature displays it names, each with its model file and the
-- textures it paints, so a creature reads down to what it looks like.
-- Each is one unwrapped line rather than a double line, because a double
-- line's right half does not widen the tooltip and a long path would run
-- past it, and an unwrapped line always sizes the frame to itself.
-- @param tooltip the GameTooltip, already owned
-- @param part a PartData
function Inspect.FillTooltip(tooltip, part)
	tooltip:SetText(part.kind, 1, 1, 1)
	local kind = Epsilook.Schema.kindById[part.axis .. "." .. part.kind]
	if kind and kind.hint and kind.hint ~= "" then
		tooltip:AddLine(kind.hint, 0.62, 0.62, 0.62)
	end
	local values = Inspect.Values(part)
	for _, value in ipairs(values) do
		tooltip:AddLine(GREY .. value.label .. END .. " " .. detailed(value), 1, 1, 1)
	end
	for _, extra in ipairs(Epsilook:GetPartExtras(part)) do
		local text = extra.text ~= "" and extra.text or tostring(extra.value)
		tooltip:AddLine(GREY .. extra.name .. END .. " " .. text, 1, 1, 1)
	end
	for _, display in ipairs(Epsilook:GetPartDisplays(part)) do
		-- A display the part carries itself is on the lines above already,
		-- and only its skins follow; one reached through a creature is named
		-- here, with the model it wears.
		if display.file then
			tooltip:AddLine(GREY .. "display" .. END .. " " .. display.id, 1, 1, 1)
			if display.file.text ~= "" then
				tooltip:AddLine(GREY .. "  model" .. END .. " " .. display.file.text, 1, 1, 1)
			end
		end
		for _, skin in ipairs(display.skins) do
			local indent = display.file and "  " or ""
			tooltip:AddLine(GREY .. indent .. "skin" .. END .. " " .. skin.text, 1, 1, 1)
		end
	end
	local texture, fid = Inspect.TEXTURES[part.axis .. "." .. part.kind], pathFid(values)
	if texture and texture.tip and fid then
		tooltip:AddLine(
			"|T" .. fid .. ":" .. texture.tip.height .. ":" .. texture.tip.width .. "|t"
		)
	end
	Inspect.FillPalette(tooltip, part)
end

--- What a screen effect paints, in the tooltip: a palette line with a swatch
-- and its hex for the fog, the multiply and the add colour, each where the
-- effect has one, the hue words after, then the textures it draws. Only a
-- screen part carries one.
-- @param tooltip the GameTooltip, already owned
-- @param part a PartData
function Inspect.FillPalette(tooltip, part)
	local screenID = Epsilook.Data.GetCarried(part.axis, part.kind, part.slot, "screen")
	local screen = screenID and Epsilook:GetScreenEffect(screenID)
	if not screen then
		return
	end
	local swatches = {}
	for _, entry in ipairs({ { "fog", screen.fog }, { "mul", screen.mul }, { "add", screen.add } }) do
		if entry[2] and entry[2] >= 0 then
			swatches[#swatches + 1] = GREY .. entry[1] .. " " .. END .. painted(entry[2])
		end
	end
	if #swatches > 0 then
		tooltip:AddLine(table.concat(swatches, "  "))
	end
	if screen.hues ~= "" then
		tooltip:AddLine(GREY .. "hues " .. END .. screen.hues, 1, 1, 1)
	end
	-- The effect's own textures: the finished art at the screen's size, the
	-- masks that shape it at half.
	local art, masks = Inspect.TEXTURES["fx.screen"].tip, Inspect.TEXTURES["fx.screen"].mask
	for _, texture in ipairs(screen.textures) do
		local size = texture.role == 0 and art or masks
		tooltip:AddLine("|T" .. texture.fid .. ":" .. size.height .. ":" .. size.width .. "|t")
	end
end

--- Fill a tooltip with a group: the property it is grouped under as the
-- title and its value -- a kit's name and id -- and nothing of the part the
-- link happens to point at, whose file is listed beneath the group anyway.
-- @param tooltip the GameTooltip, already owned
-- @param part the group's first part
function Inspect.FillGroupTooltip(tooltip, part)
	local group = groupOf(part)
	tooltip:SetText(group and (group.kind or group.prop) or part.kind, 1, 1, 1)
	for _, value in ipairs(Inspect.Values(part)) do
		if grouped(group, value.name) then
			tooltip:AddLine(written(value), 1, 1, 1)
		end
	end
end

--- Fill a tooltip with what a spell has on one axis: the count as the title,
-- then each part's kind and subject, up to a limit.
-- @param tooltip the GameTooltip, already owned
-- @param spellID the spell
-- @param axis the axis
function Inspect.FillAxisTooltip(tooltip, spellID, axis)
	local n = Epsilook:GetPartCounts(spellID)[axis] or 0
	tooltip:SetText(n .. " " .. Inspect.Label(axis), 1, 1, 1)
	local part = {}
	for i = 1, math.min(n, Inspect.LISTED) do
		Epsilook:GetPartDataByIndex(spellID, axis, i, part)
		tooltip:AddLine(
			GREY .. part.kind .. END .. " " .. unextended(Inspect.Subject(part) or ""),
			1,
			1,
			1
		)
	end
	if n > Inspect.LISTED then
		tooltip:AddLine("and " .. (n - Inspect.LISTED) .. " more", 0.62, 0.62, 0.62)
	end
end

--- The one stored number an action needs off a part: the value's own number
-- for a named property, the raw stored number otherwise.
local function needed(part, name)
	local value = part.values[name]
	if type(value) == "table" then
		return value.id
	end
	return Epsilook.Data.GetStored(part.axis, part.kind, part.slot, name)
end

--- The spawn id for a part's file, where the pack knows one.
local function spawnOf(part)
	local spawn = Epsilook:GetSpawnIDByFile(needed(part, "file"))
	return spawn ~= nil and spawn ~= 0 and spawn or nil
end

--- The emote an animation action sends, for the animation the action's
-- property names: a one-shot emote plays on the current animation and a
-- looping one sets the standing pose, and each action takes the other where
-- the animation has only one.
local function emoteOf(part, key, prop)
	local oneshot, loop = Epsilook:GetEmotesByAnim(needed(part, prop) or -1)
	local emote = key == "anim" and oneshot or loop
	if emote == 0 then
		emote = key == "anim" and loop or oneshot
	end
	return emote ~= 0 and emote or nil
end

--- Whether an item is named anywhere the addon can reach: by the pack, or
-- by the client where it has the item loaded. An item nobody names cannot
-- be added by id with any confidence and is looked up by its model instead.
local function itemNamed(part)
	local name = part.values.name
	if type(name) == "table" then
		name = name.text
	end
	if type(name) == "string" and name ~= "" then
		return true
	end
	local id = needed(part, "id")
	return id ~= nil and _G.GetItemInfo ~= nil and _G.GetItemInfo(id) ~= nil
end

--- A model's file name without its path or extension, what `.lookup item`
-- finds an unnamed item's template by.
local function modelName(part)
	return (basename(part.values.file or ""):gsub("%.[^.]*$", ""))
end

--- What an action sends for a part, or nil where the part cannot take the
-- action: the spawn id for a model's file, the emote for an animation, the
-- model's name for an item lookup, the stored value the action names
-- otherwise, and nil for an action the part's kind does not take or lacks
-- the value for. An item is added only where something names it and looked
-- up only where nothing does.
-- @param part a PartData
-- @param action an Action of the part's axis
-- @return the number or text, or nil
function Inspect.ArgumentOf(part, action)
	if action.kind and action.kind ~= part.kind or action.except and action.except[part.kind] then
		return nil
	end
	if part.values[action.needs] == nil then
		return nil
	end
	if action.via == "creatureDisplay" then
		local display = Epsilook:GetDisplayByCreature(needed(part, action.needs))
		return display ~= nil and display ~= 0 and display or nil
	elseif action.via == "factor" then
		-- A change of -70% is the factor 0.3, which is what the command takes.
		local change = needed(part, action.needs)
		return change ~= nil and (100 + change) / 100 or nil
	elseif action.needs == "file" and action.key == "spawn" then
		return spawnOf(part)
	elseif action.key == "anim" or action.key == "stand" then
		return emoteOf(part, action.key, action.needs)
	elseif action.key == "add" then
		return itemNamed(part) and needed(part, action.needs) or nil
	elseif action.key == "lookup" then
		return not itemNamed(part) and modelName(part) or nil
	end
	return needed(part, action.needs)
end

--- Whether a part can take an action: it has something to send for it.
local function takes(part, action)
	return Inspect.ArgumentOf(part, action) ~= nil
end

--- The colour Epsilon's own `.lookup emote` draws an emote link in.
local EMOTE = "|cffadffff"

--- The game's own link, as the server prints one, around a number and a name.
local function gameLink(linkType, number, name, colour)
	return (colour or WHITE) .. "|H" .. linkType .. ":" .. number .. "|h[" .. name .. "]|h" .. END
end

--- A bare number for the chat box.
local function bare(number)
	return tostring(number)
end

--- What a shift-click on a part hands the chat box, by the action the part's
-- line leads with: the game's own link where the server reads one back --
-- an item, a creature entry, a gameobject entry for an object -- and the
-- bare number elsewhere, which is what a model's spawn id, an emote, a
-- display, a kit and a sound file are typed as. An action not named here
-- hands nothing over, and a line with no such action is no link. Each
-- carries the tooltip line that says so; an entry with no `text` hands the
-- bare number.
local INSERTS = {
	spawn = {
		hint = "Shift-click for the id .gob spawn takes",
		text = function(number, name, action)
			if action.needs == "object" then
				return gameLink("gameobject_entry", number, name)
			end
			return bare(number)
		end,
	},
	add = {
		hint = "Shift-click to link the item",
		text = function(number, name)
			return gameLink("item", number .. ":0:0:0:0:0:0:0:0", name)
		end,
	},
	summon = {
		hint = "Shift-click to link the creature",
		text = function(number, name)
			return gameLink("creature_entry", number, name)
		end,
	},
	anim = {
		hint = "Shift-click to link the emote in chat",
		text = function(number, name)
			return gameLink("emoteID", number, name, EMOTE)
		end,
	},
	stand = {
		hint = "Shift-click to link the emote in chat",
		text = function(number, name)
			return gameLink("emoteID", number, name, EMOTE)
		end,
	},
	speed = { hint = "Shift-click for the factor" },
	native = { hint = "Shift-click for the display id" },
	morph = { hint = "Shift-click for the display id" },
	mount = { hint = "Shift-click for the display id" },
	animKit = { hint = "Shift-click for the kit id" },
	playKit = { hint = "Shift-click for the kit id" },
	play = { hint = "Shift-click for the file id" },
}

--- The server commands the actions send, by key, each taking the action's
-- argument. The sound actions are not here: they are the client's own calls.
local COMMANDS = {
	spawn = "gob spawn %s",
	add = "additem %s",
	lookup = "lookup item %s",
	summon = "npc spawn %s",
	native = "mod native %s",
	speed = "mod speed %s",
	morph = "morph %s",
	mount = "mod mount %s",
	animKit = "mod animkit %s",
	anim = "mod anim %s",
	stand = "mod standstate %s",
}

--- What a shift-click on a part's line hands the chat box: the first of the
-- line's actions that has something to hand over, rendered for the chat box.
-- @param part a PartData
-- @param actions the actions the line carries
-- @param name the part's subject as shown
-- @return the text to insert and the hint saying so, or nil
function Inspect.ClipOf(part, actions, name)
	for _, action in ipairs(actions) do
		local insert = INSERTS[action.key]
		local argument = insert and Inspect.ArgumentOf(part, action)
		if argument then
			return (insert.text or bare)(argument, name, action), insert.hint
		end
	end
	return nil
end

--- What a copy on a part's line hands the chat box: the argument of the
-- first of the line's actions that a server command takes, which is what a
-- player types after that command by hand. A text argument is not one -- an
-- item's lookup takes a model's name, and its own action already sends it --
-- so only a number is copied, and a line whose actions are the client's own
-- calls offers no copy at all.
-- @param part a PartData
-- @param actions the actions the line carries
-- @return the number and the command it feeds, or nil
function Inspect.CopyOf(part, actions)
	for _, action in ipairs(actions) do
		local command = COMMANDS[action.key]
		local argument = command and Inspect.ArgumentOf(part, action)
		if type(argument) == "number" then
			return argument, command
		end
	end
	return nil
end

--- The actions a part can take, of those offered, as links, and the copy
-- that hands the chat box the number a command takes, where one does.
-- @param spellID the spell
-- @param part a PartData
-- @param n the part's row on its axis, counted from one
-- @param actions the actions to offer
-- @param verb the line's verb, which says which copy the line draws
-- @return the links joined, possibly empty
function Inspect.ActionLinks(spellID, part, n, actions, verb)
	local out = {}
	for _, action in ipairs(actions) do
		if takes(part, action) then
			out[#out + 1] = Shell.Link(spellID, action.key, action.label, part.axis, n)
		end
	end
	if COPY_VERB[verb] and Inspect.CopyOf(part, actions) then
		out[#out + 1] = Shell.Link(spellID, COPY_VERB[verb], "Copy Entry", part.axis, n)
	end
	return table.concat(out, Shell.DASH)
end

--- The actions of an axis split by whether they take the property the axis
-- groups under.
-- @return the group's actions, and the rest
local function actionsSplit(axis)
	local grouping = Inspect.GROUPS[axis]
	local key = grouping and grouping.prop
	local group, rest = {}, {}
	for _, action in ipairs(Epsilook:GetActions(axis)) do
		if action.needs == key then
			group[#group + 1] = action
		else
			rest[#rest + 1] = action
		end
	end
	return group, rest
end

--- The values of a part on one of its lines: for the group's line the group's
-- own, for a line under a group every other, for a part on its own all of
-- them; the subject first.
local function valuesFor(part, verb)
	local grouping = groupOf(part)
	local out = {}
	for _, value in ipairs(Inspect.Values(part)) do
		local mine = grouped(grouping, value.name)
		if verb == Inspect.GROUP and mine or verb ~= Inspect.GROUP and not mine then
			out[#out + 1] = value
		end
	end
	return led(out)
end

--- The actions a part's line carries: the group's for the group's line, the
-- rest otherwise.
local function actionsFor(axis, verb)
	local group, rest = actionsSplit(axis)
	if verb == Inspect.GROUP then
		return group
	end
	return rest
end

--- One line: an indent, a cyan label where there is one, the subject as a
-- link where a shift-click has something to hand over and as plain text
-- otherwise, the other values beside a plain subject, and the actions.
-- @param spellID the spell
-- @param part a PartData
-- @param n the part's row on its axis
-- @param indent the indent
-- @param label the label, or nil
-- @param verb the link's verb, which also says which values and actions
-- @return the line
local function line(spellID, part, n, indent, label, verb)
	local values, actions = valuesFor(part, verb), actionsFor(part.axis, verb)
	local out = indent
	local subject = values[1]
	local extras = Epsilook:GetPartExtras(part)
	local named = extras[1] and extras[1].text ~= ""
	if label then
		local tone = Shell.AXIS_COLOURS[part.axis] or CYAN
		if subject or named then
			-- A label with a subject after it takes a colon.
			out = out .. tone .. label .. ":" .. END .. " "
		else
			-- A label on its own names a part that is nothing but its kind, and
			-- is the part's link, so its tooltip can say what the kind means.
			out = out .. Shell.Link(spellID, verb, label, part.axis, n, tone)
		end
	end
	local vocab = subject and Epsilook.Data.GetVocabName(part.axis, part.kind, subject.name)
	-- An item's name may be blank and yield the lead to its id; the item is
	-- still an item, so the items reading looks past the subject.
	local item
	for _, value in ipairs(values) do
		if Epsilook.Data.GetVocabName(part.axis, part.kind, value.name) == "items" then
			item = value
		end
	end
	local links
	if vocab == "spells" then
		-- Another spell: the game's own link to it, and its own actions.
		out = out .. Shell.SpellLink({ id = subject.id, name = subject.text, icon = 0 })
		for i = 2, #values do
			out = out .. joined(values[i])
		end
		links = Shell.SpellActionLinks(subject.id, "result")
	elseif subject then
		local shown, icon, colour = written(subject), nil, WHITE
		local stated = {}
		if item then
			-- A name the pack resolved is an id and a text; one it could not
			-- is the bare stored number, and then the pack has no name.
			local id = item.id or item.stored
			local name
			name, icon, colour = itemShown(id, item.text)
			colour = colour or WHITE
			if name ~= "" then
				shown = written({ text = name, id = id })
			else
				-- Nothing names the item; its model's name and id are what it
				-- goes by, so the file and id beside it would say it twice. It
				-- reads as an item, bracketed, even where it is no link.
				shown = "[" .. modelName(part) .. " - " .. id .. "]"
				stated = { file = true, id = true }
			end
		end
		local texture, fid = Inspect.TEXTURES[part.axis .. "." .. part.kind], pathFid(values)
		if texture and texture.line and fid then
			out = out
				.. "|T"
				.. fid
				.. ":"
				.. texture.line.height
				.. ":"
				.. texture.line.width
				.. "|t "
		end
		local pictured = texture and texture.tip and (fid or part.kind == "screen")
		if Inspect.DETAILED[part.axis] or pictured or Inspect.ClipOf(part, actions, shown) then
			out = out .. Shell.Link(spellID, verb, shown, part.axis, n, colour, icon)
			if Inspect.ROLED[part.axis .. "." .. part.kind] then
				out = out .. Shell.DASH .. GREY .. subject.label .. END
			end
			local shownBeside = Inspect.BESIDE[part.axis]
			for i = 2, #values do
				if shownBeside and shownBeside[values[i].name] and values[i].text ~= "" then
					out = out .. joined(values[i])
				end
			end
		else
			if icon then
				out = out .. "|T" .. icon .. ":" .. Shell.ICON .. "|t"
			end
			out = out .. colour .. shown .. END
			for i = 2, #values do
				if (values[i].text ~= "" or values[i].id) and not stated[values[i].name] then
					out = out .. joined(values[i])
				end
			end
		end
		links = Inspect.ActionLinks(spellID, part, n, actions, verb)
	else
		-- A part with no value of its own may still be named by what it
		-- carries -- a screen part by its screen effect -- and that name is
		-- its link, with the effect in the tooltip.
		if named then
			out = out .. Shell.Link(spellID, verb, extras[1].text, part.axis, n, WHITE)
		end
		links = Inspect.ActionLinks(spellID, part, n, actions, verb)
	end
	if links ~= "" then
		out = out .. Shell.DASH .. links
	end
	return out
end

--- One part's line on its own: its kind as the label and everything it has.
function Inspect.PartLine(spellID, part, n)
	return line(spellID, part, n, "  ", part.kind, Inspect.PART)
end

--- A group's line: the property as the label, its value as the subject, the
-- actions that take it.
-- @param spellID the spell
-- @param part the group's first part
-- @param n that part's row
function Inspect.GroupLine(spellID, part, n)
	local group = groupOf(part)
	return line(spellID, part, n, "  ", group and (group.kind or group.prop), Inspect.GROUP)
end

--- A part's line under its group: no label, the values but the group's.
function Inspect.MemberLine(spellID, part, n)
	return line(spellID, part, n, "    ", nil, Inspect.PART)
end

--- The action a part takes under a key, or nil. A key may be declared more
-- than once on an axis, once per kind that takes it with the property it
-- takes it by, so the part decides which entry is meant.
local function actionOf(axis, key, part)
	for _, action in ipairs(Epsilook:GetActions(axis)) do
		if action.key == key and takes(part, action) then
			return action
		end
	end
	return nil
end

--- What a tooltip says a click on one of this file's links will do.
-- @param axis the part's axis
-- @param verb the link's verb
-- @param part the part, for the shift-click hint on its own link
-- @return the hint, or nil for a verb the axis does not offer
function Inspect.HintOf(axis, verb, part)
	if verb == Inspect.LIST then
		return "The spell's " .. Inspect.Label(axis):lower()
	end
	if not part then
		-- A link out of old scrollback whose row the pack no longer carries.
		-- The click path says so; a hover has nothing to say and must not
		-- raise, since a throw here happens before the tooltip is shown.
		return nil
	end
	if verb == Inspect.PART or verb == Inspect.GROUP then
		local _, hint = Inspect.ClipOf(part, actionsFor(axis, verb), "")
		return hint
	elseif COPY_LINE[verb] then
		local _, command = Inspect.CopyOf(part, actionsFor(axis, COPY_LINE[verb]))
		if not command then
			return nil
		end
		return "Puts it in your chat box, for ." .. command:gsub(" %%s", "")
	end
	local action = actionOf(axis, verb, part)
	return action and action.hint or nil
end

--- What a shift-click on a part's own link hands the chat box.
-- @param spellID the spell
-- @param verb the link's verb
-- @param axis the part's axis
-- @param n the part's row
-- @return the text, or nil
function Inspect.Clip(spellID, verb, axis, n)
	local part = Epsilook:GetPartDataByIndex(spellID, axis, n)
	if not part or (verb ~= Inspect.PART and verb ~= Inspect.GROUP) then
		return nil
	end
	local subject = valuesFor(part, verb)[1]
	return Inspect.ClipOf(part, actionsFor(axis, verb), subject and plain(subject) or "")
end

--- Print one axis of a spell's dossier: its title, then its lines, grouped
-- where the axis groups.
-- @param spellID the spell
-- @param axis the axis
-- @param say the function that prints a line
function Inspect.PrintAxis(spellID, axis, say)
	local n = Epsilook:GetPartCounts(spellID)[axis] or 0
	if n == 0 then
		return
	end
	say(GOLD .. n .. " " .. Inspect.Label(axis) .. END)
	local seen
	for i = 1, n do
		local part = Epsilook:GetPartDataByIndex(spellID, axis, i)
		local grouping = groupOf(part)
		if not grouping then
			seen = nil
			say(Inspect.PartLine(spellID, part, i))
		else
			local group = part.values[grouping.prop]
			local id = type(group) == "table" and group.id or group
			if id ~= seen then
				seen = id
				say(Inspect.GroupLine(spellID, part, i))
			end
			say(Inspect.MemberLine(spellID, part, i))
		end
	end
end

--- Print a spell's dossier through `say`, one line at a time.
-- @param spellID the spell
-- @param say the function that prints a line
function Inspect.Print(spellID, say)
	local spell = Epsilook:GetSpellDataByID(spellID)
	if not spell then
		say(Shell.Said(RED .. "no spell " .. tostring(spellID) .. " in this pack" .. END))
		return
	end
	local printed = false
	local function printNow()
		if printed then
			return
		end
		printed = true
		say(Inspect.HeadLine(spell))
		for _, axis in ipairs(Epsilook:GetPartAxes()) do
			Inspect.PrintAxis(spellID, axis, say)
		end
	end
	Inspect.WhenItemsLoaded(spellID, printNow)
end

--- How long the dossier waits for the client to load an item before it
-- prints with what it has, in seconds.
Inspect.ITEM_WAIT = 1

--- The item ids a spell's parts name that the client has not loaded yet.
local function unloadedItems(spellID)
	local ids = {}
	local make = _G.Item and _G.Item.CreateFromItemID
	if not make then
		return ids
	end
	local counts = Epsilook:GetPartCounts(spellID)
	for _, axis in ipairs(Epsilook:GetPartAxes()) do
		for i = 1, counts[axis] or 0 do
			local part = Epsilook:GetPartDataByIndex(spellID, axis, i)
			for name, value in pairs(part.values) do
				if
					type(value) == "table"
					and Epsilook.Data.GetVocabName(axis, part.kind, name) == "items"
				then
					local item = make(_G.Item, value.id)
					if not item:IsItemEmpty() and not item:IsItemDataCached() then
						ids[#ids + 1] = value.id
					end
				end
			end
		end
	end
	return ids
end

--- Run a function once the client has loaded the items a spell's parts name,
-- so their names, icons and qualities print; at once where it has them or
-- there is no client, and after a short wait regardless, so an item the
-- client cannot load never holds the dossier.
-- @param spellID the spell
-- @param continue the function to run
function Inspect.WhenItemsLoaded(spellID, continue)
	local pending = unloadedItems(spellID)
	if #pending == 0 then
		continue()
		return
	end
	local left = #pending
	for _, id in ipairs(pending) do
		_G.Item:CreateFromItemID(id):ContinueOnItemLoad(function()
			left = left - 1
			if left == 0 then
				continue()
			end
		end)
	end
	if _G.C_Timer and _G.C_Timer.After then
		_G.C_Timer.After(Inspect.ITEM_WAIT, continue)
	end
end

--- Sound handles by what was played, so a stop link can find its sound.
local playing = {}

--- Execute one dossier action from its link. A part's own link does nothing
-- on a plain click, as the game's own name links do; an axis's count prints
-- that axis.
-- @param spellID the spell
-- @param key the action, as ACTIONS names it, or one of this file's verbs
-- @param axis the part's axis
-- @param n the part's row on that axis
-- @param say the function that prints a line
function Inspect.Execute(spellID, key, axis, n, say)
	if key == Inspect.LIST then
		Inspect.WhenItemsLoaded(spellID, function()
			Inspect.PrintAxis(spellID, axis, say)
		end)
		return
	end
	local part = Epsilook:GetPartDataByIndex(spellID, axis, n)
	if not part then
		say(Shell.Said(RED .. "that part is no longer in the pack" .. END))
		return
	end
	if COPY_LINE[key] then
		local argument = Inspect.CopyOf(part, actionsFor(axis, COPY_LINE[key]))
		if argument then
			Shell.Type(tostring(argument))
		end
		return
	end
	local action = actionOf(axis, key, part)
	if not action then
		return
	end
	local argument = Inspect.ArgumentOf(part, action)
	if COMMANDS[key] then
		Shell.Send(COMMANDS[key]:format(argument))
	elseif key == "play" or key == "playKit" then
		local player
		if key == "play" then
			player = _G.PlaySoundFile
		else
			player = _G.PlaySound
		end
		if player then
			local ok, handle = player(argument)
			if ok then
				playing[key .. argument] = handle
			end
		end
	elseif key == "stop" or key == "stopKit" then
		local handle = playing[(key == "stop" and "play" or "playKit") .. argument]
		if handle and _G.StopSound then
			_G.StopSound(handle)
		end
	end
end

return Inspect

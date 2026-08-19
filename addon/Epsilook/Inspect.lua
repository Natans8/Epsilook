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
-- and an axis's count on a result line.
Inspect.PART = "part"
Inspect.GROUP = "group"
Inspect.LIST = "list"

--- The property an axis's parts are grouped under, where they are: the
-- group's line leads, with the actions that take that property, and the
-- parts follow indented with the rest.
Inspect.GROUPS = { sound = "kit" }

--- How many parts an axis's tooltip lists before it says how many more.
Inspect.LISTED = 12

--- The head line: the spell's name as a link, its id, school and expansion.
function Inspect.HeadLine(spell)
	local parts = { Shell.SpellLink(spell), GOLD .. spell.id .. END }
	if spell.subtext ~= "" then
		parts[#parts + 1] = GREY .. spell.subtext .. END
	end
	if spell.school ~= "" then
		parts[#parts + 1] = spell.school
	end
	if spell.expansion ~= "" then
		parts[#parts + 1] = spell.expansion
	end
	if spell.iconName ~= "" then
		parts[#parts + 1] = GREY .. "icon " .. spell.iconName .. END
	end
	return Shell.Said(table.concat(parts, "  "))
end

--- What an axis is called on a title: the column's own label.
function Inspect.Label(axis)
	local column = Epsilook.Schema.columnByKey[axis]
	return column and column.label or axis
end

--- The values a part carries, each written, in the catalogue's order.
-- @param part a PartData
-- @return a list of { name, text, id, path }: the property, its value as
--   written, the stored id where the value resolved from one, and whether it
--   is a file path
function Inspect.Values(part)
	local kind = Epsilook.Schema.kindById[part.axis .. "." .. part.kind]
	local out = {}
	for _, prop in ipairs(kind and kind.props or {}) do
		local value = part.values[prop.name]
		if value ~= nil then
			out[#out + 1] = {
				name = prop.name,
				text = Epsilook:FormatPartValue(part.axis, part.kind, prop.name, value),
				id = type(value) == "table" and value.id or nil,
				path = prop.types[1] == "path",
			}
		end
	end
	return out
end

--- A value as plain text: a path cut to its file name, and the id where a
-- name that resolved from one is blank.
local function plain(value)
	if value.path then
		return value.text:match("([^/\\]+)$") or value.text
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

--- The values written bare beside a subject, without their name: a phrase
-- that reads on its own.
local BARE = { how = true }

--- A value beside a subject on a line: its name in grey and the value, a
-- target written as who it is on.
local function beside(value)
	if value.name == "target" then
		return GREY .. "on " .. END .. value.text
	elseif BARE[value.name] then
		return written(value)
	end
	return GREY .. value.name .. " " .. END .. written(value)
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

--- The subject of a list of values: the first that says anything, moved to
-- the front, so a blank name yields to the id or the file beside it.
-- @param values as Inspect.Values gives them
-- @return the values with the subject first, possibly empty
local function led(values)
	for i, value in ipairs(values) do
		if value.text ~= "" or value.id then
			if i == 1 then
				return values
			end
			local out = { value }
			for j, other in ipairs(values) do
				if j ~= i then
					out[#out + 1] = other
				end
			end
			return out
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

--- Fill a tooltip with a part: its kind as the title, then one line per value,
-- a path written whole.
-- @param tooltip the GameTooltip, already owned
-- @param part a PartData
function Inspect.FillTooltip(tooltip, part)
	tooltip:SetText(part.kind, 1, 1, 1)
	for _, value in ipairs(Inspect.Values(part)) do
		local text = value.path and value.text or written(value)
		tooltip:AddDoubleLine(value.name, text, 0.62, 0.62, 0.62, 1, 1, 1)
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
		tooltip:AddDoubleLine(part.kind, Inspect.Subject(part) or "", 0.62, 0.62, 0.62, 1, 1, 1)
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

--- The emote an animation action sends: a one-shot emote plays on the current
-- animation and a looping one sets the standing pose, and each action takes
-- the other where the animation has only one.
local function emoteOf(part, key)
	local oneshot, loop = Epsilook:GetEmotesByAnim(needed(part, "anim") or -1)
	local emote = key == "anim" and oneshot or loop
	if emote == 0 then
		emote = key == "anim" and loop or oneshot
	end
	return emote ~= 0 and emote or nil
end

--- The number an action sends for a part, or nil where the part cannot take
-- the action: the spawn id for a model's file, the emote for an animation,
-- the stored value the action names otherwise, and nil for an action needing
-- nothing or one the part's kind does not take.
-- @param part a PartData
-- @param action an Action of the part's axis
-- @return the number, or nil
function Inspect.ArgumentOf(part, action)
	if action.kind and action.kind ~= part.kind or action.except == part.kind then
		return nil
	end
	if action.needs == "" or part.values[action.needs] == nil then
		return nil
	end
	if action.needs == "file" and action.key == "spawn" then
		return spawnOf(part)
	elseif action.key == "anim" or action.key == "stand" then
		return emoteOf(part, action.key)
	end
	return needed(part, action.needs)
end

--- Whether a part can take an action: it is of the action's kind and not
-- the kind it excepts, and it needs nothing or has what the action sends.
local function takes(part, action)
	if action.kind and action.kind ~= part.kind or action.except == part.kind then
		return false
	end
	return action.needs == "" or Inspect.ArgumentOf(part, action) ~= nil
end

--- The game's own link, as the server prints one, around a number and a name.
local function gameLink(linkType, number, name)
	return WHITE .. "|H" .. linkType .. ":" .. number .. "|h[" .. name .. "]|h" .. END
end

--- A bare number for the chat box.
local function bare(number)
	return tostring(number)
end

--- What a shift-click on a part hands the chat box, by the action the part's
-- line leads with: the game's own link where the server reads one back --
-- an item, a creature entry, a gameobject entry for an object -- and the
-- bare id elsewhere, which is what a model's spawn id, an emote, a kit and
-- a sound file are typed as. An action not named here hands nothing over,
-- and a line with no such action is no link. Each carries the tooltip line
-- that says so.
local INSERTS = {
	spawn = {
		hint = "Shift-click to type this into chat, as .gob spawn takes it",
		text = function(number, name, action)
			if action.needs == "object" then
				return gameLink("gameobject_entry", number, name)
			end
			return bare(number)
		end,
	},
	add = {
		hint = "Shift-click to link this item in chat, as .additem takes it",
		text = function(number, name)
			return gameLink("item", number .. ":0:0:0:0:0:0:0:0", name)
		end,
	},
	summon = {
		hint = "Shift-click to link this creature in chat, as .npc spawn takes it",
		text = function(number, name)
			return gameLink("creature_entry", number, name)
		end,
	},
	morph = {
		hint = "Shift-click to type this display id into chat, as .morph takes it",
		text = bare,
	},
	anim = {
		hint = "Shift-click to type this emote id into chat, as .mod anim takes it",
		text = bare,
	},
	stand = {
		hint = "Shift-click to type this emote id into chat, as .mod standstate takes it",
		text = bare,
	},
	playKit = {
		hint = "Shift-click to type this kit id into chat, as .phase playsound takes it",
		text = bare,
	},
	play = { hint = "Shift-click to type this sound file id into chat", text = bare },
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
			return insert.text(argument, name, action), insert.hint
		end
	end
	return nil
end

--- The actions a part can take, of those offered, as links.
-- @param spellID the spell
-- @param part a PartData
-- @param n the part's row on its axis, counted from one
-- @param actions the actions to offer
-- @return the links joined, possibly empty
function Inspect.ActionLinks(spellID, part, n, actions)
	local out = {}
	for _, action in ipairs(actions) do
		if takes(part, action) then
			out[#out + 1] = Shell.Link(spellID, action.key, action.label, part.axis, n)
		end
	end
	return table.concat(out, Shell.DASH)
end

--- The actions of an axis split by whether they take the property the axis
-- groups under.
-- @return the group's actions, and the rest
local function actionsSplit(axis)
	local key = Inspect.GROUPS[axis]
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

--- The values of a part on one of its lines: for the group's line the group
-- property alone, for a line under a group every other, for a part on its
-- own all of them; the subject first.
local function valuesFor(part, verb)
	local key = Inspect.GROUPS[part.axis]
	local out = {}
	for _, value in ipairs(Inspect.Values(part)) do
		local grouped = value.name == key
		if verb == Inspect.GROUP and grouped or verb ~= Inspect.GROUP and not grouped then
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
	if label then
		out = out .. CYAN .. label .. ":" .. END .. " "
	end
	local subject = values[1]
	local vocab = subject and Epsilook.Data.GetVocabName(part.axis, part.kind, subject.name)
	local links
	if vocab == "spells" then
		-- Another spell: the game's own link to it, and its own actions.
		out = out .. Shell.SpellLink({ id = subject.id, name = subject.text, icon = 0 })
		for i = 2, #values do
			out = out .. "  " .. beside(values[i])
		end
		links = Shell.SpellActionLinks(subject.id)
	elseif subject then
		local shown, icon, colour = written(subject), nil, WHITE
		if vocab == "items" then
			local name
			name, icon, colour = itemShown(subject.id, subject.text)
			shown = written({ text = name, id = subject.id })
			colour = colour or WHITE
		end
		if Inspect.ClipOf(part, actions, shown) then
			out = out .. Shell.Link(spellID, verb, shown, part.axis, n, colour, icon)
		else
			if icon then
				out = out .. "|T" .. icon .. ":" .. Shell.ICON .. "|t"
			end
			out = out .. colour .. shown .. END
			for i = 2, #values do
				out = out .. "  " .. beside(values[i])
			end
		end
		links = Inspect.ActionLinks(spellID, part, n, actions)
	else
		links = Inspect.ActionLinks(spellID, part, n, actions)
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
	return line(spellID, part, n, "  ", Inspect.GROUPS[part.axis], Inspect.GROUP)
end

--- A part's line under its group: no label, the values but the group's.
function Inspect.MemberLine(spellID, part, n)
	return line(spellID, part, n, "    ", nil, Inspect.PART)
end

--- What a tooltip says a click on one of this file's links will do.
-- @param axis the part's axis
-- @param verb the link's verb
-- @param part the part, for the shift-click hint on its own link
-- @return the hint, or nil for a verb the axis does not offer
function Inspect.HintOf(axis, verb, part)
	if verb == Inspect.LIST then
		return "Click to print the spell's " .. Inspect.Label(axis):lower()
	elseif verb == Inspect.PART or verb == Inspect.GROUP then
		local _, hint = Inspect.ClipOf(part, actionsFor(axis, verb), "")
		return hint
	end
	for _, action in ipairs(Epsilook:GetActions(axis)) do
		if action.key == verb then
			return action.hint
		end
	end
	return nil
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
	local key = Inspect.GROUPS[axis]
	local seen
	for i = 1, n do
		local part = Epsilook:GetPartDataByIndex(spellID, axis, i)
		if not key then
			say(Inspect.PartLine(spellID, part, i))
		else
			local group = part.values[key]
			local id = type(group) == "table" and group.id or group
			if i == 1 or id ~= seen then
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
	say(Inspect.HeadLine(spell))
	for _, axis in ipairs(Epsilook:GetPartAxes()) do
		Inspect.PrintAxis(spellID, axis, say)
	end
end

--- Sound handles by what was played, so a stop link can find its sound.
local playing = {}

--- The server commands the actions send, by key, each taking the action's
-- argument. The sound actions are not here: they are the client's own calls.
local COMMANDS = {
	spawn = "gob spawn %d",
	add = "additem %d",
	summon = "npc spawn %d",
	morph = "morph %d",
	anim = "mod anim %d",
	stand = "mod standstate %d",
	animkit = "mod animkit %d",
	resetAnim = "mod stand 30",
	resetStand = "mod stand 0",
}

--- The action an axis offers under a key, or nil.
local function actionOf(axis, key)
	for _, action in ipairs(Epsilook:GetActions(axis)) do
		if action.key == key then
			return action
		end
	end
	return nil
end

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
		Inspect.PrintAxis(spellID, axis, say)
		return
	end
	local part = Epsilook:GetPartDataByIndex(spellID, axis, n)
	if not part then
		say(Shell.Said(RED .. "that part is no longer in the pack" .. END))
		return
	end
	local action = actionOf(axis, key)
	if not action or not takes(part, action) then
		return
	end
	local argument = Inspect.ArgumentOf(part, action)
	if COMMANDS[key] then
		Shell.Send(COMMANDS[key]:format(argument))
	elseif key == "play" or key == "playKit" then
		local player = key == "play" and _G.PlaySoundFile or _G.PlaySound
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

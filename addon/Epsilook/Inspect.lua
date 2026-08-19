--- The dossier: everything one spell is made of, printed, with its actions.
--
-- The second interface over the API. A head line names the spell; then one
-- block per axis that carries rows for it, one line per part, shaped the way
-- the server's own info commands print a thing: a cyan label, the part's
-- subject as a link, and the actions the axis affords. The line carries the
-- least that tells one part from the next; everything else the part holds is
-- in the link's tooltip, and a click prints it in full. Every link is
-- absolute -- spell, axis, row -- so a dossier in old scrollback still does
-- what it says, and a "world" action is exactly as dangerous from there as it
-- was when printed, which is why the sound actions carry their stop beside
-- them. A shift-click on a part's link hands the chat box the number an
-- action takes, so the part can be typed into a command by hand.
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

--- The link every part carries on its subject: its tooltip holds every value
-- the part has, a click prints them, and a shift-click hands the chat box
-- the number an action on it takes.
Inspect.PART = {
	key = "part",
	hint = "Click to print everything this part carries; shift-click to type its id into chat",
}

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

--- A value as one piece of text, its id in grey after it where it has one.
local function written(value)
	if value.id then
		return value.text .. " " .. GREY .. value.id .. END
	end
	return value.text
end

--- One part's values, written `name: value` in one line.
-- @param part a PartData
-- @return the text
function Inspect.ValuesText(part)
	local out = {}
	for _, value in ipairs(Inspect.Values(part)) do
		out[#out + 1] = GREY .. value.name .. ":" .. END .. written(value)
	end
	return table.concat(out, " ")
end

--- The word that tells a part from its neighbours: its subject, which the
-- catalogue declares first, with a path cut to its file name.
-- @param part a PartData
-- @return the subject as text, or nil for a part carrying no value
function Inspect.Subject(part)
	local first = Inspect.Values(part)[1]
	if not first then
		return nil
	end
	if first.path then
		return first.text:match("([^/\\]+)$") or first.text
	end
	return first.text
end

--- Fill a tooltip with a part: its kind as the title, then one line per value.
-- @param tooltip the GameTooltip, already owned
-- @param part a PartData
function Inspect.FillTooltip(tooltip, part)
	tooltip:SetText(part.kind, 1, 1, 1)
	for _, value in ipairs(Inspect.Values(part)) do
		tooltip:AddDoubleLine(value.name, written(value), 0.62, 0.62, 0.62, 1, 1, 1)
	end
end

--- What a tooltip says a click on a part's link will do.
-- @param axis the part's axis
-- @param verb the link's verb
-- @return the hint, or nil for a verb the axis does not offer
function Inspect.HintOf(axis, verb)
	if verb == Inspect.PART.key then
		return Inspect.PART.hint
	end
	for _, action in ipairs(Epsilook:GetActions(axis)) do
		if action.key == verb then
			return action.hint
		end
	end
	return nil
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
-- the action: the spawn id for a spawn, the emote for an animation, the
-- stored value the action names otherwise, and nil for an action needing
-- nothing.
-- @param part a PartData
-- @param action an Action of the part's axis
-- @return the number, or nil
function Inspect.ArgumentOf(part, action)
	if action.needs == "" then
		return nil
	end
	if part.values[action.needs] == nil then
		return nil
	end
	if action.key == "spawn" then
		return spawnOf(part)
	elseif action.key == "anim" or action.key == "stand" then
		return emoteOf(part, action.key)
	end
	return needed(part, action.needs)
end

--- Whether a part can take an action: it needs nothing, or it has what the
-- action sends.
local function takes(part, action)
	return action.needs == "" or Inspect.ArgumentOf(part, action) ~= nil
end

--- The number a shift-click on a part hands the chat box: what its first
-- action sends, which for a model is the id `.gob spawn` places it by, for
-- an animation the emote `.mod anim` plays, for a kit its own id.
-- @param part a PartData
-- @return the number, or nil for a part no action takes
function Inspect.ClipOf(part)
	for _, action in ipairs(Epsilook:GetActions(part.axis)) do
		local argument = Inspect.ArgumentOf(part, action)
		if argument then
			return argument
		end
	end
	return nil
end

--- The links for one part: the axis's actions that the part can take.
-- @param spellID the spell
-- @param part a PartData
-- @param n the part's row on its axis, counted from one
-- @return the links joined, possibly empty
function Inspect.ActionLinks(spellID, part, n)
	local out = {}
	for _, action in ipairs(Epsilook:GetActions(part.axis)) do
		if takes(part, action) then
			out[#out + 1] = Shell.Link(spellID, action.key, action.label, part.axis, n)
		end
	end
	return table.concat(out, " ")
end

--- One part's line: its kind as a label, its subject as the part's link, and
-- its actions.
function Inspect.PartLine(spellID, part, n)
	local subject = Inspect.Subject(part)
	local line = "  " .. CYAN .. part.kind .. (subject and ":" or "") .. END
	if subject then
		line = line .. " " .. Shell.Link(spellID, Inspect.PART.key, subject, part.axis, n, WHITE)
	end
	local links = Inspect.ActionLinks(spellID, part, n)
	if links ~= "" then
		line = line .. "  " .. links
	end
	return line
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
	local counts = Epsilook:GetPartCounts(spellID)
	local part = {}
	for _, axis in ipairs(Epsilook:GetPartAxes()) do
		local n = counts[axis] or 0
		if n > 0 then
			say(GOLD .. n .. " " .. axis .. END)
			for i = 1, n do
				Epsilook:GetPartDataByIndex(spellID, axis, i, part)
				say(Inspect.PartLine(spellID, part, i))
			end
		end
	end
end

--- Sound handles by what was played, so a stop link can find its sound.
local playing = {}

--- The server commands the actions send, by key, each taking the action's
-- argument. The sound actions are not here: they are the client's own calls.
local COMMANDS = {
	spawn = "gob spawn %d",
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

--- Execute one dossier action from its link.
-- @param spellID the spell
-- @param key the action, as ACTIONS names it, or the part link's own
-- @param axis the part's axis
-- @param n the part's row on that axis
-- @param say the function that prints a line
function Inspect.Execute(spellID, key, axis, n, say)
	local part = Epsilook:GetPartDataByIndex(spellID, axis, n)
	if not part then
		say(Shell.Said(RED .. "that part is no longer in the pack" .. END))
		return
	end
	if key == Inspect.PART.key then
		say("  " .. CYAN .. part.kind .. ":" .. END .. " " .. Inspect.ValuesText(part))
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

--- The dossier: everything one spell is made of, printed, with its actions.
--
-- The second interface over the API. A head line names the spell; then one
-- block per axis that carries rows for it, one line per part: the kind, the
-- part's values as the catalogue declares them, and the actions the axis
-- affords as links. Every link is absolute -- spell, axis, row -- so a
-- dossier in old scrollback still does what it says, and a "world" action is
-- exactly as dangerous from there as it was when printed, which is why the
-- sound actions carry their stop beside them.
--
-- The actions are Epsilon's commands and the client's own sound calls; this
-- file is the one place that knows which is which. Rendering is apart from
-- printing, so the lines are tested bare.

_G.Epsilook = _G.Epsilook or {}
local Epsilook = _G.Epsilook

local Inspect = {}
Epsilook.Inspect = Inspect

local Shell = Epsilook.Shell

local GOLD, WHITE, GREY, RED = "|cffffd100", "|cffffffff", "|cff9d9d9d", "|cffff2020"
local END = "|r"

--- The head line: the spell's name as a link, its id, school and expansion.
function Inspect.HeadLine(spell)
	local parts = { Shell.SpellLink(spell.id, spell.name), GOLD .. spell.id .. END }
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

--- One part's values, written `name: value` in the catalogue's order.
-- @param part a PartData
-- @return the text
function Inspect.ValuesText(part)
	local kind = Epsilook.Schema.kindById[part.axis .. "." .. part.kind]
	local out = {}
	for _, prop in ipairs(kind and kind.props or {}) do
		local value = part.values[prop.name]
		if value ~= nil then
			local written = Epsilook:FormatPartValue(part.axis, part.kind, prop.name, value)
			if type(value) == "table" then
				written = written .. GREY .. " " .. value.id .. END
			end
			out[#out + 1] = GREY .. prop.name .. ":" .. END .. written
		end
	end
	return table.concat(out, " ")
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

--- The links for one part: the axis's actions that the part can take.
-- An action needs a value the part must carry; a part without it gets no
-- link, and a spawn needs a known spawn id as well as a file.
-- @param spellID the spell
-- @param part a PartData
-- @param n the part's row on its axis, counted from one
-- @return the links joined, possibly empty
function Inspect.ActionLinks(spellID, part, n)
	local out = {}
	for _, action in ipairs(Epsilook:GetActions(part.axis)) do
		local held = action.needs == "" or part.values[action.needs] ~= nil
		if held and action.key == "spawn" then
			held = spawnOf(part) ~= nil
		end
		if held then
			out[#out + 1] = Shell.Link(spellID, action.key, action.label, part.axis, n)
		end
	end
	return table.concat(out, " ")
end

--- One part's line.
function Inspect.PartLine(spellID, part, n)
	local line = "  " .. WHITE .. part.kind .. END .. " " .. Inspect.ValuesText(part)
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

--- Execute one dossier action from its link.
-- @param spellID the spell
-- @param key the action, as ACTIONS names it
-- @param axis the part's axis
-- @param n the part's row on that axis
-- @param say the function that prints a line
function Inspect.Execute(spellID, key, axis, n, say)
	local part = Epsilook:GetPartDataByIndex(spellID, axis, n)
	if not part then
		say(Shell.Said(RED .. "that part is no longer in the pack" .. END))
		return
	end
	if key == "spawn" then
		local spawn = spawnOf(part)
		if spawn then
			Shell.Send("gob spawn " .. spawn)
		end
	elseif key == "play" or key == "playKit" then
		local id = needed(part, key == "play" and "file" or "kit")
		local player = key == "play" and _G.PlaySoundFile or _G.PlaySound
		if id and player then
			local ok, handle = player(id)
			if ok then
				playing[key .. id] = handle
			end
		end
	elseif key == "stop" or key == "stopKit" then
		local id = needed(part, key == "stop" and "file" or "kit")
		local handle = id and playing[(key == "stop" and "play" or "playKit") .. id]
		if handle and _G.StopSound then
			_G.StopSound(handle)
		end
	elseif key == "anim" or key == "stand" then
		-- A one-shot emote plays on the current animation and a looping one
		-- sets the standing pose; each command takes the other where the
		-- animation has only one.
		local oneshot, loop = Epsilook:GetEmotesByAnim(needed(part, "anim") or -1)
		local emote, command = loop, "mod standstate "
		if key == "anim" then
			emote, command = oneshot, "mod anim "
		end
		if emote == 0 then
			emote = key == "anim" and loop or oneshot
		end
		if emote ~= 0 then
			Shell.Send(command .. emote)
		end
	elseif key == "animkit" then
		local id = needed(part, "id")
		if id then
			Shell.Send("mod animkit " .. id)
		end
	elseif key == "resetAnim" then
		Shell.Send("mod stand 30")
	elseif key == "resetStand" then
		Shell.Send("mod stand 0")
	end
end

return Inspect

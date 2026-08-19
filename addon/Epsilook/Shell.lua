--- The chat shell: the slash command, the result lines, and the clicks.
--
-- The first interface over the API, and the one that mirrors `.lookup`: a
-- result is one line per spell, `id - [Name] - [Learn] - [Cast] - [Aura] -
-- [Inspect]`, where the name is the game's own spell link (it carries the
-- tooltip and links on shift-click) and the action words are this addon's own
-- links, which EXECUTE when clicked rather than filling the chat box. Output
-- accumulates in chat and is never replaced, so every link is absolute: it
-- names the spell and the verb, and clicking it from old scrollback does
-- exactly what it did the first time.
--
-- Rendering is kept apart from printing. `Shell.ResultLine` and the dossier's
-- lines are pure functions from API records to strings, so they are tested
-- bare; only the dozen lines at the bottom touch the client.
--
-- Paging holds a cursor, not a result set: the last query's tree and the spell
-- row the page stopped at, so `more` resumes the walk from there.

_G.Epsilook = _G.Epsilook or {}
local Epsilook = _G.Epsilook

local Shell = {}
Epsilook.Shell = Shell

--- How many result lines one page prints.
Shell.PAGE = 20

--- The link type this addon owns, and the colours a line is drawn in: gold
-- for the id, white for the name (the game's own spell-link colour), the
-- client's blue for the action words, and grey for the counts that say what
-- a spell is made of.
Shell.LINK = "epsilook"
local GOLD, WHITE, BLUE, GREY, RED =
	"|cffffd100", "|cffffffff", "|cff71d5ff", "|cff9d9d9d", "|cffff2020"
local END = "|r"

--- The actions a result line offers, in the order `.lookup` prints them.
Shell.VERBS = { "learn", "cast", "aura", "inspect" }
local LABELS = { learn = "Learn", cast = "Cast", aura = "Aura", inspect = "Inspect" }

--- One of this addon's links, shown as a bracketed word.
-- The link names the spell, the verb and, for a part's action, the axis and
-- the row, so that it is complete in itself: `epsilook:133:spawn:model:1`.
-- @param spellID the spell
-- @param verb the action
-- @param label the word shown, defaulting to the verb's own
-- @param axis the axis of the part the action takes, or nil for a spell action
-- @param n the part's row on that axis
-- @return the link markup
function Shell.Link(spellID, verb, label, axis, n)
	local target = Shell.LINK .. ":" .. spellID .. ":" .. verb
	if axis then
		target = target .. ":" .. axis .. ":" .. n
	end
	return BLUE .. "|H" .. target .. "|h[" .. (label or LABELS[verb] or verb) .. "]|h" .. END
end

--- The game's own link to a spell, as `.lookup` prints one.
function Shell.SpellLink(spellID, name)
	return WHITE .. "|Hspell:" .. spellID .. "|h[" .. name .. "]|h" .. END
end

--- One result line for a spell, in `.lookup`'s grammar.
-- @param spell a SpellData
-- @param counts the spell's part counts by axis, or nil to leave them off
-- @param axes the axes to report, in order
-- @return the line
function Shell.ResultLine(spell, counts, axes)
	local parts = { GOLD .. spell.id .. END, Shell.SpellLink(spell.id, spell.name) }
	for _, verb in ipairs(Shell.VERBS) do
		parts[#parts + 1] = Shell.Link(spell.id, verb)
	end
	local line = table.concat(parts, " - ")
	if counts and axes then
		local made = {}
		for _, axis in ipairs(axes) do
			local n = counts[axis] or 0
			if n > 0 then
				made[#made + 1] = n .. " " .. axis
			end
		end
		if #made > 0 then
			line = line .. " " .. GREY .. table.concat(made, ", ") .. END
		end
	end
	return line
end

--- The addon's own prefix on a line it prints about itself, rather than about a spell.
function Shell.Said(text)
	return BLUE .. "Epsilook" .. END .. " " .. text
end

--- A problem, in red, with where in the query it was found.
function Shell.ProblemLine(problem)
	return RED .. problem.message .. END .. GREY .. " at " .. problem.at .. END
end

--- The lone subject a message names, if it names one and nothing else: a
-- spell id, or a pasted spell link. Such a message is an inspection.
-- @param message the slash command's argument, trimmed
-- @return the spell id, or nil
function Shell.LoneSpell(message)
	local id = message:match("^(%d+)$")
	if id then
		return tonumber(id)
	end
	id = message:match("^|c%x%x%x%x%x%x%x%x|Hspell:(%d+)[^|]*|h%b[]|h|r$")
		or message:match("^|Hspell:(%d+)[^|]*|h%b[]|h$")
	return id and tonumber(id) or nil
end

--- The subcommand a message opens with, and the rest of it.
-- Only a leading word that is a subcommand is taken; everything else is the
-- query, untouched, because quotes and symbols are the query's own grammar.
-- @return the word, or nil, and the rest
function Shell.Split(message)
	local word, rest = message:match("^(%a+)%s*(.-)$")
	if word and Shell.SUBCOMMANDS[word:lower()] then
		return word:lower(), rest
	end
	return nil, message
end

--- The help text, read off the declarations so it cannot fall behind them.
-- @return a list of lines
function Shell.HelpLines()
	local help = Epsilook:GetQueryHelp()
	local lines = {
		Shell.Said(
			"/elo <query> searches; /elo <id or spell link> inspects; /elo more, count <query>, help, test"
		),
		Shell.Said("columns: each a head, as in model:fire"),
	}
	for _, column in ipairs(help.columns) do
		lines[#lines + 1] = "  " .. GOLD .. column.key .. END .. " " .. column.hint
	end
	local doors = {}
	for _, head in ipairs(help.heads) do
		if head.role ~= "column" then
			doors[#doors + 1] = head.word
		end
	end
	lines[#lines + 1] = Shell.Said("other heads: " .. table.concat(doors, ", "))
	local ops = {}
	for _, op in ipairs(help.operators) do
		ops[#ops + 1] = op.symbol
	end
	lines[#lines + 1] = Shell.Said(
		"operators: " .. table.concat(ops, " ") .. "; a-b ranges; - excludes; | or between terms"
	)
	return lines
end

--- The chat frame a line goes to, and the one function here that writes to it.
local function say(line)
	local frame = _G.DEFAULT_CHAT_FRAME
	if frame then
		frame:AddMessage(line)
	else
		print(line)
	end
end

--- Where the last search stopped, for `more`.
local paging

--- Print one page of results for a query, from a spell row.
-- @param tree the parsed query
-- @param text the query as typed, for the header
-- @param fromIndex the spell row to resume from
local function page(tree, text, fromIndex)
	local axes = Epsilook:GetPartAxes()
	local step = Epsilook:FindSpells(tree, fromIndex)
	local spell, counts = {}, {}
	local shown, last = 0, nil
	for _ = 1, Shell.PAGE do
		local at, spellID = step()
		if not at then
			break
		end
		Epsilook:GetSpellDataByIndex(at, spell)
		Epsilook:GetPartCounts(spellID, counts)
		say(Shell.ResultLine(spell, counts, axes))
		shown, last = shown + 1, at
	end
	if shown == 0 then
		say(Shell.Said((fromIndex and "no more" or "nothing") .. " for " .. text))
		paging = nil
		return
	end
	if shown == Shell.PAGE then
		paging = { tree = tree, text = text, index = last + 1 }
		say(
			Shell.Said(
				shown
					.. " shown; /elo more for the next "
					.. Shell.PAGE
					.. ", /elo count "
					.. text
					.. " for the total"
			)
		)
	else
		paging = nil
		say(Shell.Said(shown .. " for " .. text))
	end
end

--- A query typed at the command, parsed and either run or refused.
local function search(text)
	local tree, problems = Epsilook:ParseQuery(text)
	for _, problem in ipairs(problems) do
		say(Shell.ProblemLine(problem))
	end
	if Epsilook:IsQueryEmpty(tree) then
		if #problems == 0 then
			say(Shell.Said("nothing to search for"))
		end
		return
	end
	page(tree, text, nil)
end

--- The subcommands and what each does with the rest of the message.
Shell.SUBCOMMANDS = {
	more = function()
		if not paging then
			say(Shell.Said("nothing to page; search first"))
			return
		end
		page(paging.tree, paging.text, paging.index)
	end,
	count = function(rest)
		local tree, problems = Epsilook:ParseQuery(rest)
		for _, problem in ipairs(problems) do
			say(Shell.ProblemLine(problem))
		end
		if not Epsilook:IsQueryEmpty(tree) then
			say(Shell.Said(Epsilook:GetNumMatches(tree) .. " match " .. rest))
		end
	end,
	inspect = function(rest)
		local spellID = Shell.LoneSpell(rest) or tonumber(rest)
		if not spellID then
			say(Shell.Said("inspect takes a spell id or a spell link"))
			return
		end
		Epsilook.Inspect.Print(spellID, say)
	end,
	help = function()
		for _, line in ipairs(Shell.HelpLines()) do
			say(line)
		end
	end,
	test = function()
		Epsilook:SelfTest()
	end,
}

--- The command: a subcommand, a lone spell, or a query.
function Shell.Command(message)
	message = (message or ""):match("^%s*(.-)%s*$")
	if message == "" then
		Shell.SUBCOMMANDS.help()
		return
	end
	local ok, reason = Epsilook:LoadData()
	if not ok then
		say(
			Shell.Said(
				RED
					.. "no data: "
					.. tostring(reason)
					.. END
					.. " (is Epsilook_Data installed and enabled?)"
			)
		)
		return
	end
	local spellID = Shell.LoneSpell(message)
	if spellID then
		Epsilook.Inspect.Print(spellID, say)
		return
	end
	local word, rest = Shell.Split(message)
	if word then
		Shell.SUBCOMMANDS[word](rest)
		return
	end
	search(message)
end

--- Execute one of this addon's links.
-- Learn, cast and aura are the server's commands and go through the command
-- route; inspect prints the dossier; a verb with an axis and a row is one of
-- the dossier's actions. Anything else is ignored, so a stale link from an
-- older version does nothing rather than something wrong.
-- @param spellID the spell
-- @param verb the action
-- @param axis the part's axis, where the action takes a part
-- @param n the part's row on that axis
function Shell.Execute(spellID, verb, axis, n)
	if axis then
		Epsilook.Inspect.Execute(spellID, verb, axis, n, say)
	elseif verb == "inspect" then
		Epsilook.Inspect.Print(spellID, say)
	elseif verb == "learn" or verb == "cast" or verb == "aura" then
		Shell.Send(verb .. " " .. spellID)
	end
end

--- Send one dot-command to the server, without its leading dot.
-- The command library this client ships carries the command as an addon
-- message and hands its output back; where the library is absent the
-- command goes as guild chat, which the server reads dot-commands from.
-- @param text the command, as typed after the dot
function Shell.Send(text)
	local lib = _G.EpsilonLib
	local commands = lib and lib.AddonCommands
	if commands and commands.Send then
		commands.Send("Epsilook", text, nil, true)
		return
	end
	if _G.SendChatMessage then
		_G.SendChatMessage("." .. text, "GUILD")
	end
end

--- Wire the command and the link handler into the client, once.
-- Skipped under a bare interpreter, where none of the client's globals exist.
local function install()
	if not _G.SlashCmdList or not _G.hooksecurefunc then
		return
	end
	-- Claim the slash names only where nobody has: another addon's command is
	-- theirs, and taking it would break it in silence.
	local names = { "/epsilook", "/elo" }
	local taken = {}
	for name, value in pairs(_G) do
		if type(name) == "string" and name:sub(1, 6) == "SLASH_" and type(value) == "string" then
			taken[value:lower()] = name
		end
	end
	local claimed = 0
	for _, name in ipairs(names) do
		if taken[name] then
			say(
				Shell.Said(
					RED .. name .. " is already " .. taken[name] .. "; not claiming it" .. END
				)
			)
		else
			claimed = claimed + 1
			_G["SLASH_EPSILOOK" .. claimed] = name
		end
	end
	if claimed > 0 then
		_G.SlashCmdList["EPSILOOK"] = Shell.Command
	end
	_G.hooksecurefunc("SetItemRef", function(link)
		local id, verb, axis, n = link:match("^" .. Shell.LINK .. ":(%d+):(%a+):?(%a*):?(%d*)$")
		if id then
			Shell.Execute(tonumber(id), verb, axis ~= "" and axis or nil, tonumber(n))
		end
	end)
end

install()

return Shell

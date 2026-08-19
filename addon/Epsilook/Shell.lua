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
-- row the page stopped at, so `more` resumes the walk from there. A search
-- runs as a job across frames, a budgeted slice of the walk per frame, so a
-- query over every spell costs frames and never a freeze.

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

--- A message read the way `.lookup` is typed: a head word followed by a space
-- and a token binds to that token, so `model 6dr` is `model:6dr`. The
-- leniency is the shell's, not the grammar's -- the query the engine sees is
-- one the web reads the same way. A head already bound, a head at the end,
-- and anything inside quotes are left alone, and the next token must be a
-- value rather than an exclusion or an alternation.
-- @param message the query as typed
-- @return the query as the engine reads it
function Shell.Lenient(message)
	local grammar = Epsilook.Schema.grammar
	local out, i, n = {}, 1, #message
	local pending
	while i <= n do
		local quoted, stop = message:match('^(%b"")()', i)
		local token
		if quoted then
			token, i = quoted, stop
		else
			local word, after = message:match("^(%S+)()", i)
			if word then
				token, i = word, after
			else
				local space, after_ = message:match("^(%s+)()", i)
				token, i = space, after_
			end
		end
		if token:match("^%s+$") then
			if not pending then
				out[#out + 1] = token
			end
		elseif pending then
			local value = token
			if
				value:sub(1, 1) == grammar.negate
				or value:sub(1, 1) == grammar["or"]
				or Epsilook.Text.fold(value) == grammar.orWord
			then
				out[#out + 1] = pending .. " " .. value
			else
				out[#out + 1] = pending .. grammar.bind .. value
			end
			pending = nil
		elseif not quoted and Epsilook.Schema.HeadOf(Epsilook.Text.fold(token)) then
			-- A bare head word: bound to the next token if one comes.
			pending = token
		else
			out[#out + 1] = token
		end
	end
	if pending then
		out[#out + 1] = pending
	end
	return table.concat(out)
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

--- How many milliseconds of one frame a running job may take, and how many
-- spells the walk examines between two chances to yield. The client renders
-- between a job's slices, so a search over every spell costs frames and never
-- a freeze; a slice is small enough that the budget is overrun by at most a
-- few hundred row reads.
Shell.BUDGET_MS = 8
Shell.SLICE = 500

--- The job running across frames, if any, and the frame that drives it.
local running, driver

--- Run a function as a job across frames: it is resumed every frame for the
-- budget's worth of time, and wherever it yields is where it continues. A new
-- job replaces a running one. Under a bare interpreter, where there is no
-- frame to drive it, the job runs to the end at once.
-- @param job a function taking no arguments; it yields between slices
local function run(job)
	local create, profile = _G.CreateFrame, _G.debugprofilestop
	if not create or not profile then
		local co = coroutine.create(job)
		repeat
			local ok, err = coroutine.resume(co)
			if not ok then
				error(err)
			end
		until coroutine.status(co) ~= "suspended"
		return
	end
	running = coroutine.create(job)
	driver = driver or create("Frame")
	driver:SetScript("OnUpdate", function()
		local started = profile()
		while
			running
			and coroutine.status(running) == "suspended"
			and profile() - started < Shell.BUDGET_MS
		do
			local ok, err = coroutine.resume(running)
			if not ok then
				say(Shell.Said(RED .. tostring(err) .. END))
				running = nil
			end
		end
		if not running or coroutine.status(running) ~= "suspended" then
			running = nil
			driver:SetScript("OnUpdate", nil)
		end
	end)
end

--- Where the last search stopped, for `more`.
local paging

--- Print one page of results for a query, from a spell row, as a job.
-- @param tree the parsed query
-- @param text the query as typed, for the header
-- @param fromIndex the spell row to resume from
local function page(tree, text, fromIndex)
	run(function()
		local axes = Epsilook:GetPartAxes()
		local step = Epsilook:FindSpells(tree, fromIndex, Shell.SLICE)
		local spell, counts = {}, {}
		local shown, last = 0, nil
		while shown < Shell.PAGE do
			local at, spellID = step()
			if at == nil then
				break
			elseif at == false then
				coroutine.yield()
			else
				Epsilook:GetSpellDataByIndex(at, spell)
				Epsilook:GetPartCounts(spellID, counts)
				say(Shell.ResultLine(spell, counts, axes))
				shown, last = shown + 1, at
			end
		end
		if shown == 0 then
			say(Shell.Said((fromIndex and "no more" or "nothing") .. " for " .. text))
			paging = nil
		elseif shown == Shell.PAGE then
			paging = { tree = tree, text = text, index = last + 1 }
			say(
				Shell.Said(
					shown
						.. " shown - "
						.. Shell.Link(0, "more", "Next")
						.. " - /elo count "
						.. text
						.. " for the total"
				)
			)
		else
			paging = nil
			say(Shell.Said(shown .. " for " .. text))
		end
	end)
end

--- Count a query's matches as a job, and print the total.
local function count(tree, text)
	run(function()
		local step = Epsilook:FindSpells(tree, nil, Shell.SLICE)
		local found = 0
		while true do
			local at = step()
			if at == nil then
				break
			elseif at == false then
				coroutine.yield()
			else
				found = found + 1
			end
		end
		say(Shell.Said(found .. " match " .. text))
	end)
end

--- A query typed at the command, parsed and either run or refused.
local function search(text)
	text = Shell.Lenient(text)
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
		rest = Shell.Lenient(rest)
		local tree, problems = Epsilook:ParseQuery(rest)
		for _, problem in ipairs(problems) do
			say(Shell.ProblemLine(problem))
		end
		if not Epsilook:IsQueryEmpty(tree) then
			count(tree, rest)
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

--- The tooltip a link shows while the mouse is over it.
-- A spell link shows the game's own spell tooltip; the aura link shows what
-- the aura says while it is on you, which is the pack's own text; a part's
-- action shows the part. Only this addon's links are handled: the chat frame
-- has other hands on the others.
-- @param frame the chat frame the link is in
-- @param link the link's target
function Shell.OnHyperlinkEnter(frame, link)
	local id, verb, axis, n = link:match("^" .. Shell.LINK .. ":(%d+):(%a+):?(%a*):?(%d*)$")
	local tooltip = _G.GameTooltip
	if not id or not tooltip then
		return
	end
	id = tonumber(id)
	tooltip:SetOwner(frame, "ANCHOR_CURSOR")
	if axis ~= "" then
		local part = Epsilook:GetPartDataByIndex(id, axis, tonumber(n))
		if part then
			tooltip:SetText(part.kind, 1, 1, 1)
			tooltip:AddLine(Epsilook.Inspect.ValuesText(part), nil, nil, nil, true)
		end
	elseif verb == "aura" then
		local spell = Epsilook:GetSpellDataByID(id)
		local text = Epsilook:GetSpellTextByID(id)
		if spell then
			tooltip:SetText(spell.name, 1, 1, 1)
			tooltip:AddLine(
				text.aura ~= "" and text.aura or GREY .. "no aura text" .. END,
				nil,
				nil,
				nil,
				true
			)
		end
	else
		tooltip:SetSpellByID(id)
	end
	tooltip:Show()
end

--- The tooltip taken down as the mouse leaves one of this addon's links.
function Shell.OnHyperlinkLeave(_, link)
	local tooltip = _G.GameTooltip
	if tooltip and link:sub(1, #Shell.LINK + 1) == Shell.LINK .. ":" then
		tooltip:Hide()
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
	for i = 1, (_G.NUM_CHAT_WINDOWS or 0) do
		local frame = _G["ChatFrame" .. i]
		if frame and frame.HookScript then
			frame:HookScript("OnHyperlinkEnter", Shell.OnHyperlinkEnter)
			frame:HookScript("OnHyperlinkLeave", Shell.OnHyperlinkLeave)
		end
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

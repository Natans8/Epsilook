--- The chat shell: the slash command, the result lines, and the clicks.
--
-- The first interface over the API, and the one that mirrors `.lookup`: a
-- result is two lines per spell, `id - [Name]` with what it is made of and
-- then its actions `[Learn] - [Cast] - [Aura] - [Inspect]`, where the name is
-- the game's own spell link (it carries the tooltip and links on shift-click)
-- and the action words are this addon's own links, which EXECUTE when clicked
-- rather than filling the chat box. Output
-- accumulates in chat and is never replaced, so every link is absolute: it
-- names the spell and the verb, and clicking it from old scrollback does
-- exactly what it did the first time.
--
-- Rendering is kept apart from printing. `Shell.ResultLines` and the dossier's
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

--- The link type this addon owns. A click on a chat link reaches `SetItemRef`,
-- which handles the types it knows and then shows any other in the item
-- tooltip, where a type it cannot draw fails before any hook on it can run.
-- The garrison-mission branch returns early for anything that is not a
-- mission, so an addon's links ride that prefix, as the established addons'
-- do, and the hook sees every click.
Shell.LINK = "garrmission:epsilook"

--- The colours a line is drawn in: gold for the id, white for the name (the
-- game's own spell-link colour), the client's blue for the action words,
-- cyan for a label the way the server's own info commands draw one, and grey
-- for the counts that say what a spell is made of.
local GOLD, WHITE, BLUE, CYAN, GREY, RED =
	"|cffffd100", "|cffffffff", "|cff71d5ff", "|cff00ccff", "|cff9d9d9d", "|cffff2020"
local END = "|r"
Shell.COLOURS = { gold = GOLD, white = WHITE, blue = BLUE, cyan = CYAN, grey = GREY, red = RED }

--- The actions a result offers on a spell, in the order `.lookup` prints
-- them: the word shown, what a tooltip says a click does, and the server
-- command a click sends. Inspect sends nothing; it prints the dossier. The
-- aura action is offered only where the spell applies one, which the mech
-- column says with a row of its aura kind.
Shell.SPELL_ACTIONS = {
	{ key = "learn", label = "Learn", command = "learn", hint = "Click to learn the spell" },
	{ key = "cast", label = "Cast", command = "cast", hint = "Click to cast the spell" },
	{
		key = "aura",
		label = "Aura",
		command = "aura",
		hint = "Click to apply the aura to your target",
		auraOnly = true,
	},
	{ key = "inspect", label = "Inspect", hint = "Click to print everything the spell is made of" },
}

--- The spell action a verb names, or nil.
local function spellAction(verb)
	for _, action in ipairs(Shell.SPELL_ACTIONS) do
		if action.key == verb then
			return action
		end
	end
	return nil
end

--- The word at the bottom of a full page, which pages on.
local NEXT = { key = "more", label = "Next", hint = "Click to view the next %d results" }

--- One of this addon's links, shown as a bracketed word.
-- The link names the spell, the verb and, for a part's action, the axis and
-- the row, so that it is complete in itself: `...:133:spawn:model:1`.
-- @param spellID the spell
-- @param verb the action
-- @param label the word shown
-- @param axis the axis of the part the action takes, or nil for a spell action
-- @param n the part's row on that axis
-- @param colour the colour code to draw it in, the action blue by default
-- @return the link markup
function Shell.Link(spellID, verb, label, axis, n, colour)
	local target = Shell.LINK .. ":" .. spellID .. ":" .. verb
	if axis then
		target = target .. ":" .. axis .. ":" .. n
	end
	return (colour or BLUE) .. "|H" .. target .. "|h[" .. label .. "]|h" .. END
end

--- The parts of one of this addon's links, or nil for any other link.
-- @param link the link's target
-- @return the spell id, the verb, the axis or nil, the row or nil
function Shell.ParseLink(link)
	local id, verb, axis, n = link:match("^" .. Shell.LINK .. ":(%d+):(%a+):?(%a*):?(%d*)$")
	if not id then
		return nil
	end
	return tonumber(id), verb, axis ~= "" and axis or nil, tonumber(n)
end

--- What the client says a spell is called and looks like, where it knows the
-- spell, and what the pack says otherwise. The client is asked for its own
-- data rather than for the name an addon may have laid over it for this
-- player, so what prints is what the server would print.
-- @param spell a SpellData
-- @return the name, and the icon's file id or nil
function Shell.Shown(spell)
	local info = _G.GetSpellInfo
	if info then
		local name, _, icon = info(spell.id, nil, true)
		if name then
			return name, icon
		end
	end
	return spell.name, spell.icon ~= 0 and spell.icon or nil
end

--- How tall a spell's icon draws on a line, in pixels.
Shell.ICON = 16

--- The game's own link to a spell, as `.lookup` prints one, its icon inside
-- the link against the name.
-- @param spell a SpellData
function Shell.SpellLink(spell)
	local name, icon = Shell.Shown(spell)
	local shown = "[" .. name .. "]"
	if icon then
		shown = "|T" .. icon .. ":" .. Shell.ICON .. "|t" .. shown
	end
	return WHITE .. "|Hspell:" .. spell.id .. "|h" .. shown .. "|h" .. END
end

--- One result for a spell, as two lines: the spell, then its actions.
-- A result wraps in a chat frame more often than not, so the wrap is designed
-- in rather than suffered: the first line is the id, the game's own spell link
-- and what the spell is made of, each count a link that lists the parts on
-- hover and prints them on a click; the second, indented, is the actions,
-- which then sit at the same place on every result.
-- @param spell a SpellData
-- @param counts the spell's part counts by axis, or nil to leave them off
-- @param axes the axes to report, in order
-- @return the two lines
function Shell.ResultLines(spell, counts, axes)
	local head = GOLD .. spell.id .. END .. " - " .. Shell.SpellLink(spell)
	if counts and axes then
		local made = {}
		for _, axis in ipairs(axes) do
			local n = counts[axis] or 0
			if n > 0 then
				local label = n .. " " .. axis
				made[#made + 1] = Shell.Link(spell.id, Epsilook.Inspect.LIST, label, axis, 0, GREY)
			end
		end
		if #made > 0 then
			head = head .. "  " .. table.concat(made, " ")
		end
	end
	local links = {}
	for _, action in ipairs(Shell.SPELL_ACTIONS) do
		if not action.auraOnly or Epsilook:HasPartOfKind(spell.id, "mech", "aura") then
			links[#links + 1] = Shell.Link(spell.id, action.key, action.label)
		end
	end
	return head, "      " .. table.concat(links, " - ")
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
				local head, actions = Shell.ResultLines(spell, counts, axes)
				say(head)
				say(actions)
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
						.. Shell.Link(0, NEXT.key, NEXT.label)
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

--- A query as typed, read leniently and parsed, its problems printed.
-- @param text the query as typed
-- @return the tree, or nil where there is nothing to run, and the query as the engine read it
local function parsed(text)
	text = Shell.Lenient(text)
	local tree, problems = Epsilook:ParseQuery(text)
	for _, problem in ipairs(problems) do
		say(Shell.ProblemLine(problem))
	end
	if Epsilook:IsQueryEmpty(tree) then
		if #problems == 0 then
			say(Shell.Said("nothing to search for"))
		end
		return nil, text
	end
	return tree, text
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
		local tree, text = parsed(rest)
		if tree then
			count(tree, text)
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
	local tree, text = parsed(message)
	if tree then
		page(tree, text, nil)
	end
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
	local action = not axis and spellAction(verb)
	if axis then
		Epsilook.Inspect.Execute(spellID, verb, axis, n, say)
	elseif verb == NEXT.key then
		Shell.SUBCOMMANDS.more()
	elseif action and action.command then
		Shell.Send(action.command .. " " .. spellID)
	elseif action then
		Epsilook.Inspect.Print(spellID, say)
	end
end

--- Hand the chat box what one of this addon's links stands for, as a
-- shift-click on any link hands it the link: the spell's id for a spell
-- action, and for a part the game's own link or number its first action
-- sends, so that `.gob spawn` or `.mod anim` can be typed with it by hand.
-- Nothing happens where no chat box is open, as with the game's own links.
-- @param spellID the spell
-- @param verb the link's verb
-- @param axis the part's axis, or nil for a spell action
-- @param n the part's row on that axis
function Shell.Clip(spellID, verb, axis, n)
	local insert = _G.ChatEdit_InsertLink
	if not insert then
		return
	end
	local text = tostring(spellID)
	if axis then
		text = Epsilook.Inspect.Clip(spellID, verb, axis, n)
	end
	if text then
		insert(text)
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
-- link shows everything the part carries; every one ends in what a click
-- will do. Only this addon's links are handled: the chat frame has other
-- hands on the others.
-- @param frame the chat frame the link is in
-- @param link the link's target
function Shell.OnHyperlinkEnter(frame, link)
	local id, verb, axis, n = Shell.ParseLink(link)
	local tooltip = _G.GameTooltip
	if not id or not tooltip then
		return
	end
	tooltip:SetOwner(frame, "ANCHOR_CURSOR")
	local action = spellAction(verb)
	local hint = action and action.hint
	if verb == NEXT.key then
		tooltip:SetText(NEXT.hint:format(Shell.PAGE), 1, 1, 1)
	elseif axis and verb == Epsilook.Inspect.LIST then
		Epsilook.Inspect.FillAxisTooltip(tooltip, id, axis)
		hint = Epsilook.Inspect.HintOf(axis, verb)
	elseif axis then
		local part = Epsilook:GetPartDataByIndex(id, axis, n)
		if part then
			Epsilook.Inspect.FillTooltip(tooltip, part)
		end
		hint = Epsilook.Inspect.HintOf(axis, verb, part)
	elseif verb == "aura" then
		-- The spell's tooltip, then what the aura says while it is on you.
		tooltip:SetSpellByID(id)
		local text = Epsilook:GetSpellTextByID(id)
		if text and text.aura ~= "" then
			tooltip:AddLine(" ")
			tooltip:AddLine(text.aura, 1, 1, 1, true)
		end
	else
		tooltip:SetSpellByID(id)
	end
	if hint then
		tooltip:AddLine(hint, 0.44, 0.84, 1)
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
		local id, verb, axis, n = Shell.ParseLink(link)
		if not id then
			return
		end
		if _G.IsModifiedClick and _G.IsModifiedClick("CHATLINK") then
			Shell.Clip(id, verb, axis, n)
		else
			Shell.Execute(id, verb, axis, n)
		end
	end)
end

install()

return Shell

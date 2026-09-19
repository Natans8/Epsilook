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
-- row the page stopped at, so `next` resumes the walk from there. A search
-- runs as a job across frames, a budgeted slice of the walk per frame, so a
-- query over every spell costs frames and never a freeze.

_G.Epsilook = _G.Epsilook or {}
local Epsilook = _G.Epsilook

local Shell = {}
Epsilook.Shell = Shell

--- How many lines one result prints, and how many a page prints besides its
-- results: the line that says what is being searched, and the one that counts
-- what was shown and offers the next page.
local RESULT_LINES, PAGE_OVERHEAD = 2, 2

--- How many results one page prints: the player's own setting, held to what
-- the chat frame will remember.
-- @return the page size
function Shell.Page()
	local want = Epsilook.Config.Get("page")
	local kept = Shell.Kept()
	if not kept then
		return want
	end
	-- A chat frame remembers a fixed number of lines and forgets the oldest to
	-- make room. A result takes two of them, so a page as large as the setting
	-- allows would push everything before it out of the frame's memory and leave
	-- nothing to scroll back to. Half the memory is kept for what came before.
	return math.max(1, math.min(want, math.floor((kept / 2 - PAGE_OVERHEAD) / RESULT_LINES)))
end

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

--- The tone each axis wears: on a count in a result line, and on the label
-- of every part line in the dossier, so a section reads as one by its
-- colour. One hue per column -- model blue, sound green, anim
-- violet, fx teal, mech orange -- saturated for chat, and apart from the
-- `.lookup` colours the ids, names, links and actions keep.
Shell.AXIS_COLOURS = {
	model = "|cff3b9eff",
	sound = "|cff3ddc84",
	anim = "|cffc77dff",
	fx = "|cff2ee6d6",
	mech = "|cffff9f43",
}

--- The actions offered on a spell, in the order `.lookup` prints them: the
-- word shown, what a tooltip says a click does, and the server command a
-- click sends. Inspect sends nothing; it prints the dossier. The aura action
-- is offered only where the spell applies one, which the mech column says
-- with a row of its aura kind. `on` says where an action is offered: a
-- result line, the dossier's head, or both. Learn and unlearn are a pair:
-- the one the spell's standing calls for shows, the client asked whether
-- the player knows it.
Shell.SPELL_ACTIONS = {
	{
		key = "learn",
		label = "Learn",
		command = "learn",
		hint = "Learns the spell",
		on = "both",
		unknownOnly = true,
	},
	{
		key = "unlearn",
		label = "Unlearn",
		command = "unlearn",
		hint = "Unlearns the spell",
		on = "both",
		knownOnly = true,
	},
	{
		key = "cast",
		label = "Cast",
		command = "cast",
		hint = "Casts it",
		on = "both",
	},
	{
		key = "aura",
		label = "Aura",
		command = "aura",
		hint = "Applies the aura to yourself",
		auraOnly = true,
		on = "both",
	},
	{
		key = "inspect",
		label = "Inspect",
		hint = "Everything the spell is made of",
		on = "result",
	},
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
local NEXT = { key = "next", label = "Next", hint = "The next %d results" }

--- The project's page, and the one place this addon names it.
Shell.WEBSITE = "https://natans8.github.io/Epsilook/"

--- The word on the help's last line, which hands the address over. A chat
-- frame cannot be selected, so the address goes to a frame that can be.
local SITE = { key = "website", label = "Website", hint = "Copy the address" }

--- How tall an icon draws on a line, in pixels.
Shell.ICON = 16

--- A texture the client ships that draws nothing. Chat has no columns, and a
-- run of spaces cannot make one, because the chat font is proportional and a
-- space is narrower than a digit; a gap of an exact number of pixels is a
-- transparent texture that many pixels wide.
local SPACER = "Interface/Common/Spacer"

--- A gap of an exact number of pixels, and nothing at all below one.
function Shell.Gap(pixels)
	pixels = math.floor(tonumber(pixels) or 0)
	if pixels < 1 then
		return ""
	end
	return "|T" .. SPACER .. ":1:" .. pixels .. "|t"
end

--- The frame every width is measured for, and the string it is measured with.
-- Nothing here is assumed about the player's interface: the frame is asked for
-- its own font every time, and the string measuring it belongs to it, so a
-- window the player has scaled answers at the size it is drawn rather than at
-- the size the screen would have drawn it.
local ruler, ruledFor

--- The chat frame this addon prints to, or nothing under a bare interpreter.
local function chatFrame()
	local frame = _G.DEFAULT_CHAT_FRAME
	if not (frame and frame.GetFont and frame.CreateFontString) then
		return nil
	end
	return frame
end

--- The chat frame's own font, or nothing where there is no frame to ask.
local function chatFont()
	local frame = chatFrame()
	if not frame then
		return nil
	end
	return frame:GetFont()
end

--- How wide text draws in the chat frame's own font, in pixels, or nil where
-- nothing can measure it. A bare interpreter has neither frames nor fonts, and
-- there a line is simply not padded.
-- @param text the text, markup and all
function Shell.Width(text)
	local frame = chatFrame()
	local file, height, flags = chatFont()
	if not file then
		return nil
	end
	if not ruler or ruledFor ~= frame then
		ruler = frame:CreateFontString(nil, "ARTWORK")
		ruler:Hide()
		ruledFor = frame
	end
	ruler:SetFont(file, height, flags)
	ruler:SetText(text)
	return ruler:GetStringWidth()
end

--- The gap kept after a column: half a line's height, so that it holds its
-- proportion when the player makes the chat font larger.
local function gutter(height)
	return math.floor((height or 12) * 0.5)
end

--- A column's width, from the widest thing it must hold. Measured rather than
-- declared in pixels, so a column follows the player's own chat font instead
-- of fighting it, and measured once per font rather than once per line.
local widths, measuredFor = {}, nil
local function columnWidth(reference)
	local file, height = chatFont()
	if not file then
		return nil
	end
	local signature = file .. ":" .. tostring(height)
	if signature ~= measuredFor then
		widths, measuredFor = {}, signature
	end
	if widths[reference] == nil then
		widths[reference] = (Shell.Width(reference) or 0) + gutter(height)
	end
	return widths[reference]
end

--- Text set in a column, padded to the column's width. Text wider than its
-- column is left as it is, so an overlong cell loses its own alignment and no
-- other; where nothing can measure, one space stands in for the whole column.
-- @param text the cell, markup and all
-- @param reference the widest thing the column must hold
function Shell.Cell(text, reference)
	local width, drawn = columnWidth(reference), Shell.Width(text)
	if not width or not drawn then
		return text .. " "
	end
	return text .. Shell.Gap(width - drawn)
end

--- Text set at the right of its column, which is how a number reads: the
-- digits end together however many of them there are.
function Shell.RightCell(text, reference)
	local width, drawn = columnWidth(reference), Shell.Width(text)
	if not width or not drawn then
		return text .. " "
	end
	local _, height = chatFont()
	return Shell.Gap(width - drawn - gutter(height)) .. text .. Shell.Gap(gutter(height))
end

--- How many lines the chat frame remembers, or nil where there is no frame to
-- ask. A player who raises it with an addon raises what a page may print.
function Shell.Kept()
	local frame = chatFrame()
	local kept = frame and frame.GetMaxLines and frame:GetMaxLines()
	if not kept or kept <= 0 then
		return nil
	end
	return kept
end

--- How wide a line may draw before the chat frame wraps it, or nil where there
-- is no frame to ask. The inset is what the frame keeps for itself and the
-- text never draws into.
local function chatRoom()
	local frame = chatFrame()
	local width = frame and frame.GetWidth and frame:GetWidth()
	if not width or width <= 0 then
		return nil
	end
	return width - 10
end

--- What stands in a name's place where it was cut.
local ELLIPSIS = "..."

--- Text cut to a width, with an ellipsis standing where it was cut, or text
-- as it is where it already fits or nothing can measure it. Nothing is lost by
-- the cut: a name is drawn inside the game's own spell link, so the whole of it
-- is one hover away.
-- @param text the text
-- @param width how wide it may draw, in pixels
function Shell.Trimmed(text, width)
	if not width then
		return text
	end
	local drawn = Shell.Width(text)
	if not drawn or drawn <= width then
		return text
	end
	-- The ellipsis is part of what a cut costs, so the guess is made against the
	-- room left once it is allowed for, and walked back from there: a long name
	-- costs two or three measurements rather than one per letter it loses.
	local room = math.max(0, width - (Shell.Width(ELLIPSIS) or 0))
	local n = math.min(#text, math.max(1, math.floor(#text * room / drawn)))
	while n > 0 do
		-- Never cut inside a letter: the tail bytes of one draw as nothing good.
		while n > 0 and text:byte(n) >= 0x80 and text:byte(n) < 0xC0 do
			n = n - 1
		end
		local candidate = text:sub(1, n) .. ELLIPSIS
		if (Shell.Width(candidate) or 0) <= width then
			return candidate
		end
		n = n - 1
	end
	return ELLIPSIS
end

--- The widest id a result column must hold. Epsilon's own spells run past a
-- million, and a column sized for them is the same column on every page, so
-- one search's results line up with the next search's in the same scrollback.
Shell.ID_COLUMN = "1000000"

--- The column an icon takes on a line, whether or not there is an icon to fill
-- it, so that what follows stands in the same place either way.
function Shell.IconGap()
	return Shell.Gap(Shell.ICON)
end

--- How wide a result's name may draw: what the frame has, less everything else
-- the line carries. What follows the name is measured rather than guessed at,
-- because it is not the same on every line -- a spell the player knows says so,
-- and a spell with no aura offers one word fewer -- and because the brackets a
-- name is drawn inside are part of what it costs. A frame too narrow to give a
-- name anything keeps a floor, and there the line wraps rather than the name
-- disappear.
-- @param rest what the line carries after the name, markup and all
local function nameRoom(rest)
	local room = chatRoom()
	if not room then
		return nil
	end
	local taken = (columnWidth(Shell.ID_COLUMN) or 0)
		+ Shell.ICON
		+ (Shell.Width(Shell.Iconed("", nil) .. rest) or 0)
	return math.max(room - taken, 60)
end

--- A bracketed word led by an icon where there is one, the icon against
-- the bracket.
-- @param label the word
-- @param icon a texture's file id, or nil
function Shell.Iconed(label, icon)
	local shown = "[" .. label .. "]"
	if icon then
		return "|T" .. icon .. ":" .. Shell.ICON .. "|t" .. shown
	end
	return shown
end

--- One of this addon's links, shown as a bracketed word.
-- The link names the spell, the verb and, for a part's action, the axis and
-- the row, so that it is complete in itself: `...:133:spawn:model:1`.
-- @param spellID the spell
-- @param verb the action
-- @param label the word shown
-- @param axis the axis of the part the action takes, or nil for a spell action
-- @param n the part's row on that axis
-- @param colour the colour code to draw it in, the action blue by default
-- @param icon a texture's file id to lead the word with, or nil
-- @return the link markup
function Shell.Link(spellID, verb, label, axis, n, colour, icon)
	local target = Shell.LINK .. ":" .. spellID .. ":" .. verb
	if axis then
		target = target .. ":" .. axis .. ":" .. n
	end
	return (colour or BLUE) .. "|H" .. target .. "|h" .. Shell.Iconed(label, icon) .. "|h" .. END
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

--- The game's own link to a spell, as `.lookup` prints one, its icon inside
-- the link against the name.
-- @param spell a SpellData, or any record with the spell's id, name and icon
-- @param width how wide the name may draw before it is cut, or nil to leave it
function Shell.SpellLink(spell, width)
	local name, icon = Shell.Shown(spell)
	local shown = Shell.Iconed(Shell.Trimmed(name, width), icon)
	if not icon then
		-- A spell with no icon keeps the column one would take, so that every
		-- name in a list begins at the same place.
		shown = Shell.IconGap() .. shown
	end
	return WHITE .. "|Hspell:" .. spell.id .. "|h" .. shown .. "|h" .. END
end

--- Whether two of a part's values stand for the same thing, either being
-- absent. A value the pack resolved from an id is a record and a plain one is
-- a number or a word, so the two are compared by what they were stored as.
function Shell.Same(one, other)
	if one == nil or other == nil then
		return one == other
	end
	local function stored(value)
		if type(value) == "table" then
			return value.id ~= nil and value.id or value.text
		end
		return value
	end
	return stored(one) == stored(other)
end

--- The separator between a link and its buttons, and between buttons, as
-- `.lookup` draws it.
Shell.DASH = " - "

--- Whether the player knows a spell, as the client says; never, under a
-- bare interpreter.
function Shell.Known(spellID)
	return _G.IsSpellKnown ~= nil and _G.IsSpellKnown(spellID) == true
end

--- The spell actions a spell takes on one surface, as links joined.
-- @param spellID the spell
-- @param where "result" or "dossier"
-- @return the links joined
function Shell.SpellActionLinks(spellID, where)
	local known = Shell.Known(spellID)
	local links = {}
	for _, action in ipairs(Shell.SPELL_ACTIONS) do
		local offered = action.on == "both" or action.on == where
		if action.knownOnly and not known or action.unknownOnly and known then
			offered = false
		end
		if offered and (not action.auraOnly or Epsilook:HasPartOfKind(spellID, "mech", "aura")) then
			links[#links + 1] = Shell.Link(spellID, action.key, action.label)
		end
	end
	return table.concat(links, Shell.DASH)
end

--- One result for a spell, as two lines: the spell with its actions, then
-- what it is made of.
-- A result wraps in a chat frame more often than not, so the wrap is designed
-- in rather than suffered. The first line is the spell and what can be done
-- with it: the id set at the right of a column wide enough for any id, the
-- game's own spell link led by its icon, and the actions. Nothing marks a
-- spell the player already knows, because the actions say it: the one offered
-- is unlearn rather than learn. The second begins under the name
-- and carries the counts, each a link that lists the parts on hover and prints
-- them on a click. Neither line holds a field whose place depends on how long
-- the field before it ran, so nothing a long name does can move a column: a
-- name too long for the room left by the id, the icon and the actions is cut
-- with an ellipsis, and the whole of it is a hover away in the game's own
-- tooltip.
-- @param spell a SpellData
-- @param counts the spell's part counts by axis, or nil to leave them off
-- @param axes the axes to report, in order
-- @return the spell's line, and what it is made of, which may be empty
function Shell.ResultLines(spell, counts, axes)
	-- What follows the name is built first, because how long it runs is what
	-- decides how much name there is room for.
	-- Nothing marks a spell the player already knows: the actions say it, since
	-- the one offered is unlearn rather than learn.
	local rest = ""
	local actions = Shell.SpellActionLinks(spell.id, "result")
	if actions ~= "" then
		-- The actions sit beside the spell, because that is the thing they act on.
		rest = rest .. Shell.DASH .. actions
	end
	local head = Shell.RightCell(GOLD .. spell.id .. END, Shell.ID_COLUMN)
		.. Shell.SpellLink(spell, nameRoom(rest))
		.. rest
	local below = ""
	if counts and axes then
		local made = {}
		for _, axis in ipairs(axes) do
			local n = counts[axis] or 0
			if n > 0 then
				local label = n .. " " .. axis
				made[#made + 1] = Shell.Link(
					spell.id,
					Epsilook.Inspect.LIST,
					label,
					axis,
					0,
					Shell.AXIS_COLOURS[axis] or GREY
				)
			end
		end
		if #made > 0 then
			below = Shell.Cell("", Shell.ID_COLUMN) .. Shell.IconGap() .. table.concat(made, " ")
		end
	end
	return head, below
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

--- A message read the way `.lookup` is typed: a head word that opens the
-- message, followed by a space, puts everything after it inside that head's
-- row scope, so `model fire missile` is `model:{fire missile}` and asks for
-- one model with both. The leniency is the shell's, not the grammar's --
-- the query the engine sees is one the language reads the same way -- and a head
-- bound with the colon, as in `model:fire missile`, is left exactly as typed. A
-- rest already in braces is bound as it is, and a property head, which takes
-- one value and no scope, binds to the first token alone. A head word on its
-- own asks for any value of it -- `missile` is `missile:*` -- rather than for
-- the word as text; a COLUMN word alone never reaches here, because every
-- spell has a model and the shell answers that word with the column's doors
-- instead.
-- @param message the query as typed
-- @return the query as the engine reads it
function Shell.Lenient(message)
	local grammar = Epsilook.Schema.grammar
	local head, rest = message:match("^(%S+)%s+(.+)$")
	if not head then
		head, rest = message:match("^(%S+)%s*$"), nil
	end
	if not head or head:find(grammar.bind, 1, true) then
		return message
	end
	local resolved = Epsilook.Schema.HeadOf(Epsilook.Text.fold(head))
	if not resolved then
		return message
	end
	if rest == nil then
		return head .. grammar.bind .. grammar.wildcard
	end
	if resolved.role == "prop" then
		-- A property takes one value and opens no scope: it binds to the
		-- first token, and the rest stands as typed.
		return head .. grammar.bind .. rest
	end
	local open, close = grammar.scope.open, grammar.scope.close
	if rest:sub(1, #open) == open and rest:sub(-#close) == close then
		return head .. grammar.bind .. rest
	end
	return head .. grammar.bind .. open .. rest .. close
end

--- The column a lone head word names, or nil where the word is no column's.
-- A column word alone is the one head worth answering with its doors rather
-- than with a search: every spell has a model, so `model` on its own asks a
-- question nobody means, while a kind or a property alone is a real one.
-- @param message the query as typed
-- @return the column's key, or nil
function Shell.LoneColumn(message)
	local word = message:match("^(%S+)%s*$")
	if not word or word:find(Epsilook.Schema.grammar.bind, 1, true) then
		return nil
	end
	local head = Epsilook.Schema.HeadOf(Epsilook.Text.fold(word))
	if head and head.role == "column" then
		return head.column
	end
	return nil
end

--- What one column holds and every door into it, read off the declarations.
-- Printed for a lone column word, so a player who knows the column but not
-- its words can ask the column itself.
-- @param key the column's key
-- @return a list of lines
function Shell.ColumnLines(key)
	local grammar = Epsilook.Schema.grammar
	local column = Epsilook.Schema.columnByKey[key]
	local tone = Shell.AXIS_COLOURS[key] or GOLD
	local lines = { tone .. key .. END .. GREY .. "  " .. (column and column.hint or "") .. END }
	-- Every kind of the column, not only the ones promoted to a top-level
	-- word: `model:missile` and `model:display` are both doors and only the
	-- first is a head in its own right. Each kind's properties hang under it,
	-- since that is where they are reached from. A kind whose word is the
	-- column's own is no door of its own, so its properties belong to the
	-- column directly -- a sound is reached as `sound:{kit ...}`.
	local kinds, props = {}, {}
	for _, kind in ipairs(Epsilook.Schema.kindsOfColumn[key] or {}) do
		local names = {}
		for _, prop in ipairs(kind.props) do
			names[#names + 1] = prop.name
			if not kind.worded then
				props[#props + 1] = { word = prop.name, hint = prop.hint or "" }
			end
		end
		if kind.worded then
			kinds[#kinds + 1] = { word = kind.word, hint = kind.hint, props = names }
		end
	end
	local function section(title, words)
		if #words == 0 then
			return
		end
		lines[#lines + 1] = GOLD .. title .. END
		for _, head in ipairs(words) do
			lines[#lines + 1] = "  " .. tone .. head.word .. END .. "  " .. head.hint
			if head.props and #head.props > 0 then
				lines[#lines + 1] = "    " .. GREY .. table.concat(head.props, ", ") .. END
			end
		end
	end
	section("Kinds", kinds)
	section("Properties", props)
	local function ask(text, said)
		lines[#lines + 1] = "  " .. GREY .. "/elo " .. text .. END .. "  " .. said
	end
	-- A kind word stands on its own as a value; a property does not, so an
	-- example built from one has to carry a value or it would be a query the
	-- reader is told to type and the engine refuses.
	if kinds[1] then
		lines[#lines + 1] = GOLD .. "Asking" .. END
		ask(key .. " " .. kinds[1].word, "one of these")
		ask(key .. grammar.bind .. kinds[1].word, "the same, bound")
		ask(key .. grammar.bind .. grammar.wildcard, "every spell with one at all")
	elseif props[1] then
		lines[#lines + 1] = GOLD .. "Asking" .. END
		ask(key .. " " .. props[1].word .. grammar.bind .. "<value>", "one of these")
		ask(
			key
				.. grammar.bind
				.. grammar.scope.open
				.. props[1].word
				.. grammar.bind
				.. "<value>"
				.. grammar.scope.close,
			"the same, one row"
		)
		ask(key .. grammar.bind .. grammar.wildcard, "every spell with one at all")
	end
	return lines
end

--- The topics the help is divided into, and the order they are offered in.
-- The whole of it runs to some thirty lines, which is a wall rather than an
-- answer, so what a reader is most likely to want -- what can be typed -- comes
-- alone, and the language waits behind a word.
Shell.HELP_TOPICS = {
	{ topic = "columns", hint = "what a spell can be searched by" },
	{ topic = "syntax", hint = "how a query is written" },
}

--- The help, read off the declarations so it cannot fall behind them.
--
-- Asked for nothing it says what the command takes and which topics there are.
-- Asked for a topic it says that topic alone: the columns with what each holds
-- and the other head words, or the operators, how terms combine and how an
-- answer is ordered.
-- @param topic which topic to say, or nil for the commands
-- @return a list of lines
function Shell.HelpLines(topic)
	local help = Epsilook:GetQueryHelp()
	local grammar = Epsilook.Schema.grammar
	local function title(text)
		return GOLD .. text .. END
	end
	-- The widest thing either column holds, so that a help line meets its
	-- neighbours instead of landing wherever a proportional font puts it. The
	-- longest command is the reference because it is the longest either column
	-- takes, and a column sized once is the same on every line of the page.
	local COMMAND = "/elo <id or spell link>"
	local function row(left, right, tone)
		return "  " .. Shell.Cell((tone or GOLD) .. left .. END, COMMAND) .. right
	end
	local lines = {}
	if not topic then
		lines[#lines + 1] = title("Epsilook")
			.. GREY
			.. " searches Epsilon's spells from chat"
			.. END
		lines[#lines + 1] = row("/elo <query>", "search; a page of " .. Shell.Page())
		lines[#lines + 1] = row("/elo <id or spell link>", "inspect one spell")
		lines[#lines + 1] = row("/elo next", "the next page")
		lines[#lines + 1] = row("/elo count <query>", "how many match")
		lines[#lines + 1] = row("/elo test", "check the install")
		lines[#lines + 1] = row("/elo options", "settings")
		for _, each in ipairs(Shell.HELP_TOPICS) do
			lines[#lines + 1] = row("/elo help " .. each.topic, each.hint)
		end
		lines[#lines + 1] = GREY .. "Epsilook  " .. END .. Shell.Link(0, SITE.key, SITE.label)
		return lines
	end

	if topic == "columns" then
		lines[#lines + 1] = title("Columns")
			.. GREY
			.. " a head word, a colon, a value: model"
			.. grammar.bind
			.. "fire"
			.. END
		for _, column in ipairs(help.columns) do
			lines[#lines + 1] = row(column.key, column.hint, Shell.AXIS_COLOURS[column.key])
		end
		-- Each door wears its column's tone, the one its parts' labels wear in
		-- the dossier, so the help and the dossier colour one axis one way.
		local doors = {}
		for _, head in ipairs(help.heads) do
			if head.role ~= "column" then
				local tone = Shell.AXIS_COLOURS[head.column]
				doors[#doors + 1] = tone and tone .. head.word .. END or head.word
			end
		end
		lines[#lines + 1] = title("Other heads")
			.. GREY
			.. " reached the same way: scale"
			.. grammar.bind
			.. "+50%"
			.. END
		lines[#lines + 1] = "  " .. table.concat(doors, ", ")
		return lines
	end

	local ops = {}
	for _, op in ipairs(help.operators) do
		ops[#ops + 1] = op.symbol
	end
	lines[#lines + 1] = title("Operators")
	lines[#lines + 1] =
		row(table.concat(ops, " "), "compare or anchor a value: cast>2s, name=Fireball")
	lines[#lines + 1] =
		row("a" .. grammar.range .. "b", "a range: scale" .. grammar.bind .. "10-90")
	lines[#lines + 1] =
		row(grammar.wildcard, "any value: model" .. grammar.bind .. grammar.wildcard)
	lines[#lines + 1] = title("Between terms")
	lines[#lines + 1] = row("a space", "both must hold")
	lines[#lines + 1] = row(grammar["or"] .. " or " .. grammar.orWord, "either may")
	lines[#lines + 1] = row(
		grammar.negate .. "term",
		"excludes it: fire " .. grammar.negate .. "model" .. grammar.bind .. "missile"
	)
	lines[#lines + 1] =
		row(grammar.phrase .. "a phrase" .. grammar.phrase, "keeps its words together")
	lines[#lines + 1] = row(
		"head" .. grammar.bind .. grammar.scope.open .. "a b" .. grammar.scope.close,
		"one row holding both: model"
			.. grammar.bind
			.. grammar.scope.open
			.. "fire missile"
			.. grammar.scope.close
	)
	lines[#lines + 1] = title("Ordering")
	lines[#lines + 1] = row(
		grammar.sortWord .. grammar.bind .. "<head>",
		"order by it, as in "
			.. grammar.sortWord
			.. grammar.bind
			.. "name or "
			.. grammar.sortWord
			.. grammar.bind
			.. "cast; several apply in turn"
	)
	lines[#lines + 1] =
		row(grammar.negate .. grammar.sortWord .. grammar.bind .. "<head>", "the other way round")
	lines[#lines + 1] = title("A head word then a space")
		.. GREY
		.. " scopes all that follows: /elo model fire missile is model"
		.. grammar.bind
		.. grammar.scope.open
		.. "fire missile"
		.. grammar.scope.close
		.. "; a kind word alone asks for any of it, and a column word alone prints its doors"
		.. END
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

--- The engine pauses inside its heavy scans through this: a yield, taken
-- only inside a coroutine, so a job gives the frame back mid-scan and a
-- call from outside any job runs straight through.
Epsilook.Search.Pauser = function()
	if coroutine.running() then
		coroutine.yield()
	end
end

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

--- Where the last search stopped, for `next`.
local paging

--- Print one page of results for a query, from a spell row, as a job. The
-- page prints as soon as it is full and ends in the way on; the total is
-- not counted, since that walks every spell and would hold every page.
-- @param tree the parsed query
-- @param text the query as typed, for the header
-- @param fromIndex the spell row to resume from
local function page(tree, text, fromIndex)
	-- The query's own limit caps what the pager lists. The end-counting form
	-- needs the whole answer before its first line, which a forward pager
	-- cannot give; the sort's other direction brings that end to the front.
	local limit = tree.limit
	if limit and limit < 0 then
		say(
			Shell.Said(
				"first:-" .. -limit .. " lists the end; turn the sort round and list the front"
			)
		)
		return
	end
	-- The answer to the command comes first, before the job does anything,
	-- so a search that takes frames to find its first hit is never a silence.
	local sorted = Epsilook:IsQuerySorted(tree)
	if fromIndex then
		say(Shell.Said("next page of " .. text))
	elseif sorted then
		say(Shell.Said("searching and sorting " .. text))
	else
		say(Shell.Said("searching " .. text))
	end
	run(function()
		local axes = Epsilook:GetPartAxes()
		local step = Epsilook:FindSpells(tree, fromIndex, Shell.SLICE)
		local spell, counts = {}, {}
		local seenBefore = fromIndex and paging and paging.seen or 0
		local want = Shell.Page()
		if limit and limit - seenBefore < want then
			want = limit - seenBefore
		end
		local shown, resume = 0, nil
		while shown < want do
			local at, spellID, after = step()
			if at == nil then
				break
			elseif at == false then
				coroutine.yield()
			else
				Epsilook:GetSpellDataByIndex(at, spell)
				Epsilook:GetPartCounts(spellID, counts)
				local head, below = Shell.ResultLines(spell, counts, axes)
				say(head)
				if below ~= "" then
					say(below)
				end
				shown, resume = shown + 1, after
			end
		end
		if shown == 0 then
			say(Shell.Said((fromIndex and "no more" or "nothing") .. " for " .. text))
			paging = nil
			return
		end
		local seen = seenBefore + shown
		if shown < Shell.Page() or (limit and seen >= limit) then
			paging = nil
			say(Shell.Said(seen .. " for " .. text))
			return
		end
		paging = { tree = tree, text = text, index = resume, seen = seen }
		say(Shell.Said(seen .. " shown" .. Shell.DASH .. Shell.Link(0, NEXT.key, NEXT.label)))
	end)
end

--- Count a query's matches as a job, and print the total. A walk over every
-- spell, which is why it is its own door rather than part of every search.
local function count(tree, text)
	say(Shell.Said("counting " .. text))
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
	count = function(rest)
		local tree, text = parsed(rest)
		if tree then
			count(tree, text)
		end
	end,
	next = function()
		if not paging then
			say(Shell.Said("nothing to page; search first"))
			return
		end
		page(paging.tree, paging.text, paging.index)
	end,
	inspect = function(rest)
		local spellID = Shell.LoneSpell(rest) or tonumber(rest)
		if not spellID then
			say(Shell.Said("inspect takes a spell id or a spell link"))
			return
		end
		Epsilook.Inspect.Print(spellID, say)
	end,
	help = function(rest)
		local wanted = rest ~= "" and rest:lower() or nil
		local known = wanted == nil
		for _, each in ipairs(Shell.HELP_TOPICS) do
			known = known or each.topic == wanted
		end
		if not known then
			say(Shell.Said("no help on " .. rest .. "; try /elo help"))
			return
		end
		for _, line in ipairs(Shell.HelpLines(wanted)) do
			say(line)
		end
	end,
	test = function()
		Epsilook:SelfTest()
	end,
	options = function()
		Epsilook.Options.Show()
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
	local column = Shell.LoneColumn(message)
	if column then
		for _, line in ipairs(Shell.ColumnLines(column)) do
			say(line)
		end
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
	elseif verb == SITE.key then
		Shell.CopyWebsite()
	elseif verb == NEXT.key then
		Shell.SUBCOMMANDS.next()
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

--- Put text in the chat box for the player to type a command around, opening
-- the box first where it is shut. A shift-click hands the box what it already
-- has open; a click on a copy is a button, so it opens one rather than doing
-- nothing.
-- @param text the text to insert
function Shell.Type(text)
	-- The client's insert only lands in a box that is already ACTIVE, and a
	-- click on a chat link is normally made with no box open at all, so where
	-- none is active the client's own opener is what puts the text there.
	-- Insert into an active box rather than opening one, or a player part-way
	-- through a whisper would lose it.
	local active = _G.ChatEdit_GetActiveWindow
	if active and active() and _G.ChatEdit_InsertLink then
		_G.ChatEdit_InsertLink(text)
	elseif _G.ChatFrame_OpenChat then
		_G.ChatFrame_OpenChat(text)
	end
end

--- Put the address where it can be selected and copied: a chat frame cannot
-- be. The copy frame most players here already have is asked first, and
-- without it a dialog of our own holds the address highlighted, so the word
-- works on a bare install too.
function Shell.CopyWebsite()
	local arc = _G.ARC
	if arc and arc.COPY then
		arc:COPY(Shell.WEBSITE)
		return
	end
	local dialogs, show = _G.StaticPopupDialogs, _G.StaticPopup_Show
	if not dialogs or not show then
		return
	end
	dialogs.EPSILOOK_WEBSITE = {
		text = "Epsilook",
		button1 = _G.CLOSE or "Close",
		hasEditBox = true,
		editBoxWidth = 260,
		timeout = 0,
		whileDead = true,
		hideOnEscape = true,
		OnShow = function(dialog)
			local box = dialog.editBox
			if box then
				box:SetText(Shell.WEBSITE)
				box:HighlightText()
				box:SetFocus()
			end
		end,
	}
	show("EPSILOOK_WEBSITE")
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
-- A spell link shows the game's own spell tooltip, which on this client
-- already carries what an aura says; a part's link shows everything the part
-- carries; every one ends in what a click will do. Only this addon's links
-- are handled: the chat frame has other hands on the others.
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
	if verb == SITE.key then
		tooltip:SetText(SITE.hint, 1, 1, 1)
	elseif verb == NEXT.key then
		tooltip:SetText(NEXT.hint:format(Shell.Page()), 1, 1, 1)
	elseif axis and verb == Epsilook.Inspect.LIST then
		Epsilook.Inspect.FillAxisTooltip(tooltip, id, axis)
		hint = Epsilook.Inspect.HintOf(axis, verb)
	elseif axis then
		local part = Epsilook:GetPartDataByIndex(id, axis, n)
		if part and (verb == Epsilook.Inspect.GROUP or verb == Epsilook.Inspect.COPYGROUP) then
			Epsilook.Inspect.FillGroupTooltip(tooltip, part)
		elseif part then
			Epsilook.Inspect.FillTooltip(tooltip, part, id)
		end
		hint = Epsilook.Inspect.HintOf(axis, verb, part)
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

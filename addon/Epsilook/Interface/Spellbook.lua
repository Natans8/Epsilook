--- An entry of this addon's own in the spellbook's right-click menu.
--
-- The client's spellbook has no menu of its own; the one that opens on a
-- right-click belongs to Epsilon, whose library builds it once as a table and
-- hands that same table to `EasyMenu` on every click. So this adds to theirs
-- rather than drawing another, which is what a player expects: one menu on one
-- button, with a section in it that happens to be ours.
--
-- It is added the first time the menu is shown and not at load, because the
-- table is a local of theirs and the only place it can be reached is on its way
-- to be drawn. The call is wrapped rather than hooked after the fact, since a
-- hook runs once the menu has already been built and the entry would not appear
-- until the second click. Everything that is not that menu passes through
-- untouched.
--
-- ⚠ This is the one place the addon reaches into another's interface. It fails
-- quietly where Epsilon's library is absent or has changed, because a spellbook
-- that opens no menu is a great deal better than one that errors on every
-- right-click.

_G.Epsilook = _G.Epsilook or {}
local Epsilook = _G.Epsilook

local Spellbook = {}
Epsilook.Spellbook = Spellbook

--- The frame Epsilon's library shows its spellbook menu on, and where it leaves
-- the spell the menu was opened for.
local MENU_FRAME = "ExampleMenuFrame"

--- The word the section is titled with, in the style the menu's own sections
-- take, and the one thing under it.
local TITLE, INSPECT = "Epsilook ...", "Inspect"

--- Say a line the way the rest of the addon says one.
local function say(line)
	if _G.DEFAULT_CHAT_FRAME then
		_G.DEFAULT_CHAT_FRAME:AddMessage(line)
	end
end

--- The entries this addon adds, in the shape the menu's own entries take: a
-- rule, a title, then what sits under it indented as theirs are.
-- @param spellOf a function answering which spell the menu stands open for
-- @return a list of menu entries
function Spellbook.Entries(spellOf)
	return {
		{ text = "", isTitle = true, notCheckable = true, disabled = true },
		{ text = TITLE, isTitle = true, notCheckable = true },
		{
			text = "  " .. INSPECT,
			notCheckable = true,
			func = function()
				local spellID = spellOf()
				if spellID then
					Epsilook.Inspect.Print(spellID, say)
				end
				if _G.CloseDropDownMenus then
					_G.CloseDropDownMenus()
				end
			end,
		},
	}
end

--- Add this addon's entries to a menu, once, and say whether they went in.
-- @param menu the list of entries the menu is drawn from
-- @param frame the frame it is drawn on
-- @return whether this call was the one that added them
function Spellbook.Extend(menu, frame)
	if type(menu) ~= "table" or menu.epsilook then
		return false
	end
	menu.epsilook = true
	for _, entry in
		ipairs(Spellbook.Entries(function()
			return frame and frame._spellID
		end))
	do
		menu[#menu + 1] = entry
	end
	return true
end

--- Wire the addition into the menu, once. Skipped under a bare interpreter and
-- wherever the menu this extends does not exist.
local function install()
	local shown = _G.EasyMenu
	if type(shown) ~= "function" then
		return
	end
	_G.EasyMenu = function(menu, frame, ...)
		if frame and frame == _G[MENU_FRAME] then
			pcall(Spellbook.Extend, menu, frame)
		end
		return shown(menu, frame, ...)
	end
end

install()

return Spellbook

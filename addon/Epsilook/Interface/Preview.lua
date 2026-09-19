--- A look at the thing a link names, in frames of our own.
--
-- The client's tooltip cannot hold a model, so a preview is not a tooltip: it is
-- a frame this addon owns. Nothing here is protected or shared, so there is no
-- taint to take and nobody else's frame to fight over; the chat frame's hover
-- script is insecure and hands us the link, and what is drawn after that is
-- ours.
--
-- There are two ways to see one. Resting on a link shows it and leaving takes it
-- down, which costs nothing and interrupts nothing. Clicking pins it, and a
-- pinned look stays until it is closed, because the reason to pin is to put two
-- of them beside each other -- two morphs, the same spell at two stages -- and
-- a look that vanishes when the pointer moves cannot be compared with anything.
--
-- A pinned look is a window the player places, which is what every pinned thing
-- in this client is: the client's own pinned chat link, ItemRefTooltip, is
-- movable, toplevel, and closed with a button. So one appears where it was
-- asked for, is dragged wherever it is wanted, and rises above its fellows when
-- it is clicked. Nothing arranges them after that, because the player put them
-- where they are.
--
-- ⚠ Only a model is drawn today. What a subject is and how it is drawn is a row
-- in `SUBJECTS`, so an animation, a creature or a spell's own visual is a row
-- rather than a branch when each is built.

_G.Epsilook = _G.Epsilook or {}
local Epsilook = _G.Epsilook

local Preview = {}
Epsilook.Preview = Preview

--- How large a look is, how far the next one is offset from the last, and how
-- many may be pinned at once.
--
-- It does not follow the pointer. A chat frame sits near the foot of the screen
-- and a look pinned to the pointer there has only the room left between the two
-- to be drawn in, which is not enough of a model to be worth looking at. So it
-- opens above the chat, where the whole height of the screen is, and is as
-- large as that allows rather than as small as the pointer allows.
Preview.SIZE, Preview.GAP, Preview.MOST = 300, 24, 4

--- What can be looked at, and how. `from` is what the subject needs off a part;
-- `draw` puts it on a model frame. A part offers a preview when its `from`
-- resolves, so teaching this one more subject is a row.
Preview.SUBJECTS = {
	model = {
		from = function(part)
			return Epsilook.Inspect.FileOf(part)
		end,
		draw = function(model, fileID)
			-- A file the client has no model for leaves the frame empty, which is
			-- a better answer to a hover than an error on every one.
			pcall(model.SetModel, model, fileID)
		end,
	},
}

--- What a part can be looked at as, or nil: the first subject whose need it
-- meets, and the value that met it.
-- @param part a PartData
-- @return the subject and its value, or nil
function Preview.SubjectOf(part)
	for _, subject in pairs(Preview.SUBJECTS) do
		local value = part and subject.from(part)
		if value then
			return subject, value
		end
	end
	return nil
end

--- Whether a part can be looked at at all, which is what decides whether a line
-- offers the word.
function Preview.Offers(part)
	return Preview.SubjectOf(part) ~= nil
end

--- Build one look. A frame is made when it is first wanted rather than at load,
-- since a player who never hovers one never needs any.
-- @param pinned whether it carries a close button
local function build(pinned)
	if not (_G.CreateFrame and _G.UIParent) then
		return nil
	end
	local frame = _G.CreateFrame("Frame", nil, _G.UIParent, "TooltipBorderedFrameTemplate")
	frame:SetSize(Preview.SIZE, Preview.SIZE)
	frame:SetFrameStrata("TOOLTIP")
	frame.model = _G.CreateFrame("PlayerModel", nil, frame)
	frame.model:SetPoint("TOPLEFT", 6, -6)
	frame.model:SetPoint("BOTTOMRIGHT", -6, 6)
	if pinned then
		-- What the client's own pinned chat link is: movable, above its fellows
		-- when clicked, and closed with a button.
		frame:SetMovable(true)
		frame:EnableMouse(true)
		frame:SetToplevel(true)
		frame:RegisterForDrag("LeftButton")
		frame:SetScript("OnDragStart", frame.StartMoving)
		frame:SetScript("OnDragStop", frame.StopMovingOrSizing)
		frame.close = _G.CreateFrame("Button", nil, frame, "UIPanelCloseButton")
		frame.close:SetPoint("TOPRIGHT", 2, 2)
		frame.close:SetScript("OnClick", function()
			Preview.Unpin(frame)
		end)
	end
	frame:Hide()
	return frame
end

--- Put a subject on a frame, the same way whether it is hovered or pinned.
local function draw(frame, part)
	local subject, value = Preview.SubjectOf(part)
	if not (frame and frame.model and subject) then
		return false
	end
	frame.model:ClearModel()
	subject.draw(frame.model, value)
	frame.model:SetPosition(0, 0, 0)
	frame.model:SetFacing(0.6)
	return true
end

--- The one frame a hover uses, made once.
local hovered

--- The looks that have been pinned, oldest first.
local pinned = {}

--- Put a look where there is room for it: standing on the chat frame it belongs
-- to, which leaves it the height of the screen to be drawn in, and falling back
-- to the middle where there is no chat frame to stand on.
-- @param frame the look
-- @param step how far to offset it, for a look that is not the first
local function place(frame, step)
	frame:ClearAllPoints()
	local chat = _G.DEFAULT_CHAT_FRAME
	if chat and chat.GetName and chat:GetName() then
		frame:SetPoint("BOTTOMLEFT", chat, "TOPLEFT", step, Preview.GAP + step)
	else
		frame:SetPoint("CENTER", _G.UIParent, "CENTER", step, step)
	end
end

--- Show a part while it is hovered, above the chat where there is room.
-- @param part a PartData
-- @return whether there was something to show
function Preview.Hover(part)
	if not hovered then
		hovered = build(false)
	end
	if not draw(hovered, part) then
		return false
	end
	place(hovered, 0)
	hovered:Show()
	return true
end

--- Take the hovered look down. A pinned one is not touched.
function Preview.Leave()
	if hovered then
		hovered:Hide()
	end
end

--- Keep a look until it is closed. The oldest goes when there are too many, so
-- that a click always shows something rather than quietly doing nothing.
-- @param part a PartData
-- @return whether it was pinned
function Preview.Pin(part)
	local frame = build(true)
	if not draw(frame, part) then
		return false
	end
	-- Offset by however many are already up, so the newest is visibly its own
	-- rather than landing exactly on the one before it.
	place(frame, (#pinned + 1) * Preview.GAP)
	table.insert(pinned, frame)
	while #pinned > Preview.MOST do
		local oldest = table.remove(pinned, 1)
		oldest:Hide()
	end
	frame:Show()
	return true
end

--- Close one pinned look. The others stay where the player put them.
function Preview.Unpin(frame)
	for index, each in ipairs(pinned) do
		if each == frame then
			table.remove(pinned, index)
			break
		end
	end
	frame:Hide()
end

--- How many looks are pinned, which is what a test asks.
function Preview.Pinned()
	return #pinned
end

return Preview

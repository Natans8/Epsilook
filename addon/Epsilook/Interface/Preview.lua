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
-- Pinned looks stack beside the chat rather than floating over it, and they are
-- arranged rather than dragged: dragging means overlap, an order to keep and
-- positions to remember, which is a window manager and belongs to the interface
-- that has not been built yet. Closing one moves the rest up.
--
-- ⚠ Only a model is drawn today. What a subject is and how it is drawn is a row
-- in `SUBJECTS`, so an animation, a creature or a spell's own visual is a row
-- rather than a branch when each is built.

_G.Epsilook = _G.Epsilook or {}
local Epsilook = _G.Epsilook

local Preview = {}
Epsilook.Preview = Preview

--- How large a look is, how far the column sits from the chat, and how many
-- may be pinned. Beyond four they are too small to read, and somebody wanting
-- more than four at once wants the window rather than a column.
Preview.SIZE, Preview.GAP, Preview.MOST = 180, 16, 4

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

--- Lay the pinned looks out beside the chat, oldest at the top, so that closing
-- one moves the rest up rather than leaving a hole.
local function arrange()
	local anchor = _G.DEFAULT_CHAT_FRAME
	for index, frame in ipairs(pinned) do
		frame:ClearAllPoints()
		if index == 1 then
			if anchor and anchor.GetName and anchor:GetName() then
				frame:SetPoint("BOTTOMLEFT", anchor, "BOTTOMRIGHT", Preview.GAP, 0)
			else
				frame:SetPoint("CENTER")
			end
		else
			frame:SetPoint("BOTTOMLEFT", pinned[index - 1], "TOPLEFT", 0, Preview.GAP / 2)
		end
		frame:Show()
	end
end

--- Show a part beside the pointer while it is hovered.
-- @param part a PartData
-- @return whether there was something to show
function Preview.Hover(part)
	if not hovered then
		hovered = build(false)
	end
	if not draw(hovered, part) then
		return false
	end
	hovered:ClearAllPoints()
	local x, y
	if _G.GetCursorPosition then
		x, y = _G.GetCursorPosition()
	end
	local scale = _G.UIParent and _G.UIParent:GetEffectiveScale()
	if x and y and scale and scale > 0 then
		hovered:SetPoint(
			"BOTTOMLEFT",
			_G.UIParent,
			"BOTTOMLEFT",
			x / scale + Preview.GAP,
			y / scale
		)
	else
		hovered:SetPoint("CENTER")
	end
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
	table.insert(pinned, frame)
	while #pinned > Preview.MOST do
		local oldest = table.remove(pinned, 1)
		oldest:Hide()
	end
	arrange()
	return true
end

--- Close one pinned look, and move the rest up.
function Preview.Unpin(frame)
	for index, each in ipairs(pinned) do
		if each == frame then
			table.remove(pinned, index)
			break
		end
	end
	frame:Hide()
	arrange()
end

--- How many looks are pinned, which is what a test asks.
function Preview.Pinned()
	return #pinned
end

return Preview

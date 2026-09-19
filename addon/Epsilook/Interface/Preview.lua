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
-- A part is looked at as one of the things in `SUBJECTS`, which is a row each
-- rather than a branch, so a creature or a piece of gear is a row when it is
-- built. A whole spell is not one of them: it is not a part, it is the thing the
-- parts belong to, and it is played rather than drawn.

_G.Epsilook = _G.Epsilook or {}
local Epsilook = _G.Epsilook

local Preview = {}
Epsilook.Preview = Preview

--- How large a look is, how far the next one is offset from the last, and how
-- many may be pinned at once.
--
-- It opens beside what was hovered, on whichever side of it has room: past the
-- middle of the screen it opens to the left, below the middle it grows upward.
-- That is how the transmogrification browser on this client does it, and it is
-- right for the reason a fixed corner is wrong -- a look far from the thing it
-- is of makes a reader watch two places at once -- while a look fixed to the
-- pointer near the foot of the screen has only the floor to be drawn in.
Preview.SIZE, Preview.GAP, Preview.MOST = 300, 24, 4

--- Which way a model is turned when it is first drawn, a little off straight on
-- so that it reads as a thing rather than a silhouette.
Preview.FACING = 0.6

--- One property of a part as the pack stores it, which for an id is the number
-- the client takes.
local function stored(part, prop)
	return Epsilook:GetPartStored(part.axis, part.kind, part.slot, prop)
end

--- The extensions of the files the client loads as a model.
local MODEL_FILES = { m2 = true, mdx = true }

--- The model file a part names, or nil where the file it names is not one.
--
-- ⛔ A part naming a file is not a part naming a model: a sound row names an
-- `.ogg` and a texture a `.blp`, both through the same path property. Handing
-- either to `SetModel` crashes the game outright rather than erroring, which is
-- no more survivable inside a `pcall` than the light was -- the native loader
-- reads the bytes as a model whatever they are. So the file is asked what it is
-- before it is drawn, which is also why this is not a question about the axis:
-- what makes a file drawable is the file.
-- @param part a PartData
function Preview.ModelOf(part)
	local fileID, path = Epsilook.Inspect.FileOf(part)
	if not fileID then
		return nil
	end
	local extension = (path or ""):match("%.([%a%d]+)$")
	if not (extension and MODEL_FILES[extension:lower()]) then
		return nil
	end
	return fileID
end

--- What can be looked at, and how, in the order a part is tried against them.
-- `from` is what the subject needs off a part and `draw` puts it on a model
-- frame; a part offers a preview when the first `from` resolves, so the order
-- is which reading of a part wins where it could be read two ways. Teaching
-- this one more subject is a row.
--
-- An animation is played on the player's own body, because that is whose
-- animation it is and whose body the person asking is looking at. A body that
-- has been morphed belongs to the larger readings -- a stage, a whole spell --
-- where something in the spell did the morphing, and those are not built.
Preview.SUBJECTS = {
	{
		word = "animkit",
		from = function(part)
			return part.axis == "anim" and stored(part, "id") or nil
		end,
		draw = function(model, kitID)
			model:SetUnit("player")
			pcall(model.PlayAnimKit, model, kitID)
		end,
	},
	{
		word = "anim",
		from = function(part)
			return part.axis == "anim" and stored(part, "anim") or nil
		end,
		draw = function(model, animation)
			model:SetUnit("player")
			pcall(model.SetAnimation, model, animation)
		end,
	},
	{
		word = "model",
		from = function(part)
			return Preview.ModelOf(part)
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
	for _, subject in ipairs(Preview.SUBJECTS) do
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
	-- A model frame lights nothing by default, and a dark model in the dark is
	-- not a preview. The light is in front and a little above, as a viewer's is.
	--
	-- ⛔ Flat arguments, not the table this client's successors take. The table
	-- form is what the current transmogrification browser uses, and handing it
	-- to this client crashes the game outright rather than erroring: the native
	-- code reads a boolean and twelve numbers off what it was given. The four
	-- places 9.2.7 calls this itself all pass them flat.
	if frame.model.SetLight then
		frame.model:SetLight(true, false, 0, 0.8, -1, 1, 1, 1, 1, 0.3, 1, 1, 1)
	end
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
		-- Above the model, or the model takes the click. A child frame is born at
		-- its parent's level plus one, so the model and the button sit at the same
		-- height and the model, which fills the frame, wins the ground they share:
		-- the button answered only on the two pixels hanging off the corner, which
		-- is what an unclickable close button looks like from the outside.
		frame.close:SetFrameLevel(frame.model:GetFrameLevel() + 5)
		-- A pinned look is looked at, so it turns and it zooms.
		frame:EnableMouseWheel(true)
		frame:SetScript("OnMouseWheel", function(_, direction)
			frame.zoom = math.max(0, math.min(1, (frame.zoom or 0) + direction * 0.1))
			frame.model:SetPortraitZoom(frame.zoom)
		end)
		frame.model:EnableMouse(true)
		frame.model:SetScript("OnMouseDown", function()
			frame.turning = select(1, _G.GetCursorPosition())
		end)
		frame.model:SetScript("OnMouseUp", function()
			frame.turning = nil
		end)
		-- Where it is facing is kept here rather than asked back, so that turning
		-- it is arithmetic on a number this frame owns rather than a round trip
		-- through the model on every frame.
		frame.model:SetScript("OnUpdate", function(model)
			if frame.turning then
				local at = select(1, _G.GetCursorPosition())
				frame.facing = (frame.facing or Preview.FACING) + (at - frame.turning) / 80
				model:SetFacing(frame.facing)
				frame.turning = at
			end
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
	-- A frame is reused, so whatever was running on it stops: a spell's sequence
	-- left ticking would keep laying kits over whatever is drawn next.
	frame.kits = nil
	frame:SetScript("OnUpdate", nil)
	frame.model:ClearModel()
	subject.draw(frame.model, value)
	frame.model:SetPosition(0, 0, 0)
	frame.facing = Preview.FACING
	frame.model:SetFacing(frame.facing)
	return true
end

--- The one frame a hover uses, made once.
local hovered

--- The looks that have been pinned, oldest first.
local pinned = {}

--- Which corner of a look should meet which corner of what it opens beside, so
-- that it grows into the screen rather than off it. Past halfway across, it
-- opens to the left of its owner; past halfway down, it grows upward.
-- @param x, y where on the screen the thing being opened beside is
-- @return the look's own point, and the point on its owner to meet
local function sides(x, y)
	local width = _G.GetScreenWidth and _G.GetScreenWidth() or 1
	local height = _G.GetScreenHeight and _G.GetScreenHeight() or 1
	local mine, theirs = "LEFT", "RIGHT"
	if width > 0 and x / width > 0.5 then
		mine, theirs = "RIGHT", "LEFT"
	end
	if height > 0 and y / height > 0.5 then
		return "TOP" .. mine, "TOP" .. theirs
	end
	return "BOTTOM" .. mine, "BOTTOM" .. theirs
end

--- Where the pointer is, in the units a frame is placed in.
local function cursor()
	local x, y
	if _G.GetCursorPosition then
		x, y = _G.GetCursorPosition()
	end
	local scale = _G.UIParent and _G.UIParent:GetEffectiveScale()
	if not (x and y and scale and scale > 0) then
		return nil
	end
	return x / scale, y / scale
end

--- Put a look beside the tooltip that is already up for the same link, so the
-- words and the look are read in one place, falling back to the pointer.
-- @param frame the look
function Preview.Place(frame)
	local owner = _G.GameTooltip
	local x, y = cursor()
	frame:ClearAllPoints()
	if owner and owner.IsShown and owner:IsShown() and x then
		local mine, theirs = sides(x, y)
		frame:SetPoint(mine, owner, theirs, 0, 0)
	elseif x then
		local mine = sides(x, y)
		frame:SetPoint(mine, _G.UIParent, "BOTTOMLEFT", x, y)
	else
		frame:SetPoint("CENTER")
	end
end

--- The visual kits a spell draws, in the order the client plays them: by stage,
-- since a stage's stored number is its place in the cast, and by the order the
-- pack holds them within a stage.
-- @param spellID the spell
-- @return a list of `{id, stage}`, the first cast first
function Preview.KitsOf(spellID)
	local kits, seen = {}, {}
	for i = 1, Epsilook:GetNumParts(spellID, "fx") do
		local part = Epsilook:GetPartDataByIndex(spellID, "fx", i)
		if part.kind == "visual" then
			local id = stored(part, "id")
			local stage = stored(part, "phase") or 0
			-- A kit at two stages is played twice, which is what the spell does;
			-- the same kit twice at one stage is one row per audience.
			local once = stage .. ":" .. tostring(id)
			if id and not seen[once] then
				seen[once] = true
				kits[#kits + 1] = { id = id, stage = stage, at = #kits + 1 }
			end
		end
	end
	table.sort(kits, function(a, b)
		if a.stage ~= b.stage then
			return a.stage < b.stage
		end
		return a.at < b.at
	end)
	return kits
end

--- How long one stage is held before the next is laid over it, and how long the
-- whole cast stands before the body is cleared and it runs again.
Preview.BEAT, Preview.REST = 1.2, 2

--- Run a spell's kits on a body, one stage at a time, over and over.
--
-- A spell is a sequence and not a picture, so this plays it as one: the kits go
-- on in cast order, layering the way they layer during a real cast, and at the
-- end the body is cleared and it starts again. That is the loop a reader is
-- actually asking to see, and it is what one frame can show honestly -- all of
-- them at once would be every stage of the spell happening simultaneously, which
-- is a thing the spell never does.
-- @param frame a look whose `kits` are set
local function play(frame)
	frame.at, frame.due = 0, 0
	frame:SetScript("OnUpdate", function(_, elapsed)
		frame.due = frame.due - elapsed
		if frame.due > 0 then
			return
		end
		frame.at = frame.at + 1
		local kit = frame.kits and frame.kits[frame.at]
		if not kit then
			-- What takes the applied visuals back off a body, which is how the
			-- client's own browser of these does it. A cleared model faces where it
			-- was put rather than where it was turned to.
			frame.at, frame.due = 0, Preview.REST
			pcall(frame.model.RefreshUnit, frame.model)
			frame.model:SetFacing(frame.facing or Preview.FACING)
			return
		end
		frame.due = Preview.BEAT
		-- Held rather than played once, so a stage with a loop in it keeps going
		-- for as long as the stage lasts.
		pcall(frame.model.ApplySpellVisualKit, frame.model, kit.id, false)
	end)
end

--- Show what a whole spell looks like, on the player's own body.
--
-- This is the one a reader wants most and the only one they can have without
-- opening a spell: a page of results is twenty names, and the question asked of
-- every one of them is what it looks like. So resting on a spell answers it,
-- wherever the spell is named.
-- @param spellID the spell
-- @return whether there was anything to show
function Preview.Spell(spellID)
	local kits = Preview.KitsOf(spellID)
	if #kits == 0 then
		return false
	end
	if not hovered then
		hovered = build(false)
	end
	if not (hovered and hovered.model) then
		return false
	end
	hovered.model:ClearModel()
	hovered.model:SetUnit("player")
	hovered.facing = Preview.FACING
	hovered.model:SetFacing(hovered.facing)
	hovered.kits = kits
	play(hovered)
	Preview.Place(hovered)
	hovered:Show()
	return true
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
	Preview.Place(hovered)
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
	-- Where the hovered one was, but held to the screen rather than to a tooltip
	-- that is about to go away, and offset by however many are already up so the
	-- newest is visibly its own rather than landing on the one before it.
	local step = #pinned * Preview.GAP
	local x, y = cursor()
	frame:ClearAllPoints()
	if x then
		local mine = sides(x, y)
		frame:SetPoint(mine, _G.UIParent, "BOTTOMLEFT", x + step, y - step)
	else
		frame:SetPoint("CENTER", _G.UIParent, "CENTER", step, step)
	end
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

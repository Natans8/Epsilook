--- The sky gallery: several skies at once, at the same moment of the day.
--
-- The third interface over the API, and the first that draws rather than
-- prints. Its whole point is comparison: a grid of cells, one dome each, and
-- ONE clock driving all of them, so moving the hour moves every sky together
-- and the difference between two of them is the only thing that changes.
--
-- A cell is more than the model. A skybox dome is painted art, and the sky a
-- player actually sees is that art over the procedural gradient the preset
-- colours, with the fog laid over both. So a cell is three layers: the
-- gradient behind, drawn from `GetSkyLight` at the shown moment; the dome's
-- model over it, seen from inside as the game draws it; and a fog wash in
-- front. None of it is the client's own sky shader, and it is not pretending
-- to be -- what it reproduces is the sky's COLOUR through the day, which is
-- what a person comparing two skies is looking at.
--
-- It reads the API and nothing under it, and it sends a command only when
-- somebody clicks one.

_G.Epsilook = _G.Epsilook or {}
local Epsilook = _G.Epsilook

local Sky = {}
Epsilook.Sky = Sky

local Shell = Epsilook.Shell

--- How many cells the grid holds, and how they are laid out.
local COLUMNS, ROWS = 3, 2
local PER_PAGE = COLUMNS * ROWS
local CELL_GAP = 10

--- Noon, in the half-minutes the day is counted in.
local NOON = 1440
local DAY = 2880

--- How far the fog wash goes. The client's fog is a depth effect and this is a
-- flat frame, so the wash says the fog's colour and roughly its weight without
-- claiming to be the thing itself.
local FOG_ALPHA = 0.35

--- The scene the camera is built from, and the clips a dome needs.
-- A skybox dome is thousands of units across and the camera sits inside it, so
-- the near clip has to be tiny and the far clip enormous; the numbers are the
-- ones Epsilon's own viewer uses for arbitrary models.
local CAMERA_SCENE = 114
local NEAR_CLIP, FAR_CLIP = 0.01, 2 ^ 64

local frame, cells, slider, clock, search, pager
local shown = {}
local page = 1
local moment = NOON

--- The colour of one field of a SkyLight, as the four channels a texture takes.
local function channels(light, field)
	if not light then
		return 0, 0, 0, 1
	end
	return Epsilook:UnpackColor(light[field])
end

--- Paint one cell's three layers from the light at the shown moment.
local function paint(cell, skyboxID)
	local light = Epsilook:GetSkyLight(skyboxID, moment)
	-- The gradient is the procedural sky's own: its top colour overhead down to
	-- the band it meets the horizon at, which is what changes most through a day.
	local tr, tg, tb = channels(light, "top")
	local br, bg, bb = channels(light, "band1")
	cell.gradient:SetGradientAlpha("VERTICAL", br, bg, bb, 1, tr, tg, tb, 1)
	local fr, fg, fb = channels(light, "fog")
	cell.fog:SetColorTexture(fr, fg, fb, FOG_ALPHA)
end

--- Point a cell's camera at the middle of its dome, from inside it.
-- A dome's faces point inward, because the game draws it from the middle, so
-- a camera outside it sees nothing worth looking at.
local function frameModel(actor)
	local scene = actor.scene
	local camera = scene:GetActiveCamera()
	if not camera then
		return
	end
	camera:SetTarget(0, 0, 0)
	camera:SetMinZoomDistance(0)
	camera:SetMaxZoomDistance(0)
	camera:SetZoomDistance(0)
	camera:SetPitch(0)
	camera:SnapAllInterpolatedValues()
end

--- The model scene of one cell, or nil where this client refuses to make one.
local function makeScene(cell)
	local ok, scene = pcall(_G.CreateFrame, "ModelScene", nil, cell, "ModelSceneMixinTemplate")
	if not ok or not scene then
		return nil
	end
	scene:SetAllPoints(cell.art)
	scene:SetCameraNearClip(NEAR_CLIP)
	scene:SetCameraFarClip(FAR_CLIP)
	local actor = scene:CreateActor(nil, "ModelSceneActorTemplate")
	if not actor then
		return nil
	end
	actor.scene = scene
	actor:SetUseCenterForOrigin(true, true, true)
	actor.onModelLoadedCallback = frameModel
	scene.Camera = scene:CreateCameraFromScene(CAMERA_SCENE)
	scene.actor = actor
	return scene
end

--- Send the command one action would send, for the dome a cell is showing.
local function run(cell, key)
	if not cell.skyboxID then
		return
	end
	local command = Epsilook:GetSkyCommand(key, cell.skyboxID)
	if command then
		Shell.Send(command)
	end
end

--- Build one cell: the three layers, the caption, and the action buttons.
local function makeCell(at)
	local cell = _G.CreateFrame("Frame", nil, frame, "BackdropTemplate")
	cell.art = _G.CreateFrame("Frame", nil, cell)
	cell.art:SetPoint("TOPLEFT")
	cell.art:SetPoint("TOPRIGHT")
	cell.art:SetHeight(1)

	cell.gradient = cell.art:CreateTexture(nil, "BACKGROUND")
	cell.gradient:SetAllPoints(cell.art)
	cell.gradient:SetColorTexture(1, 1, 1, 1)

	cell.scene = makeScene(cell)

	cell.fog = cell.art:CreateTexture(nil, "OVERLAY")
	cell.fog:SetAllPoints(cell.art)

	cell.name = cell:CreateFontString(nil, "OVERLAY", "GameFontNormal")
	cell.name:SetPoint("TOPLEFT", cell.art, "BOTTOMLEFT", 2, -4)
	cell.name:SetJustifyH("LEFT")

	cell.where = cell:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
	cell.where:SetPoint("TOPLEFT", cell.name, "BOTTOMLEFT", 0, -2)
	cell.where:SetJustifyH("LEFT")

	cell.buttons = {}
	local previous
	for _, action in ipairs(Epsilook:GetSkyActions()) do
		local button = _G.CreateFrame("Button", nil, cell, "UIPanelButtonTemplate")
		button:SetSize(78, 20)
		button:SetText(action.label)
		button:SetScript("OnClick", function()
			run(cell, action.key)
		end)
		button:SetScript("OnEnter", function(self)
			_G.GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
			_G.GameTooltip:SetText(action.hint, 1, 1, 1, 1, true)
			_G.GameTooltip:Show()
		end)
		button:SetScript("OnLeave", function()
			_G.GameTooltip:Hide()
		end)
		if previous then
			button:SetPoint("LEFT", previous, "RIGHT", 2, 0)
		else
			button:SetPoint("TOPLEFT", cell.where, "BOTTOMLEFT", 0, -4)
		end
		previous = button
		cell.buttons[#cell.buttons + 1] = button
	end

	cell.index = at
	return cell
end

--- Show one dome in one cell, or empty the cell where there is no dome for it.
local function fill(cell, skyboxID)
	cell.skyboxID = skyboxID
	if not skyboxID then
		cell:Hide()
		return
	end
	local sky = Epsilook:GetSkyDataByID(skyboxID)
	if not sky then
		cell:Hide()
		return
	end
	cell:Show()
	-- The file name is what the game calls it, and the place is what a reader
	-- knows it by, so the name leads and the place is the line under it.
	cell.name:SetText(sky.name:match("([^\\/]+)%.%w+$") or sky.name)
	local where = table.concat(sky.zones, ", ")
	if where == "" then
		where = table.concat(sky.maps, ", ")
	end
	local when = table.concat(sky.conditionWords, ", ")
	if when ~= "" then
		where = where == "" and when or (where .. ", " .. when)
	end
	cell.where:SetText(where)
	if cell.scene and sky.file > 0 then
		cell.scene.actor:SetModelByFileID(sky.file)
	end
	paint(cell, skyboxID)
end

--- The clock as a person reads it.
local function hhmm(at)
	return ("%02d:%02d"):format(math.floor(at / 120), math.floor((at % 120) / 2))
end

--- Draw the page that is showing, at the moment the slider is at.
function Sky.Refresh()
	local first = (page - 1) * PER_PAGE
	for at = 1, PER_PAGE do
		fill(cells[at], shown[first + at])
	end
	local pages = math.max(1, math.ceil(#shown / PER_PAGE))
	pager:SetText(("%d of %d  (%d skies)"):format(math.min(page, pages), pages, #shown))
	clock:SetText(hhmm(moment))
end

--- Show the domes matching a query, from the first page.
function Sky.Search(text)
	shown = Epsilook:FindSkies(text or "")
	page = 1
	Sky.Refresh()
end

--- Move the whole grid to one moment of the day.
function Sky.SetMoment(at)
	moment = math.max(0, math.min(DAY - 1, math.floor(at)))
	for _, cell in ipairs(cells) do
		if cell.skyboxID then
			paint(cell, cell.skyboxID)
		end
	end
	clock:SetText(hhmm(moment))
end

--- Turn to another page of the answer.
function Sky.Turn(by)
	local pages = math.max(1, math.ceil(#shown / PER_PAGE))
	page = math.max(1, math.min(pages, page + by))
	Sky.Refresh()
end

--- Lay the grid out for the frame's current size.
local function layout()
	local width = (frame:GetWidth() - 30 - CELL_GAP * (COLUMNS - 1)) / COLUMNS
	local height = (frame:GetHeight() - 130 - CELL_GAP * (ROWS - 1)) / ROWS
	for at = 1, PER_PAGE do
		local cell = cells[at]
		local column, row = (at - 1) % COLUMNS, math.floor((at - 1) / COLUMNS)
		cell:SetSize(width, height)
		cell:SetPoint(
			"TOPLEFT",
			frame,
			"TOPLEFT",
			15 + column * (width + CELL_GAP),
			-60 - row * (height + CELL_GAP)
		)
		-- The art takes what the caption and the buttons leave.
		cell.art:SetHeight(math.max(1, height - 66))
	end
end

--- Build the frame, once.
local function build()
	frame = _G.CreateFrame("Frame", "EpsilookSkyFrame", _G.UIParent, "BasicFrameTemplateWithInset")
	frame:SetSize(880, 620)
	frame:SetPoint("CENTER")
	frame:SetMovable(true)
	frame:EnableMouse(true)
	frame:RegisterForDrag("LeftButton")
	frame:SetScript("OnDragStart", frame.StartMoving)
	frame:SetScript("OnDragStop", frame.StopMovingOrSizing)
	frame:SetScript("OnSizeChanged", layout)
	frame.TitleText:SetText("Epsilook  Skies")

	search = _G.CreateFrame("EditBox", nil, frame, "InputBoxTemplate")
	search:SetSize(240, 20)
	search:SetPoint("TOPLEFT", frame, "TOPLEFT", 22, -32)
	search:SetAutoFocus(false)
	search:SetScript("OnTextChanged", function(self)
		Sky.Search(self:GetText())
	end)
	search:SetScript("OnEscapePressed", function(self)
		self:ClearFocus()
	end)

	pager = frame:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
	pager:SetPoint("LEFT", search, "RIGHT", 12, 0)

	local back = _G.CreateFrame("Button", nil, frame, "UIPanelButtonTemplate")
	back:SetSize(24, 20)
	back:SetText("<")
	back:SetPoint("TOPRIGHT", frame, "TOPRIGHT", -56, -32)
	back:SetScript("OnClick", function()
		Sky.Turn(-1)
	end)

	local forward = _G.CreateFrame("Button", nil, frame, "UIPanelButtonTemplate")
	forward:SetSize(24, 20)
	forward:SetText(">")
	forward:SetPoint("LEFT", back, "RIGHT", 2, 0)
	forward:SetScript("OnClick", function()
		Sky.Turn(1)
	end)

	cells = {}
	for at = 1, PER_PAGE do
		cells[at] = makeCell(at)
	end

	-- One clock for the whole grid, which is what makes this a comparison
	-- rather than six pictures that happen to be beside each other.
	slider = _G.CreateFrame("Slider", nil, frame, "OptionsSliderTemplate")
	slider:SetPoint("BOTTOMLEFT", frame, "BOTTOMLEFT", 22, 24)
	slider:SetPoint("BOTTOMRIGHT", frame, "BOTTOMRIGHT", -80, 24)
	slider:SetMinMaxValues(0, DAY - 1)
	slider:SetValueStep(30)
	slider:SetObeyStepOnDrag(true)
	slider:SetValue(NOON)
	slider.Low:SetText("00:00")
	slider.High:SetText("24:00")
	slider.Text:SetText("The hour, for every sky at once")
	slider:SetScript("OnValueChanged", function(_, value)
		Sky.SetMoment(value)
	end)

	clock = frame:CreateFontString(nil, "OVERLAY", "GameFontNormalLarge")
	clock:SetPoint("LEFT", slider, "RIGHT", 14, 0)

	layout()
	frame:Hide()
end

--- Open the gallery, on a query where one is given.
-- @param query text to search for, or nil to show every dome
function Sky.Open(query)
	if not Epsilook:IsDataLoaded() and not Epsilook:LoadData() then
		return false
	end
	if not frame then
		build()
	end
	frame:Show()
	search:SetText(query or "")
	Sky.Search(query)
	return true
end

--- Close the gallery.
function Sky.Close()
	if frame then
		frame:Hide()
	end
end

--- Whether the gallery is open.
function Sky.IsOpen()
	return frame ~= nil and frame:IsShown()
end

return Sky

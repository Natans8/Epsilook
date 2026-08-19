# Epsilook API

Epsilook is a search engine over Epsilon's spell data, running inside the client. This document is the reference for
the Lua surface other addons and macros can call. The surface returns data and performs nothing: a chat shell ships on
top of it (`/elo`), and anything else can be built beside that shell on the same calls.

One global, `Epsilook`, carries everything. The data ships as a second, load-on-demand addon, `Epsilook_Data`; every
call below loads it on first use, so a macro can ask a question with no step before it.

- Supported surface: the `Epsilook:` methods in this document and the `Epsilook.ACTIONS` table.
- Raw surface, stable in shape but not in contract: `Epsilook.data`, `Epsilook.index`, `Epsilook.schema` and the
  layers beneath (`Epsilook.Reader`, `Epsilook.Data`). They are there to be read, dumped and explored.
- `Epsilook.API_VERSION` is raised when a field changes meaning or leaves, never when one is added. Test it once.

## Conventions

Naming follows the client's own library: `GetNum*` for a count, `Get*DataBy*(key, target)` for a record with an
optional table to fill, `Get*By*` for one field, `Find*` for a search returning an iterator, `Is*` for a predicate.

A `target` parameter, where present, is an optional table the call fills and returns instead of allocating one; pass
the same table across a loop to allocate nothing.

Rows are counted from zero where they index the build (`GetSpellIndexByID`, `FindSpells`), and from one where they
count a spell's own parts (`GetPartDataByIndex`). Every id is the game's own.

## Records

| record      | fields                                                                                              |
|-------------|-----------------------------------------------------------------------------------------------------|
| `SpellData` | `id`, `name`, `subtext`, `icon` (file id), `iconName`, `schoolID`, `school`, `expansion`            |
| `SpellText` | `description`, `aura`, `encounter` (each `""` where the spell has none)                             |
| `PartData`  | `axis`, `kind`, `slot`, `values` (property name to value)                                           |
| `Action`    | `key`, `label`, `needs`, `kind`, `except`, `effect`, `revert`, `hint`                                |
| `DataInfo`  | `pack`, `built`, `format`, `variation`, `supplied`, `absent`, `homes`                               |
| `Problem`   | `severity`, `message`, `at`, `length` (positions index the query text, counted from one)            |

A `PartData.values` entry is one of three shapes, decided by the property's declared type: a property whose value
resolved from an id to a name is a table `{ id, text }`; a property whose number names a vocabulary entry is that
entry's text; any other is the stored number. `FormatPartValue` writes any of them as text.

## Loading

| call                           | returns                                        | notes                                         |
|--------------------------------|------------------------------------------------|-----------------------------------------------|
| `Epsilook:IsDataLoaded()`      | `true` or `false`                              |                                               |
| `Epsilook:LoadData()`          | `true`, or `false, reason`                     | explicit door; every other call does the same |
| `Epsilook:GetDataInfo(target)` | `DataInfo`, or `nil`                           | which pack, when built, which format          |

`DataInfo.pack` is the build the data describes, `9.2.7-epsilon.45745` for the shipped pack. `homes` lists where each
column is mounted from, in order; today the shipped data only.

## Spells

| call                                       | returns                                        |
|--------------------------------------------|------------------------------------------------|
| `Epsilook:GetNumSpells()`                  | how many spells the build carries              |
| `Epsilook:GetSpellIndexByID(spellID)`      | the spell's row, or `nil`                      |
| `Epsilook:GetSpellNameByID(spellID)`       | the name, or `nil`                             |
| `Epsilook:GetSpellDataByID(spellID, target)` | `SpellData`, or `nil`                        |
| `Epsilook:GetSpellDataByIndex(index, target)` | `SpellData`, or `nil`                       |
| `Epsilook:GetSpellTextByID(spellID, target)` | `SpellText`, or `nil`                        |

Names and icons are the pack's. A surface that wants what the running client says calls `GetSpellInfo(id, nil, true)`
itself; the third argument asks the client for its original data rather than a name an addon laid over it.

## Parts

A spell is made of parts on axes: `model`, `sound`, `anim`, `fx`, `mech`. Each part has a kind (`missile`, `sound`,
`kit`, `chain`, `effect`, ...) and the properties the kind declares. The declarations are the schema the data
carries; nothing here hard-codes a kind.

| call                                               | returns                                                  |
|----------------------------------------------------|----------------------------------------------------------|
| `Epsilook:GetAxes()`                               | every axis file, in shipping order                       |
| `Epsilook:GetPartAxes()`                           | the axes a spell can be inspected on, in dossier order   |
| `Epsilook:GetPartCounts(spellID, target)`          | axis name to count, or `nil`                             |
| `Epsilook:GetNumParts(spellID, axis)`              | a count, zero where the spell has none                   |
| `Epsilook:HasPartOfKind(spellID, axis, kindWord)`  | `true` or `false`                                        |
| `Epsilook:GetPartDataByIndex(spellID, axis, n, target)` | `PartData` for the n'th part, or `nil`              |
| `Epsilook:FormatPartValue(axis, kindWord, propName, value)` | the value as text, the way a pill prints it     |
| `Epsilook:GetPartExtras(part)`                     | list of `{ name, value, text }` the part carries beyond its declared properties |
| `Epsilook:GetSpawnIDByFile(fid)`                   | what `.gob spawn` takes for a model's file id, or `nil`  |
| `Epsilook:GetEmotesByAnim(animID)`                 | the one-shot emote id and the looping emote id, each `0` where none exists |

`GetPartExtras` names what the pack carries beside a part's properties and no query reads: for an `effect`, the two
implicit targets it resolves (`targetA`, `targetB`) and the aura it applies (`aura`), each a number with its name.

`GetSpawnIDByFile` is signed: a positive number is a gameobject template, a negative one a gameobject display, and
`.gob spawn` reads the sign.

## Actions

`Epsilook:GetActions(axis)` returns the `Action` list an interface may offer for a part of that axis, in the order to
offer them; `Epsilook.ACTIONS` is the table behind it. Nothing here performs an action: a record carries the ids an
action needs and the list says which actions an axis affords, and doing one is the caller's business.

| field    | meaning                                                                                   |
|----------|-------------------------------------------------------------------------------------------|
| `key`    | the action's identity: `spawn`, `add`, `lookup`, `morph`, `play`, `stop`, `playKit`, `stopKit`, `summon`, `anim`, `stand` |
| `label`  | the word a surface shows                                                                  |
| `needs`  | the `PartData.values` name the action takes; `""` for an action needing nothing           |
| `kind`   | the one kind of part that takes it, where set                                             |
| `except` | the one kind of part that does not take it, where set                                     |
| `effect` | `read` where repeating it is harmless, `world` where it changes something outside the client |
| `revert` | the key of the action that undoes it, or `""`                                             |
| `hint`   | what a tooltip says a click will do                                                       |

## Queries

The query language is the web app's, read from the same declarations; `/elo help` prints it from the data. Plain
terms, `head:value`, `-` to exclude, `|` or `or` between clauses, a quoted phrase, a comparison, a range, a comma
list, `*` for existence, a row scope `head:{...}` whose terms one row must satisfy together, and the ordering
directive `sort:<head>` (`-sort:<head>` for the other way), several applied in the order written. Alternatives in
parentheses and regular expressions are refused with a message.

A sort orders the whole answer, so under one the iterator walks every spell before it yields its first hit, keeps the
order on the parsed query for later pages, and the index it hands back is a position in that order rather than a
row. A spell's key on a door is its extreme in the sort's direction over the rows it has there (smallest ascending,
largest descending); a column door keys by how many rows the spell has, a spell-level column by its first kind's
subject (`sort:id`, `sort:spell` by name); a spell with no value sorts last either way.

| call                                          | returns                                                                     |
|-----------------------------------------------|-----------------------------------------------------------------------------|
| `Epsilook:ParseQuery(text)`                   | the query (opaque) and a list of `Problem`; what parsed evaluates            |
| `Epsilook:FormatQuery(query)`                 | the query written back as text                                              |
| `Epsilook:IsQueryEmpty(query)`                | `true` where no clause evaluates                                            |
| `Epsilook:GetQueryHelp()`                     | `{ columns, heads, operators }`, each with hints, read off the declarations |
| `Epsilook:FindSpells(query, fromIndex, slice)` | an iterator; see below                                                     |
| `Epsilook:GetNumMatches(query)`               | how many spells satisfy the query; a full walk                              |
| `Epsilook:IsMatch(query, spellID)`            | `true` or `false`                                                           |

`query` is text or a parsed query; a parsed query is cheaper to page with. `FindSpells` returns an iterator yielding
`row, spellID, resume` for each hit in build order (or the sort's order), then `nil`; `resume` is what to pass as
`fromIndex` to continue after that hit. With `slice` set, the iterator also yields `false` after examining that many
spells without a hit, so a caller driving it from a frame's `OnUpdate` can yield between slices and never freeze the
client; call it again to resume. The engine also pauses inside its heavy scans through `Epsilook.Search.Pauser`, a
function a driver may set (the shell sets a yield taken only inside a coroutine); nil, the default, runs straight
through.

```lua
local query, problems = Epsilook:ParseQuery("model:{fire missile} -anim:kit -sort:cast")
local step = Epsilook:FindSpells(query, nil, 500)
while true do
    local row, id, resume = step()
    if row == nil then break end
    if row ~= false then print(id, Epsilook:GetSpellNameByID(id)) end
end
```

## Chat links

The shell's own links are `|Hgarrmission:epsilook:<spellID>:<verb>[:<axis>:<n>]|h[...]|h`. They ride the
`garrmission` prefix because the client hands every other unknown link type to the item tooltip, where it fails before
any hook runs. A click executes the verb through a `SetItemRef` hook; a shift-click hands the chat box what the link
stands for. Another addon may print these links and they will behave the same.

## Raw data

`Epsilook.data.<axis>` holds each axis file's payload as the emitter wrote it: a header describing columns and one
long string per axis holding every value, numbers as fixed-stride base-64 groups and text verbatim. `Epsilook.Reader`
reads a column by row from the header and the string; `Epsilook.Data` mounts the columns and answers the layer above
(`GetColumn`, `ReadAll`, `GetRowTable`, `GetStored`, `GetCarried`, `Lookup`). `Epsilook.schema` is the web engine's
declarations as exported: columns, kinds and properties, value types and their notations, operators, target roles
and words, colour names, and the grammar's own characters and words. `Epsilook.index` is the data addon's manifest:
pack, build date, format, and which columns the client could supply.

These are not the supported surface; their shape follows the pack format (`X-Epsilook-Format` in the data addon's
toc) and may move with it. The supported surface above is written against them and does not.

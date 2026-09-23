"""The route reference: every field the build derives and every section it ships.

Written from the registries rather than beside them, so it cannot describe a
route that is not there. The build is a graph: a table feeds the fields that
read it, a field feeds the fields that need it, and a field feeds the sections
that map from it. The document draws that graph in chapters small enough to
read, then lists every field and every table once.

A chapter is either a family, the sections one section module registers, or a
group of shared fields. A field reaching the sections of only a family or two
is drawn in the family that reads it most; a field reaching many families is
the build's trunk, and is drawn with the shared field it feeds. Every field is
drawn in full exactly once, and anywhere else it appears as a stub.

Every sentence in the document is a declaration's own: a flow's description,
the attribute docstring under the line that binds a route, a computation's
docstring, a section's ``doc``, a section module's docstring. The document
adds nothing but how to read it, so a note written for the next reader of the
code is the note the reference shows, and it moves with the code it describes.
"""

from __future__ import annotations

import ast
import inspect
import re
import textwrap
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from fractions import Fraction
from types import ModuleType
from typing import Any, NamedTuple

from ..model.section import Count, Section
from ..routes import catalogue
from ..routes.flow import (
    Alternatives,
    Composed,
    Expand,
    Flow,
    Join,
    Lookup,
    Narrow,
    Plan,
    Read,
    Runnable,
    Split,
    Then,
)
from ..routes.route import Route

WIDTH = 120
"""The column prose is wrapped at, the repository's markdown width."""

ALWAYS_GIVEN = frozenset({"tables", "version"})
"""Inputs every route is handed, which say nothing about any one of them."""

SHARED_AT = 3
"""How many families' sections a field must reach to count as shared.

The build divides sharply here: a field reaches the sections of one or two
families, or of five and more, so the threshold moves nothing it does not
have to.
"""

SOURCES = {"client": "the client's", "pinned": "a pinned build's", "server": "the server dump's"}
"""A table's source as the tables list says it."""

OTHER = "other shared fields"
"""The chapter for a shared field that feeds no other shared field alone."""

# Any: the registry holds a runnable of whatever each field is, and nothing
# here reads the value, only the declaration.
Held = Runnable[Any]


class Node(NamedTuple):
    """One vertex of the build's graph: a table, a field or a section."""

    kind: str
    """``table``, ``field`` or ``section``; a field and a section may share a name."""

    name: str


@dataclass(frozen=True)
class Field:
    """One field of the derive context, as its declaration states it."""

    name: str
    what: str
    """The declaration's own description of what the field is."""

    note: str
    """The docstring under the declaration, or the computation's docstring
    past its first sentence; empty where there is none."""

    computed: bool
    """Whether a decorated function fills the field, rather than a flow."""

    lands_as: str
    """The shape the field lands in, by its terminal's or its function's name."""

    tables: tuple[str, ...]
    """The tables the field's flows read, the origin first."""

    unrevised: tuple[str, ...]
    """The tables among ``tables`` read without the hotfix revision."""

    needs: tuple[str, ...]
    """The paths of the other fields it reads, attribute included."""

    given: tuple[str, ...]
    """The inputs the wiring hands it that are not fields."""

    landings: tuple[str, ...]
    """For a split, the attributes of the record it lands, one per branch."""

    declared_in: str
    """The module the declaration is in, relative to the package."""


@dataclass(frozen=True)
class Shipped:
    """One pack section, as its record states it."""

    name: str
    what: str
    family: str
    """The section module that registers it."""

    module: str
    """The artifact module it lands in."""

    reads: tuple[str, ...]
    """The field paths it maps from."""

    localized: bool
    """Whether it is produced again per language."""

    needs: tuple[str, ...]
    """The tables without which a build ships it absent."""

    thins: tuple[str, ...]
    """The tables without which a build ships it thinner."""

    counts: tuple[str, ...]
    """The keys it contributes to the manifest's counts."""


@dataclass(frozen=True)
class Chapter:
    """One diagram and what it draws: a family's sections, or a group of shared fields."""

    heading: str
    """The chapter's heading, which is also what a field's home names."""

    title: str
    """The first sentence the chapter opens with."""

    intro: str
    """What follows it, before the diagram."""

    sections: tuple[str, ...]
    """For a family, its sections in registration order."""

    fields: tuple[str, ...]
    """For a group, the shared fields it draws from, those nothing in it reads."""


@dataclass(frozen=True)
class Reference:
    """The whole graph, every node described, with the numbers of one pack."""

    fields: Mapping[str, Field]
    sections: Mapping[str, Shipped]
    families: tuple[Chapter, ...]
    groups: tuple[Chapter, ...]
    sources: Mapping[str, str]
    """Every table a field reads, to where it comes from."""

    homes: Mapping[str, str]
    """Each field's chapter, by heading: where it is drawn in full rather than
    as a stub. Absent for a field no section reaches."""

    counts: Mapping[str, int]
    """The manifest counts of the pack whose numbers are shown."""

    pack: str
    """The pack the counts are from."""

    def edges(self) -> list[tuple[Node, Node]]:
        """Every edge, from what is read to what reads it."""
        return edges_of(self.fields, self.sections)

    def nodes_named(self, name: str) -> list[Node]:
        """Every node carrying a name, since a field and a section may share one."""
        kinds = (("table", self.sources), ("field", self.fields), ("section", self.sections))
        return [Node(kind, name) for kind, held in kinds if name in held]

    def upstream(self, start: Node) -> list[Node]:
        """Everything a node is built from, nearest first."""
        into: dict[Node, list[Node]] = {}
        for source, target in self.edges():
            into.setdefault(target, []).append(source)
        return walked(start, into)

    def downstream(self, start: Node) -> list[Node]:
        """Everything built from a node, nearest first."""
        out: dict[Node, list[Node]] = {}
        for source, target in self.edges():
            out.setdefault(source, []).append(target)
        return walked(start, out)


def edges_of(fields: Mapping[str, Field], sections: Mapping[str, Shipped]) -> list[tuple[Node, Node]]:
    """Every edge of the graph, from what is read to what reads it."""
    found: list[tuple[Node, Node]] = []
    for field in fields.values():
        target = Node("field", field.name)
        found += [(Node("table", table), target) for table in field.tables]
        found += [(Node("field", head), target) for head in heads(field.needs) if head in fields]
    for section in sections.values():
        target = Node("section", section.name)
        found += [(Node("field", head), target) for head in heads(section.reads) if head in fields]
    return found


def walked(start: Node, adjacent: Mapping[Node, Sequence[Node]]) -> list[Node]:
    """The nodes reachable from one, breadth first, each once."""
    seen = {start}
    order: list[Node] = []
    frontier = [start]
    while frontier:
        following: list[Node] = []
        for node in frontier:
            for reached in sorted(adjacent.get(node, ())):
                if reached not in seen:
                    seen.add(reached)
                    order.append(reached)
                    following.append(reached)
        frontier = following
    return order


def heads(paths: Iterable[str]) -> list[str]:
    """The fields a set of paths names, attributes dropped, in first-seen order."""
    return list(dict.fromkeys(path.partition(".")[0] for path in paths))


# Reading the declarations.


def flows_of(held: Held) -> list[Flow]:
    """Every flow under a runnable, in declaration order: a split's trunk, an
    alternative's each plan, a reshaped plan's own."""
    if isinstance(held, Plan):
        return [held.flow]
    if isinstance(held, Then):
        return flows_of(held.plan)
    if isinstance(held, Alternatives):
        return [flow for alternative in held.plans for flow in flows_of(alternative)]
    if isinstance(held, Split):
        return [held.trunk]
    return []


def tables_of(held: Held) -> tuple[list[str], list[str]]:
    """The tables a runnable reads, the origin first, and those among them read
    without the hotfix revision."""
    named: list[str] = []
    unrevised: list[str] = []
    for flow in flows_of(held):
        for step in flow.steps:
            if isinstance(step, (Read, Join, Expand)):
                named.append(step.table)
                if not step.revised:
                    unrevised.append(step.table)
    return list(dict.fromkeys(named)), list(dict.fromkeys(unrevised))


def needs_of(held: Held) -> set[str]:
    """Every path a runnable reads, including the rosters its steps narrow by."""
    named = set(held.needs)
    for flow in flows_of(held):
        for step in flow.steps:
            if isinstance(step, Narrow) and isinstance(step.roster, str):
                named.add(step.roster)
            elif isinstance(step, Lookup) and isinstance(step.field, str):
                named.add(step.field)
    return named


def described(held: Held) -> str:
    """What the declaration says it is, in its own words."""
    if isinstance(held, Composed):
        return f"composed of {listed(sorted(set(held.sources.values())))}"
    flows = flows_of(held)
    if isinstance(held, Alternatives):
        return " or ".join(dict.fromkeys(flow.name for flow in flows))
    return flows[0].name if flows else ""


def shape_of(held: Held) -> str:
    """The shape a runnable lands in, by its terminal's name."""
    if isinstance(held, Composed):
        return name_of(held.build, "record")
    if isinstance(held, Split):
        return name_of(held.record, "record")
    if isinstance(held, Then):
        return f"{shape_of(held.plan)}, then {name_of(held.assemble, 'reshaped')}"
    if isinstance(held, Alternatives):
        return shape_of(held.plans[0])
    if isinstance(held, Plan):
        return type(held.terminal).__name__.removeprefix("As").lower()
    return "value"


def name_of(value: object, fallback: str) -> str:
    """A callable's name, for the shape it builds."""
    return str(getattr(value, "__name__", fallback))


def return_name(function: Callable[..., object]) -> str:
    """The name of what a function is annotated to return."""
    annotation = inspect.signature(function).return_annotation
    if annotation is inspect.Signature.empty:
        return "value"
    return annotation if isinstance(annotation, str) else name_of(annotation, str(annotation))


def attribute_notes(module: ModuleType, owner: str = "") -> dict[str, str]:
    """The attribute docstrings of a module's top level, or of one class body.

    A docstring documents the run of assignments written directly above it,
    with no blank line between them: two declarations sharing one sentence are
    written as a pair and documented once.
    """
    tree = ast.parse(inspect.getsource(module))
    body: list[ast.stmt] = tree.body
    if owner:
        found = next((node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == owner), None)
        if found is None:
            raise ValueError(f"{module.__name__} has no class {owner}")
        body = found.body
    notes: dict[str, str] = {}
    run: list[ast.stmt] = []
    for statement in body:
        if isinstance(statement, ast.Expr) and isinstance(statement.value, ast.Constant):
            text = statement.value.value
            if isinstance(text, str):
                for target in (name for assignment in run for name in assigned(assignment)):
                    notes[target] = inspect.cleandoc(text)
            run = []
        elif isinstance(statement, (ast.Assign, ast.AnnAssign)):
            follows = run and (run[-1].end_lineno or run[-1].lineno) + 1 == statement.lineno
            run = [*run, statement] if follows else [statement]
        else:
            run = []
    return notes


def assigned(statement: ast.stmt) -> list[str]:
    """The plain names an assignment binds."""
    targets: list[ast.expr]
    if isinstance(statement, ast.AnnAssign):
        targets = [statement.target]
    elif isinstance(statement, ast.Assign):
        targets = statement.targets
    else:
        return []
    return [target.id for target in targets if isinstance(target, ast.Name)]


API_SECTION = re.compile(r"^\s*(Args|Returns|Raises|Yields):\s*$", re.MULTILINE)
"""Where a docstring's reference for callers begins, which is not a note for readers."""


def split_doc(doc: str) -> tuple[str, str]:
    """A docstring's first sentence, and the rest of it up to any section
    documenting its arguments."""
    text = API_SECTION.split(inspect.cleandoc(doc), maxsplit=1)[0].strip()
    match = re.match(r"(.+?\.)(\s|$)", text, re.DOTALL)
    if match is None:
        return " ".join(text.split()), ""
    return " ".join(match.group(1).split()), text[match.end() :].strip()


# The graph.


def reference(
    routes: Sequence[Route],
    plans: Mapping[str, Held],
    notes: Mapping[str, str],
    sections: Sequence[Section],
    families: Mapping[str, ModuleType],
    counts: Mapping[str, int],
    pack: str,
) -> Reference:
    """The graph and its descriptions, from the registries.

    Args:
        routes: every registered route, flows and computations alike.
        plans: the flows by field, as the declaration class holds them.
        notes: the attribute docstrings of those flows, by field.
        sections: every registered section.
        families: every section module by its name, in the order to show them.
        counts: the manifest counts of the pack whose numbers are shown.
        pack: that pack's identity.
    """
    fields = {
        route.field: field_of(route, plans.get(route.field), notes, {r.field for r in routes}) for route in routes
    }
    chapters: list[Chapter] = []
    family_of: dict[str, str] = {}
    registered = {section.name: at for at, section in enumerate(sections)}
    for family, module in families.items():
        names = sorted(
            (value.name for value in vars(module).values() if isinstance(value, Section)), key=registered.__getitem__
        )
        heading = f"{family} family"
        family_of.update((name, heading) for name in names)
        title, intro = split_doc(module.__doc__ or family)
        chapters.append(Chapter(heading, title, intro, tuple(names), ()))
    shipped = {
        section.name: Shipped(
            name=section.name,
            what=section.doc,
            family=family_of.get(section.name, ""),
            module=section.module,
            reads=section.reads,
            localized=bool(section.localizable),
            needs=section.needs,
            thins=section.degraded_without,
            counts=tuple(count.key for count in section.counts if isinstance(count, Count)),
        )
        for section in sections
    }
    sources = {
        table: str(getattr(getattr(catalogue, table, None), "__source__", "client"))
        for field in fields.values()
        for table in field.tables
    }
    homes, groups = homed(fields, shipped, [chapter.heading for chapter in chapters])
    return Reference(fields, shipped, tuple(chapters), groups, dict(sorted(sources.items())), homes, counts, pack)


def field_of(route: Route, held: Held | None, notes: Mapping[str, str], known: set[str]) -> Field:
    """One field as its declaration states it: a flow's plan where it has one,
    the decorated function otherwise."""
    paths = needs_of(held) if held is not None else set(route.needs.values())
    needs = tuple(sorted(path for path in paths if path.partition(".")[0] in known))
    given = tuple(sorted(path for path in paths - ALWAYS_GIVEN if path.partition(".")[0] not in known))
    if held is None:
        what, note = split_doc(route.produce.__doc__ or "")
        module = route.produce.__module__.removeprefix("pack.").replace(".", "/")
        return Field(
            route.field, what, note, True, return_name(route.produce), (), (), needs, given, (), f"{module}.py"
        )
    tables, unrevised = tables_of(held)
    landings = tuple(held.branches) if isinstance(held, Split) else ()
    return Field(
        route.field,
        described(held),
        notes.get(route.field, ""),
        False,
        shape_of(held),
        tuple(tables),
        tuple(unrevised),
        needs,
        given,
        landings,
        "routes/flows.py",
    )


def homed(
    fields: Mapping[str, Field], sections: Mapping[str, Shipped], families: Sequence[str]
) -> tuple[dict[str, str], tuple[Chapter, ...]]:
    """Each field's chapter, and the groups the shared fields make.

    A field reaching the sections of fewer than `SHARED_AT` families lives in
    the family whose readers claim it most. A reader's claim is one over the
    number of fields it reads, so a section made from this field alone
    outweighs one gathering a dozen; a reader field claims for its own home,
    and a tie goes to the family listed first. A shared field lives with
    the shared field it feeds, where it feeds exactly one and nothing else; a
    shared field feeding several is a group of its own, and one that is a group
    of nothing but itself joins the others like it.
    """
    readers: dict[str, list[Node]] = {}
    for source, target in edges_of(fields, sections):
        if source.kind == "field":
            readers.setdefault(source.name, []).append(target)
    reach: dict[str, set[str]] = {}

    def families_reached(name: str) -> set[str]:
        if name not in reach:
            reach[name] = set()
            for reader in readers.get(name, ()):
                if reader.kind == "section":
                    reach[name].add(sections[reader.name].family)
                else:
                    reach[name] |= families_reached(reader.name)
        return reach[name]

    shared = {name for name in fields if len(families_reached(name)) >= SHARED_AT}
    order = {heading: at for at, heading in enumerate(families)}
    homes: dict[str, str] = {}

    def home(name: str) -> str:
        if name not in homes:
            votes: dict[str, Fraction] = {}
            for reader in readers.get(name, ()):
                if reader.kind == "section":
                    family, reads = sections[reader.name].family, sections[reader.name].reads
                else:
                    family, reads = home(reader.name), fields[reader.name].needs
                if family:
                    votes[family] = votes.get(family, Fraction(0)) + Fraction(1, len(heads(reads)))
            homes[name] = min(votes, key=lambda family: (-votes[family], order[family])) if votes else ""
        return homes[name]

    def root(name: str) -> str:
        single = readers.get(name, [])
        if len(single) == 1 and single[0].kind == "field" and single[0].name in shared:
            return root(single[0].name)
        return name

    grouped: dict[str, list[str]] = {}
    for name in sorted(shared):
        grouped.setdefault(root(name), []).append(name)
    groups = [Chapter(f"{name} group", fields[name].what, "", (), (name,)) for name in sorted(grouped)]
    groups = [chapter for chapter in groups if len(grouped[chapter.fields[0]]) > 1]
    alone = tuple(name for name in sorted(grouped) if len(grouped[name]) == 1)
    if alone:
        groups.append(Chapter(OTHER, "Shared fields that feed no other shared field on their own.", "", (), alone))
    placed: dict[str, str] = {}
    for chapter in groups:
        for start in chapter.fields:
            placed.update((member, chapter.heading) for member in grouped[start])
    for name in fields:
        if name not in shared and home(name):
            placed[name] = home(name)
    return placed, tuple(groups)


# The document.


OPENING = """\
```mermaid
---
config:
  layout: elk
---
flowchart LR"""
"""How every diagram opens: laid out by ELK where the renderer has it.

ELK routes edges at right angles and keeps each layer in its own column, which
is what makes a graph of fifty nodes readable. A renderer without it draws the
same diagram in its default layout, so the source never has to choose.
"""

LEGEND = f"""\
{OPENING}
    t_client[(a client table)] --> f_flow[a field a flow reads]
    t_server[(a server dump table)] --> f_computed[[a field a function computes]]
    f_elsewhere[a field drawn in full in another chapter] --> f_computed
    f_flow --> s_section([a pack section])
    f_computed --> s_section
{{classes}}
    class t_client table
    class t_server server
    class f_flow,f_computed field
    class f_elsewhere elsewhere
    class s_section section
```"""
"""The diagrams' key, drawn as a diagram so it reads in the same renderer."""

CLASSES = """\
    classDef table fill:#d5518118,stroke:#d55181,stroke-width:2px
    classDef server fill:#d5518118,stroke:#d55181,stroke-width:2px,stroke-dasharray:5 3
    classDef field fill:#2a78d618,stroke:#2a78d6,stroke-width:2px
    classDef elsewhere fill:none,stroke:#898781,stroke-width:1px,stroke-dasharray:3 3
    classDef section fill:#c9850018,stroke:#c98500,stroke-width:2px"""
"""The measured hues, by stroke so a dark page keeps its own surface: a source
table in the colour of what is somebody else's, a field in the build's own, a
section in the artifact's, and a stub in the grey that de-emphasises."""


def mermaid_id(node: Node) -> str:
    """A node's id in a diagram: its name, prefixed by its kind so a field and a
    section of one name stay two nodes."""
    return f"{node.kind[0]}_{node.name}"


def drawn(ref: Reference, chapter: Chapter) -> str:
    """One chapter's diagram: its sections, the fields they read, and upstream
    of those every field this chapter is home to. A field at home elsewhere is
    a stub, drawn without what it reads."""
    edges: list[tuple[Node, Node]] = []
    expanded: list[str] = []

    def expand(name: str) -> None:
        if name in expanded:
            return
        expanded.append(name)
        field = ref.fields[name]
        edges.extend((Node("table", table), Node("field", name)) for table in field.tables)
        read_into(Node("field", name), field.needs)

    def read_into(target: Node, paths: Iterable[str]) -> None:
        for head in heads(paths):
            if head in ref.fields:
                edges.append((Node("field", head), target))
                if ref.homes.get(head) == chapter.heading:
                    expand(head)

    for name in chapter.sections:
        read_into(Node("section", name), ref.sections[name].reads)
    for name in chapter.fields:
        expand(name)
    own = [Node("field", name) for name in expanded]
    edges = list(dict.fromkeys(edges))
    sections = [Node("section", name) for name in chapter.sections]
    nodes = list(dict.fromkeys([*sections, *own, *(node for edge in edges for node in edge)]))
    lines = [OPENING]
    lines += [f"    {mermaid_id(node)}{shaped(ref, node, own)}" for node in nodes]
    lines += [f"    {mermaid_id(source)} --> {mermaid_id(target)}" for source, target in edges]
    lines.append(CLASSES)
    classes: dict[str, list[str]] = {}
    for node in nodes:
        classes.setdefault(class_of(ref, node, own), []).append(mermaid_id(node))
    lines += [f"    class {','.join(members)} {name}" for name, members in classes.items()]
    lines.append("```")
    return "\n".join(lines)


def shaped(ref: Reference, node: Node, own: Sequence[Node]) -> str:
    """A node's label in the shape its kind is drawn in."""
    if node.kind == "table":
        return f"[({node.name})]"
    if node.kind == "section":
        return f"([{node.name}])"
    if node in own and ref.fields[node.name].computed:
        return f"[[{node.name}]]"
    return f"[{node.name}]"


def class_of(ref: Reference, node: Node, own: Sequence[Node]) -> str:
    """The class a node is coloured by."""
    if node.kind == "table":
        return "server" if ref.sources.get(node.name) == "server" else "table"
    if node.kind == "section":
        return "section"
    return "field" if node in own else "elsewhere"


def slug(heading: str) -> str:
    """The anchor a heading gets, the way the repository host and the IDE derive one."""
    return re.sub(r"[^\w\- ]", "", heading.lower()).replace(" ", "-")


def code(name: str) -> str:
    """A name as inline code."""
    return f"`{name}`"


def linked(name: str) -> str:
    """A field path as a link to the field's entry."""
    return f"[`{name}`](#{slug(name.partition('.')[0])})"


def chapter_link(heading: str) -> str:
    """A link to a chapter by its heading."""
    return f"[{heading}](#{slug(heading)})"


def listed(names: Iterable[str], render: Callable[[str], str] = code) -> str:
    """Names as an English list."""
    shown = [render(name) for name in names]
    if len(shown) < 3:
        return " and ".join(shown)
    return ", ".join(shown[:-1]) + ", and " + shown[-1]


def prose(text: str) -> str:
    """A docstring as markdown: reST literals as code spans, and each paragraph
    re-flowed to the document's width, a bulleted run kept as a list."""
    text = re.sub(r"``(.+?)``", r"`\1`", text).replace(" -- ", " \N{EM DASH} ")
    out: list[str] = []
    for chunk in re.split(r"\n\s*\n", text.strip()):
        lines = [line.strip() for line in chunk.splitlines() if line.strip()]
        if not lines:
            continue
        if lines[0].startswith("- "):
            items: list[str] = []
            for line in lines:
                if line.startswith("- ") or not items:
                    items.append(line.removeprefix("- "))
                else:
                    items[-1] += " " + line
            out.append("\n".join(filled(item, "- ", "  ") for item in items))
        else:
            out.append(filled(" ".join(lines)))
    return "\n\n".join(out)


def filled(text: str, first: str = "", rest: str = "") -> str:
    """One paragraph wrapped at the document's width, never inside a word."""
    return textwrap.fill(
        text, WIDTH, initial_indent=first, subsequent_indent=rest, break_long_words=False, break_on_hyphens=False
    )


def table(header: Sequence[str], rows: Sequence[Sequence[str]], right: Iterable[int] = ()) -> str:
    """A markdown table padded the way the repository's formatter lays one out."""
    aligned = set(right)
    widths = [max(3, *(len(row[at]) for row in (header, *rows))) for at in range(len(header))]

    def line(row: Sequence[str]) -> str:
        cells = [
            cell.rjust(width) if at in aligned else cell.ljust(width)
            for at, (cell, width) in enumerate(zip(row, widths))
        ]
        return "| " + " | ".join(cells) + " |"

    rules = ["-" * (width + 1) + ":" if at in aligned else "-" * (width + 2) for at, width in enumerate(widths)]
    return "\n".join([line(header), "|" + "|".join(rules) + "|", *(line(row) for row in rows)])


def counted(ref: Reference, section: Shipped) -> str:
    """The section's own count on the pack shown, or its first declared count by key."""
    if section.name in ref.counts:
        return f"{ref.counts[section.name]:,}"
    for key in section.counts:
        if key in ref.counts:
            return f"{ref.counts[key]:,} {key}"
    return ""


def family_chapter(ref: Reference, chapter: Chapter) -> str:
    """One family: what its module says, its diagram, and its sections."""
    rows = []
    for name in chapter.sections:
        section = ref.sections[name]
        where = section.module + (", per language" if section.localized else "")
        reads = listed(section.reads, linked) or "nothing derived"
        rows.append((code(name), where, counted(ref, section), reads, section.what))
    parts = [f"### {chapter.heading}", prose(chapter.title)]
    if chapter.intro:
        parts.append(prose(chapter.intro))
    parts.append(drawn(ref, chapter))
    parts.append(table(("section", "module", "on the pack", "reads", "what it is"), rows, right=(2,)))
    conditions = []
    for name in chapter.sections:
        section = ref.sections[name]
        if section.needs:
            conditions.append(
                filled(f"{code(name)} ships absent from a build without {listed(section.needs)}.", "- ", "  ")
            )
        if section.thins:
            conditions.append(
                filled(f"{code(name)} ships thinner from a build without {listed(section.thins)}.", "- ", "  ")
            )
    if conditions:
        parts.append("\n".join(conditions))
    return "\n\n".join(parts)


def group_chapter(ref: Reference, chapter: Chapter) -> str:
    """One group of shared fields: what it lands, its diagram, and its members."""
    members = sorted(name for name, home in ref.homes.items() if home == chapter.heading)
    title = sentence(chapter.title)
    if chapter.heading != OTHER:
        title = f"{code(chapter.fields[0])}: {title}"
    parts = [f"### {chapter.heading}", prose(title), drawn(ref, chapter)]
    parts.append(prose(f"Drawn here: {listed(members, linked)}."))
    return "\n\n".join(parts)


def entry(ref: Reference, field: Field) -> str:
    """One field's entry: what it is, where it is declared, its edges and its note."""
    kind = "A function" if field.computed else "A flow"
    facts = [f"{kind} in `{field.declared_in}`, landing as `{field.lands_as}`."]
    if field.tables:
        read = listed(field.tables)
        if field.unrevised:
            read += f", {listed(field.unrevised)} without the hotfix revision"
        facts.append(f"Reads {read}.")
    if field.needs:
        facts.append(f"Needs {listed(field.needs, linked)}.")
    if field.given:
        facts.append(f"Handed {listed(field.given)} by the wiring.")
    if field.landings:
        facts.append(f"Lands {listed(field.landings)}.")
    near = {target for source, target in ref.edges() if source == Node("field", field.name)}
    needed_by = sorted(node.name for node in near if node.kind == "field")
    read_by = sorted(node.name for node in near if node.kind == "section")
    if needed_by:
        facts.append(f"Needed by {listed(needed_by, linked)}.")
    if read_by:
        facts.append(f"Read by the section{'s' if len(read_by) != 1 else ''} {listed(read_by)}.")
    reached = [node for node in ref.downstream(Node("field", field.name)) if node.kind == "section"]
    home = ref.homes.get(field.name)
    if home:
        families = {ref.sections[node.name].family for node in reached}
        plural = "s" if len(reached) != 1 else ""
        facts.append(
            f"Reaches {len(reached)} section{plural} in {len(families)} famil{'ies' if len(families) != 1 else 'y'}, "
            f"and is drawn in full under {chapter_link(home)}."
        )
    else:
        facts.append("Reaches no section, so no diagram draws it.")
    parts = [f"#### `{field.name}`"]
    if field.what:
        parts.append(prose(sentence(field.what)))
    parts.append(prose(" ".join(facts)))
    if field.note:
        parts.append(prose(field.note))
    return "\n\n".join(parts)


def sentence(text: str) -> str:
    """A description as a sentence: begun with a capital and ended with one stop,
    whether or not the declaration wrote its own."""
    text = text.strip()
    return text[:1].upper() + text[1:] + ("" if text.endswith((".", "?", "!")) else ".")


INTRO = """\
Every field the build derives and every section it ships, written from the declarations themselves: nothing here is
typed by hand, and the repository check fails when this file and the code disagree. A field's note is the docstring
under its line in `build/pack/routes/flows.py`, or its function's docstring; a section's is its `doc`; a family's is
its module's docstring. Change the note there and the next build rewrites it here. Why the routes are shaped the way
they are is [DATA_ROUTES.md](../DATA_ROUTES.md)."""
"""What the document is, said once, since nothing else in it is written by hand."""

FINDING = """\
Every field has an entry under [Fields](#fields), headed by its own name, so `#name` links to it. Every section is a row
in its family's table, and every table a line under [Tables](#tables). `python tools/routes.py --upstream <name>` and
`--downstream <name>` walk the same graph from any table, field or section, as text."""
"""How to find one thing, for a reader arriving by search rather than by the outline."""

READING = """\
A family draws its sections, the fields they read, and what those fields read in turn, as far as the fields that
belong to it. A field reaching the sections of several families is shared: a family draws it as a grey stub, and it is
drawn in full under [Shared fields](#shared-fields), with the shared field it feeds. A table's rows are the build's own
client tables unless its outline is dashed, which marks the server dump: stock TrinityCore, not any private server."""
"""How a diagram is cut, so a stub is never mistaken for a field that reads nothing."""


def document(ref: Reference) -> str:
    """The whole reference as markdown."""
    readers: dict[str, list[str]] = {}
    for field in ref.fields.values():
        for name in field.tables:
            readers.setdefault(name, []).append(field.name)
    tables = "\n".join(
        filled(f"{code(name)}, {SOURCES[source]}: read by {listed(sorted(readers[name]), linked)}.", "- ", "  ")
        for name, source in ref.sources.items()
    )
    flows = sum(not field.computed for field in ref.fields.values())
    summary = (
        f"{len(ref.fields)} fields, {flows} of them flows and {len(ref.fields) - flows} functions; "
        f"{len(ref.sections)} sections in {len(ref.families)} families; {len(ref.sources)} tables. "
        f"The numbers are the manifest counts of `{ref.pack}`."
    )
    parts = [
        "# Route reference",
        "<!-- Generated by tools/routes.py and by every build of the default pack. Edit the declaration, not this. -->",
        INTRO,
        filled(summary),
        FINDING,
        "## How to read a diagram",
        READING,
        LEGEND.format(classes=CLASSES),
        "## Families",
        *(family_chapter(ref, chapter) for chapter in ref.families),
        "## Shared fields",
        *(group_chapter(ref, chapter) for chapter in ref.groups),
        "## Fields",
        *(entry(ref, ref.fields[name]) for name in sorted(ref.fields)),
        "## Tables",
        tables,
    ]
    return "\n\n".join(parts) + "\n"

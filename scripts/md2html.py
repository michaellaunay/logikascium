# /bin/python3
# convert mardown obsidian notes to html 5 for publishing
# usage: python3 md2html.py <notes_directory> <output_directory> <template_file>
# example: python3 md2html.py ~/Documents/notes ~/Documents/notes/html ~/Documents/notes/template.html
# author: Michael Launay
# date: 2023-05-10
# version: 0.0.1
# license: AGPLv3
# description: convert markdown obsidian notes to html 5 for publishing
# dependencies: python3, markdown, chamaleon, html5lib
import os
import sys
from pathlib import Path
import re
from arpeggio import ParserPython, visit_parse_tree
from arpeggio.cleanpeg import ParserPEG

from parsimonious.grammar import Grammar
from parsimonious.nodes import NodeVisitor

# Markdown PEG grammar definition
markdown_grammar = Grammar(r"""
Markdown = Block*
Block = Heading / List / Blockquote / FencedCodeBlock / Paragraph
Heading = "#"+" " InlineText+ Newline
List = ("-" / "+" / "*" / Digit+".") " " ListItem+ Newline
ListItem = InlineText+ (Newline List)? / Newline
Blockquote = ">" " " InlineText+ Newline
FencedCodeBlock = "```" .* "```"
Paragraph = InlineText+ Newline
InlineText = Text / Bold / Italic / InlineCode / Link / Image
Text = ~"[^*\n_\[\]<`]+"
Bold = "**" (!"**" .)+ "**" / "__" (!"__" .)+ "__"
Italic = "*" (!"*" .)+ "*" / "_" (!"_" .)+ "_"
InlineCode = "`" (!"`" .)+ "`"
Link = "[" InlineText+ "]" "(" ~"[^\)]+" ")"
Image = "![" InlineText+ "]" "(" ~"[^\)]+" ")"
Space = " " / "\t"
Newline = "\r\n" / "\n"
""")

class MarkdownVisitor(NodeVisitor):
    """Visitor 

    Args:
        NodeVisitor (_type_): _description_
    """
    def generic_visit(self, node, visited_children):
        """_summary_

        Args:
            node (_type_): _description_
            visited_children (_type_): _description_

        Returns:
            _type_: _description_
        """
        return visited_children or node

    def visit_Heading(self, node, visited_children):
        _, _, text, _ = visited_children
        return {"type": "heading", "level": node.text.count("#"), "text": "".join(text)}

    # @TODO Ajoutez des méthodes de visite pour les autres types de nœuds de la grammaire ici...

# Fonction pour analyser une chaîne Markdown et générer un AST
def parse_markdown(markdown_string):
    ast = markdown_grammar.parse(markdown_string)
    visitor = MarkdownVisitor()
    result = visitor.visit(ast)
    return result

# Exemple d'utilisation
markdown_string = "# This is a heading\n"
result = parse_markdown(markdown_string)
print(result)


class MarkdownVisitor:
    def visit_header(self, node, children):
        return f"<h{len(node.value)}>{children[0]}</h{len(node.value)}>\n"

    def visit_text(self, node, children):
        return node.value

    def visit_line_break(self, node, children):
        return "\n"

    def visit_document(self, node, children):
        return "".join(children)

def convert_markdown_to_html(markdown):
    parser = ParserPython(ParserPEG(markdown_grammar()).parse(), ws='\t ')
    parse_tree = parser.parse(markdown)
    html = visit_parse_tree(parse_tree, MarkdownVisitor())
    return html

def process_directory(input_path, output_path, template):
    for root, _, files in os.walk(input_path):
        for file in files:
            if file.endswith(".md"):
                file_path = Path(root) / file
                with open(file_path, "r") as f:
                    content = f.read()
                html_content = convert_markdown_to_html(content)
                html = template.render(title=file[:-3], content=html_content)
                dest_path = output_path / file_path.relative_to(input_path).with_suffix(".html")
                dest_path.parent.mkdir(parents=True, exist_ok=True)
                with open(dest_path, "w") as f:
                    f.write(html)

if __name__ == "__main__":
    if len(sys.argv) != 4:
        print("Usage: python script.py <input_directory> <template_file> <output_directory>")
        sys.exit(1)

    input_directory = Path(sys.argv[1])
    template_file = Path(sys.argv[2])
    output_directory = Path(sys.argv[3])

    with open(template_file, "r") as f:
        template_content = f.read()
    template = Template(template_content)

    process_directory(input_directory, output_directory, template)

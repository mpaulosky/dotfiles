# Renders each Markdown document in a JSON array on stdin with kramdown's GFM
# parser, as GitHub Pages' Jekyll does, and prints the HTML as a JSON array.
require "json"
require "kramdown"
require "kramdown-parser-gfm"

docs = JSON.parse($stdin.read)
puts JSON.generate(docs.map { |doc| Kramdown::Document.new(doc, input: "GFM").to_html })

# Third-party notices

geoverse-line-finder is an independent implementation. It adapts ideas and, where
noted, small pieces of code from the projects below. Their licenses are reproduced
as required.

| Project                                                                                | License | What was adapted                                                                                                                                             |
| -------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [terra-route](https://github.com/JamesLMilner/terra-route) — James Milner              | MIT     | 4-ary heap with stable tie-breaking (`src/heap/four-ary-heap.ts`); CSR adjacency layout and generation-stamped scratch buffers used by the search engines    |
| [geojson-path-finder](https://github.com/perliedman/geojson-path-finder) — Per Liedman | ISC     | Weight-function contract (`number` / `{ forward, backward }` / falsy = impassable), degree-2 compaction idea; small test fixtures under `test/fixtures/gpf/` |
| [cheap-ruler](https://github.com/mapbox/cheap-ruler) — Mapbox                          | ISC     | Local-scale distance approximation (`src/geo/metric.ts`, `cheapRulerMetric`)                                                                                 |
| [flatbush](https://github.com/mourner/flatbush) — Vladimir Agafonkin                   | ISC     | Packed Hilbert R-tree layout and the Hilbert-curve index function (`src/spatial/rtree.ts`)                                                                   |

---

## MIT License (terra-route)

Copyright (c) James Milner

Permission is hereby granted, free of charge, to any person obtaining a copy of this
software and associated documentation files (the "Software"), to deal in the Software
without restriction, including without limitation the rights to use, copy, modify,
merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice shall be included in all copies
or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE
OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## ISC License (geojson-path-finder, cheap-ruler, flatbush)

Copyright (c) Per Liedman; Copyright (c) 2024, Mapbox; Copyright (c) 2018, Vladimir Agafonkin

Permission to use, copy, modify, and/or distribute this software for any purpose with
or without fee is hereby granted, provided that the above copyright notice and this
permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD
TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN
NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR
CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR
PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

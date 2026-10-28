# Static pages

Files meant to be served as they are from a static host. Nothing here is part
of the client build.

## `open/`: the https side of a faf:// link

Discord turns only `https://` links into links, so a `faf://tourney/123` posted
there is plain text. `open/index.html` takes `https://<host>/open/tourney/123`
(or `/open/#tourney/123`), checks it against the six link kinds the client reads
(`crates/faf-domain/src/protocol/deep_link.rs`), and opens the `faf://` link;
when nothing answers, it offers the client's download. It loads nothing from
anywhere else.

`404.html` is for a host that serves it for every unknown path, as GitHub Pages
does: it forwards `/open/<target>/<value>` to `/open/#<target>/<value>`. A host
with its own routing (nginx `try_files $uri /open/index.html`) does not need it.

Where this is hosted is not decided yet: this repository's GitHub Pages, or
FAF's own hosting.

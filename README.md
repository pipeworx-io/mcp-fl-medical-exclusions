# @pipeworx/fl-medical-exclusions

Florida Agency for Health Care Administration (AHCA) Medicaid Sanctioned
Providers screening — check a provider by name, NPI, Florida license number
or Medicaid provider number against the ~7,000 sanction final orders AHCA
has issued under s. 409.913, F.S. / Rule 59G-9.070, F.A.C., the state-level
counterpart to the federal HHS OIG LEIE (`leie` pack) and the sibling of
`ny-omig-exclusions` (New York), `ca-medical-exclusions` (California) and
`tx-medical-exclusions` (Texas).

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1784+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `fl_medical_check_exclusion(name?, npi?, license?, medicaid_provider_number?, limit?)`
  — screens a provider against AHCA's Medicaid sanction final orders. An
  NPI, license-number or Medicaid-provider-number match is an
  **identification**; a name match — even an exact one — is a **candidate
  lead only**, since AHCA publishes no date of birth. Every match carries
  `sanction_class` and `is_participation_exclusion`: only a **SUSPENSION**
  (one-year preclusion) or **TERMINATION** (twenty-year preclusion) is an
  exclusion; fines and corrective action plans are sanctions but are never
  reported as exclusions. Matches also carry the Rule 59G-9.070 violation
  codes with AHCA's published descriptions, the fine amount, the AHCA and
  formal/informal case numbers, and a **derived** `nominal_preclusion_ends`.
  The top-level `identified_participation_exclusion` is the one-bit answer a
  screener needs: an identity-grade match on an exclusion order.
- `fl_medical_exclusion_coverage()` — total sanction orders, the breakdown
  by `sanction_class`, how many orders are participation exclusions and how
  many distinct providers that is, how many orders carry an NPI / license /
  Medicaid provider number, violation-code counts with AHCA's key, the
  oldest/newest sanction date, and when this pack's copy was captured.

## Auth

Keyless.

## Data sources

- <https://apps.ahca.myflorida.com/dm_web/> — AHCA's Public Records search.
  Selecting "Medicaid Sanctioned Providers" under Final Orders and running
  the search with every filter blank returns the list, with a server-side
  SSRS ReportViewer whose Excel export is the whole dataset (Provider,
  Medicaid Provider Number, License Number, NPI Number, Provider Type, Date
  Rendered, Sanction Type, Violation Code, Fine Amount, Sanction Date, AHCA
  Case Number, Formal/Informal Case Number, Document Type). See "Why a
  four-request session" below.
- <https://apps.ahca.myflorida.com/dm_web/FinalOrdersInformation.pdf> —
  AHCA's own key: the violation-code descriptions (7(A)–8(C)) and the
  sanction-type definitions (CAP, FINE, SUSPENSION = one-year preclusion,
  TERMINATION = twenty-year preclusion) this pack carries verbatim.

### Why no open-data-portal mirror — checked, not assumed

Florida has **no Socrata domain at all**: `data.florida.gov`,
`opendata.florida.gov`, `data.flhealth.gov`, `open.fl.gov` and
`data.myflorida.com` each return `"Domain not found"` from
`api.us.socrata.com/api/catalog/v1`, and a global catalog search for
"Florida Medicaid exclusion" / "AHCA sanctioned" returns `resultSetSize 0`
(2026-10-08). The Florida Medicaid Web Portal (`portal.flmmis.com`) publishes
a Provider Master List ZIP, but that is the enrolled-provider roster, not the
sanctions list. AHCA's Public Records search is the only source.

### Why a four-request session, not a direct URL

The search app is ASP.NET WebForms with the session id embedded in the URL
path (`/dm_web/(S(<24 chars>))/default.aspx`) and an SSRS ReportViewer on
the results page. `scripts/bake-index.mjs` replays what a browser does:

1. `GET /dm_web/` — redirects into the session-bearing path; keep the
   cookies (`__cf_bm`, `ASP.NET_SessionId`).
2. `POST` the "Medicaid Sanctioned Providers*" radio autopostback
   (`__EVENTTARGET=rdlFOMedState$3`). The server answers with a
   post/redirect/get `302` back to the same URL; follow it with a GET.
3. `POST` the Final Orders search (`btnSearchFO=Continue`, filters blank,
   `ddlFOType=ALL`) — answered from `doc_results_fo.aspx`, which carries the
   bound report's `ExportUrlBase` in its client-side JSON. The visible
   "Show Sanction Data(...)" link only expands a collapsed panel; the report
   is already rendered server-side.
4. `GET ExportUrlBase + "EXCEL"` on the same session — the dataset as a
   legacy BIFF8 `.xls` (`attachment; filename="FOReport.xls"`, ~2.3 MB).

Two traps, both measured 2026-10-08: each page's **own** `__`-prefixed
hidden fields must be forwarded verbatim (`default.aspx` rejects a
`__VIEWSTATEENCRYPTED` it did not emit, `doc_results_fo.aspx` rejects its
absence, both as "Validation of viewstate MAC failed"); and the viewer
refuses `XML`, `CSV` and `MHTML` ("Specified argument was out of the range
of valid values. Parameter name: format") — only `EXCEL`, `PDF`, `WORD`
and `IMAGE` render, so Excel is the only structured export. That is why the
bake script carries its own dependency-free BIFF8 reader (CFB container +
`LABEL`/`RK`/`NUMBER`/`MULRK` cells, dates by number-format id), verified
row-for-row equal to an `xlrd` parse of the same file (7,014 of 7,014).

### Why this is baked, not a live proxy

Per root CLAUDE.md's standing rule for a table this size, the full list
(7,014 unique orders at capture time, ~3.5 MB as generated TypeScript) is
baked by `scripts/bake-index.mjs` into `src/fl-ahca-index-data.ts`,
registered in `workers/gateway/src/pack-baked-indexes.json`, uploaded to KV
at deploy, and injected into every call as `args._bakedIndex` — never a
static module-scope import (fleet #2754). A missing or malformed injection
throws loudly rather than answering "not found" — see `src/index.test.ts`.
The upstream is also a ~20–40 s stateful session, which nothing should wait
on per request.

Re-run `node mcps/fl-medical-exclusions/scripts/bake-index.mjs` periodically
and recommit; `data_as_of` on every response says how stale the baked copy
is. `--from <file.xls>` parses a saved export offline; `--dump-rows
<file.json>` writes the parsed rows for cross-checking.

### What this data includes — one row per ORDER, and not every order excludes

AHCA's list is one row per sanction **final order**, not one row per
provider (5,313 distinct names over 7,108 exported rows; 94 exact-duplicate
rows are collapsed at bake). Most orders are **not** participation
exclusions: on 2026-10-08, 4,570 orders were fines and 255 were corrective
action plans (with or without a fine). Only **SUSPENSION** (832 orders) and
**TERMINATION** (1,247) bar a provider from Florida Medicaid — AHCA's own
definitions. Every response says this (`exclusion_vs_sanction_caveat`), and
`is_participation_exclusion` on each match is what a screener should read.

`Sanction Type` is a near-vocabulary with spelling variants (13 raw values:
`FINE` / `FINES` / `FINE ONLY`, `CAP` / `CAP ONLY` / `CAP AND FINE`,
`SUSPENSION RESCINDED`, …); the bake script folds them into the closed
`sanction_class` set and warns on any value it has not seen, so vocabulary
drift is visible rather than silent. `Violation Code`, by contrast, **is** a
controlled vocabulary — the paragraph letters of Rule 59G-9.070 — and the
pack carries AHCA's published key; two shapes in the live data are outside
that key (`7(A.1)`, and bare `409.913(14)` / `409.913(16)` statute cites)
and are passed through with `description: null` rather than invented.

### No date of birth, no reinstatement date

AHCA publishes neither. So a name match can never be an identification, and
"currently excluded" cannot be read from a field the way Texas's
`ReinstatedDate` allows. The pack derives `nominal_preclusion_ends` as
`sanction_date` plus AHCA's stated term (1 year suspension / 20 years
termination) and labels it **derived** on every match
(`derived_end_caveat`); a separate `... RESCINDED` order is the only
published signal that an exclusion was lifted early, surfaced as its own
`sanction_class`. Sanctions before July 1, 2009 did not always produce a
final order (AHCA's note), though the data itself runs from 2006.

### Matching

`npi` matches only exact 10-digit values (5,267 of 7,014 orders carry one;
every one is well-formed). `license` matches alphanumerically,
case-insensitive, with leading zeros ignored only when **both** sides are
purely numeric — so `11757` cannot match `DN11757`. `medicaid_provider_number`
is zero-padded to nine digits on both sides (the SSRS export types the
column numeric, so leading zeros are restored at bake; every live value is
≤ 9 digits, enforced loudly). Name queries match the order's provider name,
case/punctuation-insensitive, any word order. Within each tier, exclusion
orders sort before fines, newest first, so `limit` never cuts off the row
that matters.

### Reachability

Verified live 2026-10-08 from both a laptop and a throwaway
`wrangler dev --remote` Worker on the prod account (colo SJC) replaying the
exact four-request handshake: identical `200` / 2,284,544-byte
`application/vnd.ms-excel` attachment (`FOReport.xls`) from the Cloudflare
edge. Like the three precedent state packs, this host needs no Supabase
egress relay.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "fl-medical-exclusions": {
      "url": "https://gateway.pipeworx.io/fl-medical-exclusions/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/fl-medical-exclusions/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1784+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/fl_medical_check_exclusion \
  -H 'Content-Type: application/json' \
  -d '{"npi":"1750409819"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/fl_medical_check_exclusion`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "fl-medical-exclusions": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-fl-medical-exclusions"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-fl-medical-exclusions
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Fl Medical Exclusions data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT

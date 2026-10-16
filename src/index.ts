interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Shared "count records by a named date field over a year or range" helper —
 * fleet #3170.
 *
 * WHY THIS EXISTS. Four baked-table packs (ny-omig-exclusions,
 * tx-medical-exclusions, ca-medical-exclusions, fl-medical-exclusions) each
 * hold thousands of rows and each had only a list-wide total — no way to
 * answer "how many took effect in year Y" without a caller paging through
 * every row itself. A benchmark probe (fleet #3170/#3149) asked exactly that
 * question against two of them and both returned the SAME list-wide total on
 * every one of 7-8 rounds; the model ran out of rounds and refused rather
 * than get a wrong number. This is the one piece of that fix every pack
 * shares: parsing `year` or `start_date`/`end_date` into an inclusive
 * YYYY-MM-DD range, or a NAMED reason when the input can't be turned into
 * one. It deliberately never returns a silent zero for a bad argument —
 * root CLAUDE.md's silent-zero policy applies to a malformed count request
 * exactly as it does to an upstream outage.
 *
 * WHAT IT DOES NOT DO. It does not touch the rows — each pack's own ISO date
 * field (already YYYY-MM-DD in every one of these four) is filtered by plain
 * string comparison, which is correct for YYYY-MM-DD strings and avoids a
 * Date() parse / timezone trap entirely. Each pack is responsible for saying
 * which of its own fields it counted (data varies: NY/TX/CA have exactly one
 * exclusion-date field each; FL additionally splits "all sanction orders" vs
 * "participation exclusions" within the matched range).
 */

interface DateRange {
  /** Inclusive start date, YYYY-MM-DD. */
  start: string;
  /** Inclusive end date, YYYY-MM-DD. */
  end: string;
  /** Human label for the range, e.g. "2025" or "2024-06-01 to 2025-06-01". */
  label: string;
}

interface DateRangeError {
  error: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Reads `args.year`, `args.start_date` and `args.end_date` and returns:
 *   - `null` if none were passed (no date-range count was requested at all —
 *     the caller should fall through to its normal, non-counting response);
 *   - `{ error }` if something WAS passed but can't be turned into a valid
 *     range (bad format, start after end, year out of a sane bound) — the
 *     caller must surface this as a named reason, never as a zero count;
 *   - `{ start, end, label }` otherwise.
 *
 * start_date/end_date, if either is present, take precedence over `year`
 * (an explicit range is a more specific request than a calendar year).
 */
function parseYearOrDateRange(args: Record<string, unknown>): DateRange | DateRangeError | null {
  const startRaw = typeof args.start_date === 'string' ? args.start_date.trim() : '';
  const endRaw = typeof args.end_date === 'string' ? args.end_date.trim() : '';
  const yearRaw = args.year;
  const yearGiven = yearRaw !== undefined && yearRaw !== null && yearRaw !== '';

  if (!startRaw && !endRaw && !yearGiven) return null;

  if (startRaw || endRaw) {
    if (!DATE_RE.test(startRaw) || !DATE_RE.test(endRaw)) {
      return {
        error:
          `start_date and end_date must BOTH be present and in YYYY-MM-DD form ` +
          `(got start_date=${startRaw ? JSON.stringify(startRaw) : '(missing)'}, end_date=${endRaw ? JSON.stringify(endRaw) : '(missing)'}).`,
      };
    }
    if (startRaw > endRaw) {
      return { error: `start_date (${startRaw}) is after end_date (${endRaw}).` };
    }
    return { start: startRaw, end: endRaw, label: startRaw === endRaw ? startRaw : `${startRaw} to ${endRaw}` };
  }

  const year = Math.floor(Number(yearRaw));
  if (!Number.isFinite(year) || year < 1900 || year > 2100) {
    return { error: `year must be a 4-digit calendar year between 1900 and 2100 (got ${JSON.stringify(yearRaw)}).` };
  }
  return { start: `${year}-01-01`, end: `${year}-12-31`, label: String(year) };
}

function isDateRangeError(r: DateRange | DateRangeError | null): r is DateRangeError {
  return r != null && typeof (r as DateRangeError).error === 'string';
}

/** Inclusive YYYY-MM-DD membership test; `null`/empty dates never match. */
function inRange(date: string | null | undefined, range: DateRange): boolean {
  return Boolean(date) && (date as string) >= range.start && (date as string) <= range.end;
}

const DATE_RANGE_ARG_SCHEMA = {
  year: {
    type: 'number' as const,
    description: 'Count records whose date field falls in this calendar year (e.g. 2025), counted over the WHOLE list, not a page. Ignored if start_date/end_date are given.',
  },
  start_date: {
    type: 'string' as const,
    description: 'Inclusive range start, YYYY-MM-DD. Use with end_date for a custom date range instead of a calendar year.',
  },
  end_date: {
    type: 'string' as const,
    description: 'Inclusive range end, YYYY-MM-DD. Use with start_date for a custom date range instead of a calendar year.',
  },
};
/**
 * Florida AHCA Medicaid Sanctioned Providers screening — check a provider
 * name, NPI, Florida license number or Medicaid provider number against the
 * Agency for Health Care Administration's Medicaid sanction final orders
 * (suspensions, terminations, fines and corrective action plans), the
 * state-level counterpart to the federal LEIE for Florida. Keyless.
 *
 * Fleet #2815 — the fourth state exclusion pack after
 * mcps/ny-omig-exclusions (#2788), mcps/ca-medical-exclusions (#2805) and
 * mcps/tx-medical-exclusions (#2809).
 *
 * Beside the federal HHS OIG LEIE (mcps/leie) and the SAM federal
 * exclusions list, Florida sanctions its own Medicaid providers through
 * AHCA's Office of Medicaid Program Integrity under s. 409.913, F.S. and
 * Rule 59G-9.070, F.A.C., and is required (since July 1, 2009) to post the
 * providers it has terminated for cause. This is that list, for Florida
 * only — one pack per jurisdiction (root CLAUDE.md rule 5).
 *
 * SOURCE AND SHAPE. No open-data-portal mirror exists — checked, not
 * assumed: Florida has no Socrata domain at all (data.florida.gov and four
 * other candidates return "Domain not found" from the catalog API,
 * 2026-10-08) and a global catalog search for the list returns zero. The
 * only source is AHCA's Public Records search
 * (https://apps.ahca.myflorida.com/dm_web/): an ASP.NET WebForms app with a
 * session id in the URL path, whose "Medicaid Sanctioned Providers" final
 * orders search carries a server-side SSRS ReportViewer that exports the
 * whole dataset as a legacy BIFF8 .xls (XML/CSV are refused). The bake
 * script replays the four-request session and parses the .xls with its own
 * dependency-free reader — see scripts/bake-index.mjs for the handshake
 * and the viewstate trap it documents. Verified live 2026-10-08 from both a
 * laptop and a throwaway `wrangler dev --remote` Worker (README
 * "Reachability").
 *
 * Root CLAUDE.md's standing rule 3 applies regardless of reachability: a
 * baked table this size (7,014 rows, ~3.5MB as generated TS) never sits in
 * gateway module scope. It is baked into src/fl-ahca-index-data.ts,
 * registered in workers/gateway/src/pack-baked-indexes.json, uploaded to
 * KV at deploy (scripts/sync-gateway-static-json.mjs), and injected here as
 * `args._bakedIndex` — same pattern as the three precedent packs (fleet
 * #2754).
 *
 * This is an official Florida State public enforcement record that AHCA
 * publishes specifically so payers, plans and the public can screen
 * against it (its managed-care contracts require plans to check it
 * monthly) — baking a copy needs no reuse grant, same footing as the
 * federal LEIE and the three precedent state packs.
 *
 * ONE ROW PER FINAL ORDER, NOT PER PROVIDER — and NOT EVERY ROW IS AN
 * EXCLUSION. Verified against all live rows: of 7,014 unique orders, 4,570
 * are fines and 255 are corrective action plans (with or without a fine),
 * which are sanctions but NOT participation exclusions. Only SUSPENSION
 * (a one-year preclusion from any Medicaid claim) and TERMINATION (a
 * twenty-year preclusion) exclude a provider — AHCA's own definitions from
 * the FinalOrdersInformation.pdf key on the search page. 2,079 orders are
 * one of those two. Every response says which matches are participation
 * exclusions and which are merely sanctions, and never counts a fine as an
 * exclusion.
 *
 * SANCTION TYPE IS A NEAR-VOCABULARY WITH SPELLING VARIANTS (FINE / FINES /
 * FINE ONLY; CAP / CAP ONLY; SUSPENSION RESCINDED ...) — 13 raw values,
 * verified live. The bake script folds them into the closed
 * `sanction_class` set and warns on any new raw value. VIOLATION CODE, by
 * contrast, IS a controlled vocabulary — the 7(A)..8(C) paragraph letters
 * of Rule 59G-9.070 — and AHCA publishes the key, carried here as
 * VIOLATION_CODE_KEY; two shapes in the live data are outside the
 * published key ("7(A.1)" and bare "409.913(14)"/"409.913(16)" cites) and
 * are passed through with description null rather than invented.
 *
 * NO DATE OF BIRTH AND NO REINSTATEMENT DATE ARE PUBLISHED, so (a) a name
 * match — even an exact one — is a CANDIDATE, never an identification;
 * only an NPI, license number or Medicaid provider number identifies a
 * provider; and (b) "currently excluded" cannot be read from a field. The
 * pack derives `nominal_preclusion_ends` from the sanction date plus
 * AHCA's stated term and labels it DERIVED on every match; a separate
 * "... RESCINDED" order is the only published signal that an exclusion was
 * lifted, and the pack surfaces those as their own class.
 *
 * Keyless.
 */
import type { FlAhcaRow } from './fl-ahca-index-data.js';

// fleet #2754 / root CLAUDE.md rule 3 — the data module is NEVER
// value-imported here; the gateway injects its JSON form from KV as
// args._bakedIndex. The type-only import above is erased at build time.
let ROWS: FlAhcaRow[] = [];
let DATA_AS_OF = '';
let SOURCE_URL = '';
let KEY_PDF_URL = '';
let CAPTURED_AT = '';
let TOTAL_ROWS = 0;
let DUPLICATES_COLLAPSED = 0;
let NEWEST_DATE_RENDERED: string | null = null;

function ensureIndex(args: Record<string, unknown>): void {
  if (ROWS.length) return;
  const idx = args._bakedIndex as Record<string, unknown> | null | undefined;
  const rows = idx?.FL_AHCA_ROWS;
  if (!Array.isArray(rows) || rows.length === 0) {
    // Loud on purpose (root CLAUDE.md rule 2): answering "no sanction
    // found" from an empty table would be a silent wrong answer,
    // indistinguishable from a real clean screening result.
    throw new Error(
      `fl-medical-exclusions: the baked AHCA Medicaid sanctions index is unavailable (${idx == null ? 'not injected' : 'malformed'}). ` +
        'The gateway loads it from KV on the first call into this pack; this is a server-side fault, not a bad query — retry shortly.',
    );
  }
  ROWS = rows as FlAhcaRow[];
  DATA_AS_OF = String(idx?.FL_AHCA_DATA_AS_OF ?? '');
  SOURCE_URL = String(idx?.FL_AHCA_SOURCE_URL ?? 'https://apps.ahca.myflorida.com/dm_web/');
  KEY_PDF_URL = String(idx?.FL_AHCA_KEY_PDF_URL ?? 'https://apps.ahca.myflorida.com/dm_web/FinalOrdersInformation.pdf');
  CAPTURED_AT = String(idx?.FL_AHCA_CAPTURED_AT ?? '');
  TOTAL_ROWS = Number(idx?.FL_AHCA_TOTAL_ROWS ?? ROWS.length);
  DUPLICATES_COLLAPSED = Number(idx?.FL_AHCA_DUPLICATE_ROWS_COLLAPSED ?? 0);
  NEWEST_DATE_RENDERED = typeof idx?.FL_AHCA_NEWEST_DATE_RENDERED === 'string' ? (idx.FL_AHCA_NEWEST_DATE_RENDERED as string) : null;
}

const SOURCE_LABEL = 'Florida Agency for Health Care Administration (AHCA) — Medicaid Sanctioned Providers final orders (s. 409.913, F.S. / Rule 59G-9.070, F.A.C.)';

/** AHCA's published violation-code key (FinalOrdersInformation.pdf, pp. 3-4). */
export const VIOLATION_CODE_KEY: Record<string, string> = {
  '7(A)': 'License not renewed, revoked or terminated',
  '7(B)': 'Failure to make available records',
  '7(C)': 'Failure to furnish records',
  '7(D)': 'Failure to maintain Medicaid records',
  '7(E)': 'Failure to comply with Medicaid laws',
  '7(F)': 'Furnishing inappropriate or unnecessary goods',
  '7(G)': 'Failure to provide medically necessary goods or services',
  '7(H)': 'Submitting false Medicaid claims',
  '7(I)': 'Submitting false or incorrect documents',
  '7(J)': 'Improper patient billing or collection',
  '7(K)': 'Unallowable costs',
  '7(L)': 'Charged with fraudulent practices',
  '7(M)': 'Patient neglect resulting in injury or death',
  '7(N)': 'Failure to have sufficient goods or time',
  '7(O)': 'Failure to comply with reporting requirements',
  '7(P)': 'Patient abuse or neglect',
  '7(Q)': 'Failure to comply with repayment schedule',
  '7(R)': 'Convicted of a criminal offense related to the practice',
  '7(S)': 'Non-payment or partial payment of monies owed',
  '8(A)': 'Convicted of a criminal offense related to the practice (pre-September-2010 numbering; now 7(R))',
  '8(B)': 'Non-payment or partial payment of monies owed (pre-September-2010 numbering; now 7(S))',
  '8(C)': 'Failure to reimburse an overpayment (pre-September-2010 numbering; now 7(S))',
};

type SanctionClass =
  | 'termination' | 'suspension' | 'termination_rescinded' | 'suspension_rescinded'
  | 'fine' | 'fine_rescinded' | 'cap' | 'cap_and_fine' | 'none' | 'unspecified' | 'other';

const SANCTION_CLASS_MEANING: Record<SanctionClass, string> = {
  termination: 'TERMINATION — a participation EXCLUSION: a twenty-year preclusion from any action that results in a Medicaid claim (AHCA definition).',
  suspension: 'SUSPENSION — a participation EXCLUSION: a one-year preclusion from any action that results in a Medicaid claim (AHCA definition).',
  termination_rescinded: 'A separate order rescinding an earlier termination. The earlier termination row still appears in this list; read the two together.',
  suspension_rescinded: 'A separate order rescinding an earlier suspension. The earlier suspension row still appears in this list; read the two together.',
  fine: 'FINE — a monetary sanction. NOT a participation exclusion; the provider was not barred from Medicaid by this order.',
  fine_rescinded: 'A separate order rescinding an earlier fine. NOT a participation exclusion.',
  cap: 'CAP (corrective action plan). NOT a participation exclusion.',
  cap_and_fine: 'CAP (corrective action plan) plus a fine. NOT a participation exclusion.',
  none: 'AHCA recorded the sanction type as NONE (e.g. a dismissed case). NOT a participation exclusion.',
  unspecified: 'AHCA left the sanction type blank on this order. Read the final order itself before treating it as an exclusion.',
  other: 'A sanction-type value this pack has not classified; sanction_type_raw carries AHCA\'s wording verbatim.',
};

const EXCLUSION_CLASSES = new Set<SanctionClass>(['termination', 'suspension']);
const RESCINDED_CLASSES = new Set<SanctionClass>(['termination_rescinded', 'suspension_rescinded']);

const PRECLUSION_TERM: Partial<Record<SanctionClass, { label: string; years: number }>> = {
  termination: { label: '20 years', years: 20 },
  suspension: { label: '1 year', years: 1 },
};

const NOT_AN_IDENTIFICATION =
  'Name matches are CANDIDATES, not identifications — AHCA publishes no date of birth, and provider names repeat across orders and across unrelated providers. Only an NPI, license-number or Medicaid-provider-number match identifies a specific provider. Confirm a name match against one of those before acting on it.';

const EXCLUSION_VS_SANCTION_CAVEAT =
  'This list is one row per AHCA sanction FINAL ORDER, not one row per excluded provider, and most orders are fines or corrective action plans, which are NOT participation exclusions. Only sanction_class "suspension" (1-year preclusion) and "termination" (20-year preclusion) bar a provider from Florida Medicaid. is_participation_exclusion on each match says which is which; a fine is never reported as an exclusion here.';

const DERIVED_END_CAVEAT =
  'AHCA publishes no reinstatement or end date. nominal_preclusion_ends is DERIVED by this pack as sanction_date plus the term in AHCA\'s own definitions (1 year for a suspension, 20 years for a termination); it is not an AHCA field, and a later "... RESCINDED" order is the only published signal that an exclusion was lifted early.';

const VOCABULARY_NOTE =
  'violation_codes are the paragraph letters of Rule 59G-9.070, F.A.C., a controlled vocabulary with a published key (violation_code_descriptions). sanction_class is this pack\'s normalisation of AHCA\'s Sanction Type field, whose raw values vary in spelling (FINE / FINES / FINE ONLY); sanction_type_raw carries the original.';

function normalize(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function digitsOnly(s: string): string {
  return s.replace(/\D/g, '');
}

function alnum(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Exact alphanumeric license comparison; leading zeros ignored only when BOTH sides are purely numeric. */
function licenseEquals(a: string, b: string): boolean {
  const x = alnum(a);
  const y = alnum(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (/^\d+$/.test(x) && /^\d+$/.test(y)) return x.replace(/^0+/, '') === y.replace(/^0+/, '');
  return false;
}

function isTenDigitNpi(s: string): boolean {
  return /^\d{10}$/.test(s);
}

function addYears(iso: string, years: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y! + years, m! - 1, d!)).toISOString().slice(0, 10);
}

type MatchType = 'npi_match' | 'license_match' | 'medicaid_provider_number_match' | 'name_candidate_exact' | 'name_candidate_partial';

const MATCH_MEANING: Record<MatchType, string> = {
  npi_match: 'The NPI matched exactly against this order\'s listed NPI. An NPI identifies one provider, so this is an identification.',
  license_match: 'The license number matched exactly (alphanumeric, case-insensitive). A Florida license number identifies one licensee, so this is an identification.',
  medicaid_provider_number_match: 'The nine-digit Florida Medicaid provider number matched exactly. It identifies one enrolled provider, so this is an identification.',
  name_candidate_exact: 'The provider name matched exactly, but AHCA publishes no date of birth to confirm it is the same person or entity — treat as a candidate and confirm with NPI, license or Medicaid provider number.',
  name_candidate_partial: 'The name is a partial/substring match, not exact. Treat as a lead to check, not a finding. Confirm with NPI, license or Medicaid provider number.',
};

function shape(r: FlAhcaRow, matchType: MatchType) {
  const cls = r.sanction_class as SanctionClass;
  const isExclusion = EXCLUSION_CLASSES.has(cls);
  const term = PRECLUSION_TERM[cls];
  return {
    provider_name: r.provider_name,
    provider_type: r.provider_type,
    medicaid_provider_number: r.medicaid_provider_number,
    license_number: r.license_number,
    npi: r.npi,
    sanction_class: cls,
    sanction_type_raw: r.sanction_type_raw,
    is_participation_exclusion: isExclusion,
    is_rescission: RESCINDED_CLASSES.has(cls) || cls === 'fine_rescinded',
    what_the_sanction_means: SANCTION_CLASS_MEANING[cls] ?? SANCTION_CLASS_MEANING.other,
    sanction_date: r.sanction_date,
    preclusion_term: term ? term.label : null,
    nominal_preclusion_ends: term && r.sanction_date ? addYears(r.sanction_date, term.years) : null,
    nominal_preclusion_ends_is_derived: term ? true : null,
    violation_codes: r.violation_codes,
    violation_code_descriptions: r.violation_codes.map((c) => ({ code: c, description: VIOLATION_CODE_KEY[c] ?? null })),
    fine_amount_usd: r.fine_amount_usd,
    ahca_case_number: r.ahca_case_number,
    formal_informal_case_number: r.formal_informal_case_number,
    document_type: r.document_type,
    date_rendered: r.date_rendered,
    match_type: matchType,
    what_that_means: MATCH_MEANING[matchType],
  };
}

async function checkExclusion(args: Record<string, unknown>) {
  const nameRaw = typeof args.name === 'string' ? args.name.trim() : '';
  const npiRaw = typeof args.npi === 'string' ? digitsOnly(args.npi) : typeof args.npi === 'number' ? String(args.npi) : '';
  const licenseRaw = typeof args.license === 'string' ? args.license.trim() : '';
  const mpnRaw = typeof args.medicaid_provider_number === 'string'
    ? digitsOnly(args.medicaid_provider_number)
    : typeof args.medicaid_provider_number === 'number' ? String(Math.floor(args.medicaid_provider_number)) : '';
  const mpn = mpnRaw ? mpnRaw.padStart(9, '0') : '';

  if (!nameRaw && !npiRaw && !licenseRaw && !mpn) {
    return {
      found: false,
      reason: 'no_query',
      hint: 'Pass name (the provider or business to screen), and/or npi, license, or medicaid_provider_number. An NPI, license or Medicaid-provider-number match is an identification; a name match is a lead.',
      source: SOURCE_LABEL,
      source_url: SOURCE_URL,
      data_as_of: DATA_AS_OF,
    };
  }

  const limit = Math.max(1, Math.min(50, Math.floor(typeof args.limit === 'number' ? args.limit : 10)));

  // Identity-grade matches first: NPI (exact 10-digit), license, Medicaid
  // provider number — all exact.
  const npiMatches = npiRaw && isTenDigitNpi(npiRaw) ? ROWS.filter((r) => r.npi && digitsOnly(r.npi) === npiRaw) : [];
  const licenseMatches = licenseRaw ? ROWS.filter((r) => r.license_number && licenseEquals(r.license_number, licenseRaw)) : [];
  const mpnMatches = mpn && mpn.length === 9 ? ROWS.filter((r) => r.medicaid_provider_number === mpn) : [];

  const identitySeen = new Set<FlAhcaRow>();
  const identityResults: ReturnType<typeof shape>[] = [];
  const take = (rows: FlAhcaRow[], t: MatchType) => {
    for (const r of rows) {
      if (identitySeen.has(r)) continue;
      identitySeen.add(r);
      identityResults.push(shape(r, t));
    }
  };
  take(npiMatches, 'npi_match');
  take(licenseMatches, 'license_match');
  take(mpnMatches, 'medicaid_provider_number_match');

  // Name-candidate matches: exact normalized name, then token-substring.
  let nameResults: ReturnType<typeof shape>[] = [];
  if (nameRaw) {
    const qNorm = normalize(nameRaw);
    const qTokens = qNorm.split(' ').filter(Boolean);
    const exact: ReturnType<typeof shape>[] = [];
    const partial: ReturnType<typeof shape>[] = [];
    for (const r of ROWS) {
      if (identitySeen.has(r)) continue;
      const nNorm = normalize(r.provider_name);
      if (nNorm && qNorm === nNorm) {
        exact.push(shape(r, 'name_candidate_exact'));
      } else if (qTokens.length > 0 && qTokens.every((t) => nNorm.includes(t))) {
        partial.push(shape(r, 'name_candidate_partial'));
      }
    }
    nameResults = [...exact, ...partial];
  }

  // Exclusions first within each tier, newest first, so the row that
  // matters for a screening decision is never the one cut off by `limit`.
  const order = (a: ReturnType<typeof shape>, b: ReturnType<typeof shape>) =>
    Number(b.is_participation_exclusion) - Number(a.is_participation_exclusion) || (b.sanction_date ?? '').localeCompare(a.sanction_date ?? '');
  identityResults.sort(order);
  nameResults.sort(order);

  const combined = [...identityResults, ...nameResults];
  const truncated = combined.length > limit;
  const matches = combined.slice(0, limit);
  const screened = { name: nameRaw || null, npi: npiRaw || null, license: licenseRaw || null, medicaid_provider_number: mpn || null };

  if (combined.length === 0) {
    return {
      found: false,
      result: 'No sanction final order found in the Florida AHCA Medicaid Sanctioned Providers list for that provider.',
      screened,
      caveat: `This checks Florida AHCA's Medicaid sanction final orders only (posted from July 2009; the data runs from 2006). It does not cover the federal HHS OIG LEIE, the federal SAM exclusions list, New York's OMIG list (see ny-omig-exclusions), California's DHCS S&I list (see ca-medical-exclusions), Texas's HHSC OIG list (see tx-medical-exclusions), or any other state's Medicaid exclusion list. ${EXCLUSION_VS_SANCTION_CAVEAT}`,
      source: SOURCE_LABEL,
      source_url: SOURCE_URL,
      data_as_of: DATA_AS_OF,
    };
  }

  const exclusionOrders = combined.filter((m) => m.is_participation_exclusion);
  const rescissionOrders = combined.filter((m) => RESCINDED_CLASSES.has(m.sanction_class));
  const identityExclusions = identityResults.filter((m) => m.is_participation_exclusion);

  return {
    found: true,
    match_basis: identityResults.length > 0 ? 'identification' : 'name_candidates_only',
    // What a screener actually needs: is there an identity-grade exclusion?
    identified_participation_exclusion: identityExclusions.length > 0,
    screened,
    count: combined.length,
    participation_exclusion_orders: exclusionOrders.length,
    exclusion_rescission_orders: rescissionOrders.length,
    other_sanction_orders: combined.length - exclusionOrders.length - rescissionOrders.length,
    truncated,
    matches,
    not_an_identification: NOT_AN_IDENTIFICATION,
    exclusion_vs_sanction_caveat: EXCLUSION_VS_SANCTION_CAVEAT,
    derived_end_caveat: DERIVED_END_CAVEAT,
    vocabulary_note: VOCABULARY_NOTE,
    source: SOURCE_LABEL,
    source_url: SOURCE_URL,
    data_as_of: DATA_AS_OF,
  };
}

async function coverage(args: Record<string, unknown>) {
  const byClass: Record<string, number> = {};
  for (const r of ROWS) byClass[r.sanction_class] = (byClass[r.sanction_class] ?? 0) + 1;
  const exclusions = ROWS.filter((r) => EXCLUSION_CLASSES.has(r.sanction_class as SanctionClass));
  const withNpi = ROWS.filter((r) => r.npi).length;
  const withLicense = ROWS.filter((r) => r.license_number).length;
  const dates = ROWS.map((r) => r.sanction_date).filter((d): d is string => Boolean(d)).sort();
  const providerTypes = new Set(ROWS.map((r) => r.provider_type).filter(Boolean));
  const codes: Record<string, number> = {};
  for (const r of ROWS) for (const c of r.violation_codes) codes[c] = (codes[c] ?? 0) + 1;

  // fleet #3170: count-by-date-range mode. Unlike the other three state
  // packs, FL's list is one row per sanction FINAL ORDER and most orders are
  // fines/CAPs, not exclusions (see EXCLUSION_VS_SANCTION_CAVEAT) — so a
  // date-range count here headlines PARTICIPATION EXCLUSIONS (suspension +
  // termination) in range, and separately reports all sanction orders in
  // range for context, rather than conflating the two under one "exclusions"
  // number the way a naive port of the other three packs would.
  const range = parseYearOrDateRange(args);
  if (isDateRangeError(range)) {
    return {
      found: false,
      reason: 'invalid_date_range',
      hint: range.error,
      source: SOURCE_LABEL,
      source_url: SOURCE_URL,
      data_as_of: DATA_AS_OF,
    };
  }
  if (range) {
    const ordersInRange = ROWS.filter((r) => inRange(r.sanction_date, range));
    const exclusionsInRange = ordersInRange.filter((r) => EXCLUSION_CLASSES.has(r.sanction_class as SanctionClass));
    return {
      found: true,
      mode: 'date_range_count',
      participation_exclusion_count: exclusionsInRange.length,
      all_sanction_orders_count: ordersInRange.length,
      date_field_counted: 'sanction_date — the final order\'s sanction date',
      range: { start: range.start, end: range.end, label: range.label },
      counted_over: 'the whole list (7,000+ rows), not a page',
      exclusion_vs_sanction_caveat: EXCLUSION_VS_SANCTION_CAVEAT,
      total_sanction_orders_all_time: TOTAL_ROWS,
      participation_exclusion_orders_all_time: exclusions.length,
      oldest_sanction_date: dates[0] ?? null,
      newest_sanction_date: dates[dates.length - 1] ?? null,
      data_as_of: DATA_AS_OF,
      index_captured_at: CAPTURED_AT,
      source: SOURCE_LABEL,
      source_url: SOURCE_URL,
    };
  }

  return {
    found: true,
    total_sanction_orders: TOTAL_ROWS,
    duplicate_rows_collapsed_at_bake: DUPLICATES_COLLAPSED,
    distinct_provider_names: new Set(ROWS.map((r) => normalize(r.provider_name))).size,
    orders_by_sanction_class: byClass,
    participation_exclusion_orders: exclusions.length,
    participation_exclusion_distinct_provider_names: new Set(exclusions.map((r) => normalize(r.provider_name))).size,
    with_npi: withNpi,
    with_license_number: withLicense,
    with_medicaid_provider_number: ROWS.filter((r) => r.medicaid_provider_number).length,
    distinct_provider_types: providerTypes.size,
    violation_code_counts: codes,
    violation_code_key: VIOLATION_CODE_KEY,
    oldest_sanction_date: dates[0] ?? null,
    newest_sanction_date: dates[dates.length - 1] ?? null,
    newest_date_rendered: NEWEST_DATE_RENDERED,
    data_as_of: DATA_AS_OF,
    index_captured_at: CAPTURED_AT,
    posting_window: 'AHCA has been required to post terminated-for-cause providers since July 1, 2009; sanctions before that date did not always produce a final order and may be absent (AHCA\'s own note). The data itself runs from 2006.',
    exclusion_vs_sanction_caveat: EXCLUSION_VS_SANCTION_CAVEAT,
    derived_end_caveat: DERIVED_END_CAVEAT,
    vocabulary_note: VOCABULARY_NOTE,
    violation_code_key_url: KEY_PDF_URL,
    source: SOURCE_LABEL,
    source_url: SOURCE_URL,
  };
}

const tools: McpToolExport['tools'] = [
  {
    name: 'fl_medical_check_exclusion',
    description:
      'Is this healthcare provider excluded from, or sanctioned by, the Florida Medicaid program? Screens a person or business name, an NPI, a Florida license number, and/or a nine-digit Florida Medicaid provider number against the Florida Agency for Health Care Administration (AHCA) Medicaid Sanctioned Providers final-order list — the state-level counterpart to the federal HHS OIG LEIE (see the leie pack) for Florida specifically, and the sibling of ny_omig_check_exclusion (New York), ca_medical_check_exclusion (California) and tx_medical_check_exclusion (Texas). Answers "is this provider excluded from Florida Medicaid", "check this NPI against the Florida AHCA sanctions list", or pre-payment/credentialing screening for a Florida Medicaid provider. '
      + 'An NPI, license-number or Medicaid-provider-number match is an IDENTIFICATION; a name match — even an exact one — is a CANDIDATE lead only, since AHCA publishes no date of birth. The list is one row per sanction ORDER and most orders are fines or corrective action plans, which are NOT exclusions: every match carries sanction_class and is_participation_exclusion, and only a SUSPENSION (1-year preclusion) or TERMINATION (20-year preclusion) is reported as an exclusion. Each match also carries the Rule 59G-9.070 violation codes with AHCA\'s published descriptions, the fine amount, case numbers, and a DERIVED nominal end date (AHCA publishes no reinstatement date). Sourced from AHCA\'s Public Records final-orders search, keyless.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Provider or business name to screen, e.g. "John Smith" or "Acme Home Health Inc". Matched against the provider name on each order, any word order.' },
        npi: { type: 'string', description: 'The provider\'s 10-digit NPI, if known. An NPI match is an identification rather than a name lead — always pass it when known.' },
        license: { type: 'string', description: 'Florida professional or facility license number, if known, e.g. "ME81509" or "11075". A license match is an identification.' },
        medicaid_provider_number: { type: 'string', description: 'Nine-digit Florida Medicaid provider number, if known (leading zeros optional). A match is an identification.' },
        limit: { type: 'number', description: 'Maximum matching orders to return (default 10, max 50). Exclusion orders sort before fines within each tier, newest first.' },
      },
    },
  },
  {
    name: 'fl_medical_exclusion_coverage',
    description:
      'What the Florida AHCA Medicaid Sanctioned Providers data covers and how current it is: total sanction final orders, how many are participation exclusions (suspensions/terminations) vs. fines and corrective action plans, distinct providers, how many orders carry an NPI, license or Medicaid provider number, the violation-code counts with AHCA\'s published key, the oldest and newest sanction dates, and when this pack\'s copy was captured. Use to check the screening data is fresh enough to rely on before a compliance decision, and to read the notes on the sanction-vs-exclusion distinction and the derived end dates. '
      + 'Pass year (e.g. 2025) or start_date/end_date to instead COUNT orders by sanction_date in that year or range, counted over the whole 7,000+ row list, not a page — answers "how many Florida Medicaid exclusions took effect in 2025". Returns participation_exclusion_count (suspensions + terminations only — the real exclusions) separately from all_sanction_orders_count (which also includes fines/CAPs, not exclusions); the response says which is which. Sourced from AHCA\'s Public Records final-orders search, keyless.',
    inputSchema: { type: 'object' as const, properties: { ...DATE_RANGE_ARG_SCHEMA } },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  ensureIndex(args);
  switch (name) {
    case 'fl_medical_check_exclusion':
      return checkExclusion(args);
    case 'fl_medical_exclusion_coverage':
      return coverage(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export { tools, callTool };
export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;

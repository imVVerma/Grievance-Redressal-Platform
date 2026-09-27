// Name redaction — design doc §2.3, "In-text name redaction".
//
// A complaint can name the very people it is about ("Warden Rajesh Kumar was
// rude"), which is a privacy problem for the people named and a fairness problem
// for whoever is accused. This masks likely person names before the text is ever
// stored.
//
// A complaint can also carry an email address, which deanonymises a submitter in
// one line of text. Email addresses are handled by a separate, deterministic
// regex pass rather than by the NLP tagger, because "@" is unambiguous: there is
// no such thing as a person name that is really an email address, so this pass
// needs no accuracy trade-off at all. It is not a heuristic, and it will never
// mask something that is not an address.
//
// Two passes, in this order:
//   1. email addresses — deterministic, no NLP
//   2. person names — compromise
//
// The order matters. Running the email pass first means the NLP tagger never sees
// the local part, which is usually the person's own name ("rajesh.kumar@…"), so
// the address is gone before it can be half-masked or mistaken for a person.
//
// The name pass is a heuristic, and it is deliberately treated as one. There is
// no moderator role in this app yet, so there is nobody to hand an ambiguous case
// to, and that leaves exactly one safe default: redact on detection, always.
// The guarantee comes from that asymmetry — a false positive costs a masked
// word, a false negative costs a person's name in a permanent database row. The
// detection accuracy is not what makes this safe.
//
// Only email addresses are handled. Phone numbers, postcodes, roll numbers and
// the rest are deliberately out of scope until each one has the same
// no-false-positive guarantee that "@" gives us for free.
//
// compromise runs entirely in-process; it never makes a network call and no
// complaint text leaves the machine.

const nlp = require('compromise');

const REDACTION = '[REDACTED]';

// A practical email pattern. Deliberately stricter than the /\S+@\S+\.\S+/ shape
// it replaces, for one reason: fully greedy \S+ runs swallow trailing
// punctuation, so "priya@x.edu." would lose its full stop. Here the local part
// allows the dot/plus/underscore/hyphen forms real addresses use, the domain
// allows sub-domains, and the TLD must be two or more letters — which is what
// keeps prose like "figure 3 @ 4.5" from matching.
const EMAIL_SOURCE = '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.[A-Za-z]{2,}';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A match of one or two characters, or of nothing but punctuation/digits, cannot
// be a useful name and masking it would shred ordinary sentences.
function isMaskable(name) {
  if (name.length < 3) return false;
  return /[a-z]/i.test(name);
}

// Pure: same input always gives the same output, nothing is written or logged.
// Returns the masked text plus what was matched, so a caller can tell "nothing
// was found" from "something was found and masked". `masked` is the single
// boolean a caller actually wants, so no caller has to know about the two arrays
// or risk forgetting one of them.
function redactNames(text) {
  if (typeof text !== 'string') {
    return { redactedText: '', namesFound: [], emailsFound: [], masked: false };
  }

  if (text.trim() === '') {
    return { redactedText: text, namesFound: [], emailsFound: [], masked: false };
  }

  // ---- Pass 1: email addresses -------------------------------------------
  // Built fresh per call so there is no shared lastIndex to reason about.
  const emailMatches = text.match(new RegExp(EMAIL_SOURCE, 'g')) ?? [];
  const emailsFound = [];
  let working = text;

  for (const email of emailMatches) {
    // Literal split/join rather than a regex: it is case-sensitive by design
    // (only the exact matched string is removed) and it replaces every
    // occurrence in one pass.
    working = working.split(email).join(REDACTION);
    if (!emailsFound.some((seen) => seen.toLowerCase() === email.toLowerCase())) {
      emailsFound.push(email);
    }
  }

  // ---- Pass 2: person names ----------------------------------------------
  const matches = nlp(working).people().out('array');

  let redactedText = working;
  const namesFound = [];

  for (const match of matches) {
    const name = (match ?? '').trim();
    if (!isMaskable(name)) continue;

    // Word-bounded and case-insensitive so every occurrence is masked — the
    // same name twice is two leaks, not one — while "Ann" still leaves "Anna"
    // alone.
    const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`, 'gi');
    if (!pattern.test(redactedText)) continue; // already consumed by a longer match
    pattern.lastIndex = 0;

    redactedText = redactedText.replace(pattern, REDACTION);

    if (!namesFound.some((seen) => seen.toLowerCase() === name.toLowerCase())) {
      namesFound.push(name);
    }
  }

  return {
    redactedText,
    namesFound,
    emailsFound,
    masked: namesFound.length > 0 || emailsFound.length > 0,
  };
}

// The preview response shape. Matches are counted but never returned: the caller
// needs to know that something was masked and see the masked text, and the raw
// names and addresses themselves are the sensitive part.
function previewRedaction(title, description) {
  const titleResult = redactNames(title);
  const descriptionResult = redactNames(description);

  // Distinct matches across both fields, so one name repeated in the title and
  // the description is a single flag rather than two.
  const distinct = new Set(
    [
      ...titleResult.namesFound,
      ...titleResult.emailsFound,
      ...descriptionResult.namesFound,
      ...descriptionResult.emailsFound,
    ].map((value) => value.toLowerCase())
  );

  return {
    redactedTitle: titleResult.redactedText,
    redactedDescription: descriptionResult.redactedText,
    flaggedCount: distinct.size,
  };
}

module.exports = { REDACTION, redactNames, previewRedaction };

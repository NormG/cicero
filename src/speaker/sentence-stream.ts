/**
 * Consume a stream of text tokens and yield complete sentences as soon as a
 * boundary appears, flushing any trailing partial sentence when the stream ends.
 *
 * Boundary: `.`, `!`, or `?` followed by whitespace — unless the text before the
 * period ends in a known abbreviation ("Dr.", "e.g.", "a.m."), which would
 * otherwise split mid-phrase and produce a jarring TTS pause. This mirrors the
 * splitter inlined in
 * ActionExecutor.executeLocalLLMStreaming so the local-llm path and the brain
 * path can converge on one implementation.
 *
 * Input tokens must already be free of provider control markup (e.g. <think>
 * blocks) — stripping that is the producer's responsibility.
 */

// Common abbreviations that end in a period but don't end a sentence.
// Single-letter initials ("J. Smith") are deliberately NOT guarded: the guard
// would also buffer legitimate one-letter sentences ("A.") indefinitely, and a
// mis-split initial costs one ~40ms TTS blip while a held sentence costs
// streaming latency.
const ABBREV =
  /(?:\b(?:mr|mrs|ms|dr|prof|st|vs|etc|jr|sr|inc|ltd|co|no|fig|dept|est|approx)|\be\.g|\bi\.e|\ba\.m|\bp\.m)\.$/i;

/** Index just past the next real sentence boundary at/after `from`, or -1. */
function findBoundary(buffer: string, from: number): number {
  const re = /[.!?](?=\s)/g;
  re.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = re.exec(buffer))) {
    const end = m.index + 1;
    if (!ABBREV.test(buffer.slice(0, end))) return end;
  }
  return -1;
}

// Hard ceiling in case the model never emits a recognized `.!?` boundary
// (e.g. a run-on line, a missing period between clauses, or a list rendered
// without terminal punctuation). Without this, an unbounded buffer can reach
// pocket-tts as a single oversized chunk — its own internal chunker has a
// ~50-token budget and can run away generating past it without ever hitting
// an end-of-sequence token, hanging until the inference watchdog kills and
// restarts the whole TTS process (dropping whatever turn was in flight).
// ~200 chars keeps every segment comfortably under that budget.
const MAX_SEGMENT_CHARS = 200;

/** Index just past a forced split point when the buffer has grown too long
 * without a natural sentence boundary, or -1 if under the cap. Prefers the
 * last whitespace before the cap so words aren't split mid-word. */
function findFallbackBoundary(buffer: string): number {
  if (buffer.length < MAX_SEGMENT_CHARS) return -1;
  const idx = buffer.lastIndexOf(" ", MAX_SEGMENT_CHARS);
  return idx > 0 ? idx + 1 : MAX_SEGMENT_CHARS;
}

export async function* segmentSentences(
  tokens: AsyncIterable<string>,
): AsyncGenerator<string> {
  let buffer = "";
  for await (const token of tokens) {
    buffer += token;
    let end = findBoundary(buffer, 0);
    if (end === -1) end = findFallbackBoundary(buffer);
    while (end !== -1) {
      const sentence = buffer.slice(0, end).trim();
      buffer = buffer.slice(end).replace(/^\s+/, "");
      if (sentence) yield sentence;
      end = findBoundary(buffer, 0);
      if (end === -1) end = findFallbackBoundary(buffer);
    }
  }
  const remaining = buffer.trim();
  if (remaining) yield remaining;
}

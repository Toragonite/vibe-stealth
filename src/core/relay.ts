/**
 * RelayEngine (docs/CONTRACT.md §3) — pure, one instance per followed game.
 *
 * No IO, no timers, and it never throws: providers are the hostile boundary and
 * a shape surprise that slips past them must degrade to "skip that event", not
 * to a dead poll loop (§7).
 */

import type {
  Game,
  PlayEvent,
  PlaySnapshot,
  RelayEmission,
  RelayEngine,
  RelayEngineOptions,
  RelayLocale,
} from './contract';
import { t } from './i18n';
import { clampInt, normalizeWs } from './util';

/** Matches the pinned clamp of the `vibeStealth.backfillLimit` setting. */
const BACKFILL_MIN = 0;
const BACKFILL_MAX = 100;
const BACKFILL_DEFAULT = 10;

const NO_SCORE = '–';

interface Candidate {
  event: PlayEvent;
  /** Whitespace-normalized text — the identity used for correction detection. */
  norm: string;
}

export function createRelayEngine(options: RelayEngineOptions): RelayEngine {
  const backfillLimit = clampInt(options.backfillLimit, BACKFILL_MIN, BACKFILL_MAX, BACKFILL_DEFAULT);
  const locale: RelayLocale = options.locale === 'ko' ? 'ko' : 'en';

  /** id → last emitted normalized text. */
  const emitted = new Map<string, string>();
  /** ids that have already spent their single correction (§3.4). */
  const corrected = new Set<string>();
  let lastGame: Game | undefined;
  let firstIngestDone = false;
  let finalLineEmitted = false;

  function ingest(snapshot: PlaySnapshot): RelayEmission {
    const game = snapshot.game;
    const incoming = Array.isArray(snapshot.events) ? snapshot.events : [];

    const seenThisSnapshot = new Set<string>();
    const fresh: Candidate[] = [];
    const corrections: PlayEvent[] = [];
    // "previous max + 1" for a non-finite sequence; a leading non-finite gets 0.
    let runningMax = -1;

    for (const raw of incoming) {
      if (raw === null || typeof raw !== 'object') continue;
      const id = typeof raw.id === 'string' ? raw.id : '';
      if (id === '') continue;
      // Duplicate ids inside one snapshot: first wins (§3, weird-input pin).
      if (seenThisSnapshot.has(id)) continue;
      seenThisSnapshot.add(id);

      const text = typeof raw.text === 'string' ? raw.text : '';
      const sequence = Number.isFinite(raw.sequence) ? raw.sequence : runningMax + 1;
      runningMax = Math.max(runningMax, sequence);

      const norm = normalizeWs(text);
      const previous = emitted.get(id);

      if (previous === undefined) {
        fresh.push({ event: { ...raw, sequence }, norm });
      } else if (previous !== norm && !corrected.has(id)) {
        // Uniform for every id. Derived ids embed their text, so a text edit
        // yields a NEW id and this branch is unreachable for them (§3.4) —
        // an emergent property, not a special case.
        corrected.add(id);
        emitted.set(id, norm);
        corrections.push({ ...raw, sequence, kind: 'correction' });
      }
    }

    const events: PlayEvent[] = [];
    const maxSequence = Math.max(0, runningMax);

    if (!firstIngestDone) {
      firstIngestDone = true;
      const sorted = fresh.sort(byCandidate);
      if (sorted.length > backfillLimit) {
        const kept = backfillLimit === 0 ? [] : sorted.slice(-backfillLimit);
        const skipped = sorted.length - kept.length;
        events.push(
          systemLine(game, 'backfill', kept[0]?.event.sequence ?? maxSequence, t(locale, 'backfillSkipped', { n: skipped })),
        );
        for (const candidate of kept) events.push(candidate.event);
      } else {
        for (const candidate of sorted) events.push(candidate.event);
      }
      // Skipped ids are remembered too — they must never re-emit later (§3.2).
      for (const candidate of sorted) emitted.set(candidate.event.id, candidate.norm);
    } else {
      const lines = [...fresh.map((c) => c.event), ...corrections].sort(bySequenceThenId);
      for (const event of lines) events.push(event);
      for (const candidate of fresh) emitted.set(candidate.event.id, candidate.norm);
    }

    // The final line fires on the FIRST ingest seen in phase 'post', whether or
    // not that ingest was a transition (§3.8) — covers following a done game.
    if (game.phase === 'post' && !finalLineEmitted) {
      finalLineEmitted = true;
      const away = definedScore(game.away?.score);
      const home = definedScore(game.home?.score);
      const text =
        away !== undefined || home !== undefined
          ? t(locale, 'finalScore', {
              away: game.away?.abbrev ?? '',
              as: away === undefined ? NO_SCORE : away,
              hs: home === undefined ? NO_SCORE : home,
              home: game.home?.abbrev ?? '',
            })
          : t(locale, 'gameEnded');
      events.push(systemLine(game, 'final', maxSequence, text));
    }

    const previousGame = lastGame;
    const scoreChanged =
      previousGame !== undefined &&
      (sideChanged(previousGame.away?.score, game.away?.score) ||
        sideChanged(previousGame.home?.score, game.home?.score));
    const phaseTransition =
      previousGame !== undefined && previousGame.phase !== game.phase
        ? { from: previousGame.phase, to: game.phase }
        : undefined;
    lastGame = game;

    // Live state passes through untouched — the engine never diffs or emits it
    // (CONTRACT §11); the UI stashes it on the followed entry for the tree.
    return { events, game, scoreChanged, phaseTransition, state: snapshot.state };
  }

  return { ingest };
}

function byCandidate(a: Candidate, b: Candidate): number {
  return bySequenceThenId(a.event, b.event);
}

function bySequenceThenId(a: PlayEvent, b: PlayEvent): number {
  if (a.sequence !== b.sequence) return a.sequence - b.sequence;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function systemLine(game: Game, suffix: string, sequence: number, text: string): PlayEvent {
  return {
    id: `${game.id}:system:${suffix}`,
    gameId: game.id,
    sequence,
    clock: undefined,
    period: undefined,
    text,
    kind: 'system',
    scoreAfter: undefined,
  };
}

/** Value semantics, not shape: NaN / negative / fractional is "unknown". */
function definedScore(score: number | undefined): number | undefined {
  return typeof score === 'number' && Number.isInteger(score) && score >= 0 ? score : undefined;
}

/** §3.6: becoming defined counts; losing definition does not. */
function sideChanged(before: number | undefined, after: number | undefined): boolean {
  const a = definedScore(before);
  const b = definedScore(after);
  if (a === undefined && b === undefined) return false;
  if (a === undefined) return true;
  if (b === undefined) return false;
  return a !== b;
}

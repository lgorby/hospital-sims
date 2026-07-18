import type { EventBus } from '../events';
import type { GameLoop } from '../loop';
import { challengeToQuery } from '../sim/challenge';
import {
  CHALLENGE_DEFS,
  SCORE_METRICS,
  type ChallengeId,
  type ChallengeSpec,
  type ScoreMetricId,
} from '../sim/data/challenges';
import type { DayReport } from '../sim/dailyStats';
import type { ChallengeResult } from './challengeController';
import { appendDailyReportSections } from './dailyReport';
import { money } from './format';
import { modalRow, modalSection } from './modal';
import { PausingOverlay } from './pausingOverlay';

/** Display name for a spec: the built-in label, or the ad-hoc seed. */
function challengeLabel(spec: ChallengeSpec): string {
  if (spec.source === 'builtin' && spec.id !== null && Object.hasOwn(CHALLENGE_DEFS, spec.id)) {
    return CHALLENGE_DEFS[spec.id as ChallengeId].label;
  }
  return `Custom (seed ${spec.scenario.seed})`;
}

/** Format a score for its metric — the display unit is SSOT on the table. */
function formatScore(metric: ScoreMetricId, score: number): string {
  return SCORE_METRICS[metric].unit === 'money' ? money(score) : String(Math.round(score));
}

/** Full shareable URL (grammar SSOT is `challengeToQuery`). */
export function challengeShareUrl(spec: ChallengeSpec): string {
  return `${window.location.origin}${window.location.pathname}?${challengeToQuery(spec)}`;
}

/** One-line claim to share (honor-system §7): the score, or the DNF + bust day. */
function buildShareLine(result: ChallengeResult): string {
  const { spec, outcome, score, context } = result;
  const name = challengeLabel(spec);
  const metricLabel = SCORE_METRICS[spec.goal.metric].label;
  if (outcome === 'reached') {
    const base = `${metricLabel} ${formatScore(spec.goal.metric, score ?? 0)} by day ${spec.goal.day}`;
    if (spec.goal.target !== undefined) {
      const passed = score !== null && score >= spec.goal.target;
      const target = formatScore(spec.goal.metric, spec.goal.target);
      return `Hospital Simms — ${name}: ${base} (${passed ? 'PASSED' : 'missed'} target ${target})`;
    }
    return `Hospital Simms — ${name}: ${base}`;
  }
  return `Hospital Simms — ${name}: DNF (busted day ${context.day})`;
}

/**
 * The challenge outcome section + copyable share box. SHARED (DRY): the result
 * card renders it on `reached`; the game-over screen folds it in on `dnf` (§6),
 * so the outcome/share rendering lives in exactly one place.
 */
export function appendChallengeResult(card: HTMLElement, result: ChallengeResult): void {
  const { spec, outcome, score, context } = result;
  const section = modalSection(card, `Challenge — ${challengeLabel(spec)}`);
  const metricLabel = SCORE_METRICS[spec.goal.metric].label;
  if (outcome === 'reached') {
    // Neutral tone: a raw score isn't inherently good/bad (e.g. a `died` metric)
    // — only a target pass/fail is colored below.
    modalRow(section, `${metricLabel} (day ${spec.goal.day})`, formatScore(spec.goal.metric, score ?? 0));
    if (spec.goal.target !== undefined) {
      const passed = score !== null && score >= spec.goal.target;
      modalRow(
        section,
        `Target ${formatScore(spec.goal.metric, spec.goal.target)}`,
        passed ? 'Reached ✓' : 'Missed ✗',
        passed ? 'good' : 'bad',
      );
    }
  } else {
    modalRow(section, 'Outcome', `DNF — busted on day ${context.day}`, 'bad');
    if (score !== null) {
      modalRow(section, `${metricLabel} at bust`, formatScore(spec.goal.metric, score));
    }
  }
  appendShareBox(card, result);
}

function appendShareBox(card: HTMLElement, result: ChallengeResult): void {
  const box = document.createElement('div');
  box.className = 'share-box';

  const line = document.createElement('div');
  line.className = 'share-line';
  line.textContent = buildShareLine(result);

  const url = document.createElement('div');
  url.className = 'share-url';
  const shareUrl = challengeShareUrl(result.spec);
  url.textContent = shareUrl;

  const copy = document.createElement('button');
  copy.className = 'share-copy';
  copy.textContent = 'Copy challenge link';
  copy.setAttribute('data-ui', '');
  copy.addEventListener('click', () => {
    // Only claim success when the copy actually happened. The URL stays visible
    // + selectable (user-select: all), so an unavailable/denied clipboard
    // (insecure context) falls back to manual copy honestly.
    const clip = navigator.clipboard;
    if (!clip) {
      copy.textContent = 'Select the link above to copy';
      return;
    }
    clip.writeText(shareUrl).then(
      () => (copy.textContent = 'Copied!'),
      () => (copy.textContent = 'Select the link above to copy'),
    );
  });

  box.append(line, url, copy);
  card.appendChild(box);
}

/**
 * Reached-terminal result overlay (plan §6). Opened by the
 * `MidnightModalCoordinator` in place of the daily report at `goal.day`; owns
 * the clock like the daily modal (pause on open, restore on Continue) — it is a
 * `.modal-overlay`, so keyboard speed shortcuts stay suppressed while it shows.
 * (DNF results fold into the game-over screen instead — not this card.)
 */
export class ChallengeResultCard extends PausingOverlay {
  constructor(
    loop: GameLoop,
    private events: EventBus,
  ) {
    super(loop);
  }

  mount(parent: HTMLElement): void {
    this.buildShell(parent, 'challengeresult');
    // Defensive (no-overlapping-overlays rule): foreclosure trumps a lingering
    // result card. In practice a reached card pauses the sim, so bankruptcy
    // cannot fire underneath it — this guarantees it regardless.
    this.events.on('gameOver', () => this.hide());
  }

  open(result: ChallengeResult, report: DayReport): void {
    this.show();
    this.render(result, report);
  }

  private render(result: ChallengeResult, report: DayReport): void {
    this.card.replaceChildren();
    const title = document.createElement('h2');
    title.textContent = 'Challenge Complete';
    this.card.appendChild(title);

    appendChallengeResult(this.card, result);
    // Embed the goal-day numbers so nothing is lost (the daily report yielded).
    appendDailyReportSections(this.card, report);

    const cont = document.createElement('button');
    cont.textContent = 'Continue';
    cont.className = 'modal-continue';
    cont.setAttribute('data-ui', '');
    cont.addEventListener('click', () => this.closeAndResume());
    this.card.appendChild(cont);
  }
}

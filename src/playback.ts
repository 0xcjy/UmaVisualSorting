import { generate } from './algorithms';
import type { Algorithm, PlaybackState, SortStep } from './contracts';

const REFERENCE_ORDER = [3, 1, 5, 2, 6, 4];
const SWAP_DURATION = 0.85;
const LANDING_DURATION = 0.55;
const CELEBRATION_DURATION = 5;

export class Playback {
  readonly state: PlaybackState;
  onStep: ((step: SortStep, animated: boolean) => void) | null = null;
  onLand: (() => void) | null = null;

  private steps: SortStep[] = [];
  private initialOrder = REFERENCE_ORDER.slice();
  private generator: Generator<SortStep>;
  private elapsed = 0;
  private singleStepAnimation = false;

  constructor() {
    this.generator = generate('quick', this.initialOrder);
    const first = this.generator.next();
    if (first.done) throw new Error('排序轨迹不能为空。');
    this.steps.push(first.value);
    this.state = {
      algorithm: 'quick', step: first.value, index: 0, count: 1,
      playing: false, speed: 1, elementCount: REFERENCE_ORDER.length,
      exhausted: first.value.kind === 'complete', transition: 0,
      animating: false, landing: 0, idleTime: 0, celebrationTime: 0,
      delta: 0, revision: 1,
    };
    this.materializeFiniteTrace();
  }

  tick(dt: number): void {
    const state = this.state;
    state.delta = 0;
    if (!Number.isFinite(dt) || dt <= 0) return;
    const duration = dt * state.speed;
    const performanceRunning = state.playing || this.singleStepAnimation;
    const celebrating = state.step.kind === 'complete'
      && state.celebrationTime < CELEBRATION_DURATION;
    if (performanceRunning || celebrating) {
      state.delta = celebrating && !performanceRunning
        ? Math.min(duration, CELEBRATION_DURATION - state.celebrationTime)
        : duration;
      state.idleTime += state.delta;
      if (state.step.kind === 'complete') {
        state.celebrationTime = Math.min(CELEBRATION_DURATION,
          state.celebrationTime + state.delta);
      }
    }

    if (state.animating && performanceRunning) {
      state.transition = Math.min(1, state.transition + duration / SWAP_DURATION);
      if (state.transition >= 1) {
        state.animating = false;
        state.landing = LANDING_DURATION;
        const revision = state.revision;
        this.onLand?.();
        // A callback may interrupt the transition with reset/seek/another step.
        if (state.revision !== revision) return;
      }
    } else if (state.landing > 0 && performanceRunning) {
      state.landing = Math.max(0, state.landing - duration);
      if (state.landing === 0) this.singleStepAnimation = false;
    }

    if (!state.playing) return;
    this.elapsed += duration;
    const hold = state.step.kind === 'compare' ? 1.35
      : state.step.kind === 'swap' ? SWAP_DURATION + LANDING_DURATION
        : state.step.kind === 'partition' ? 1.1 : 0.7;
    if (!state.animating && state.landing === 0 && this.elapsed >= hold) {
      // Advance only one event per frame, including Bogo: never enumerate its
      // unbounded trace or attempt to catch up a long background-tab frame.
      if (state.index + 1 < this.steps.length || this.appendStep()) this.setStep(state.index + 1, true);
      else {
        state.playing = false;
        this.singleStepAnimation = false;
      }
    }
  }

  toggle(): void {
    if (this.state.step.kind === 'complete') this.setStep(0, false);
    this.state.playing = !this.state.playing;
    this.singleStepAnimation = false;
    this.elapsed = 0;
    this.state.delta = 0;
  }

  next(): void {
    this.state.playing = false;
    this.state.delta = 0;
    if (this.state.index + 1 < this.steps.length || this.appendStep()) this.setStep(this.state.index + 1, true);
  }

  previous(): void {
    this.state.playing = false;
    this.setStep(Math.max(0, this.state.index - 1), false);
  }

  reset(): void {
    this.resetTo(this.referenceOrder());
  }

  shuffle(): void {
    const order = this.referenceOrder();
    for (let n = order.length - 1; n > 0; n--) {
      const other = Math.floor(Math.random() * (n + 1));
      const value = order[n];
      order[n] = order[other];
      order[other] = value;
    }
    this.resetTo(order);
  }

  setAlgorithm(algorithm: Algorithm): void {
    this.state.algorithm = algorithm;
    this.resetTo(this.initialOrder);
  }

  setElementCount(count: number): void {
    if (!Number.isFinite(count)) return;
    count = Math.max(2, Math.min(12, Math.round(count)));
    if (count === this.state.elementCount) return;
    this.state.elementCount = count;
    this.state.idleTime = 0;
    this.reset();
  }

  setSpeed(speed: number): void {
    if (Number.isFinite(speed)) this.state.speed = Math.max(0.25, Math.min(3, speed));
  }

  seek(normalized: number): void {
    if (!Number.isFinite(normalized)) return;
    const fraction = Math.max(0, Math.min(1, normalized));
    this.jumpToStep(Math.round(fraction * (this.steps.length - 1)));
  }

  jumpToStep(index: number): void {
    if (!Number.isFinite(index)) return;
    this.state.playing = false;
    this.setStep(Math.max(0, Math.min(this.steps.length - 1, Math.round(index))), false);
  }

  private referenceOrder(): number[] {
    if (this.state.elementCount === REFERENCE_ORDER.length) return REFERENCE_ORDER.slice();
    return Array.from({ length: this.state.elementCount }, (_, slot) => this.state.elementCount - slot);
  }

  private resetTo(order: readonly number[]): void {
    this.generator.return(undefined);
    this.initialOrder = order.slice();
    this.generator = generate(this.state.algorithm, this.initialOrder);
    this.steps = [];
    this.state.playing = false;
    this.singleStepAnimation = false;
    this.state.exhausted = false;
    this.appendStep();
    this.materializeFiniteTrace();
    this.setStep(0, false);
  }

  private materializeFiniteTrace(): void {
    if (this.state.algorithm !== 'bogo') {
      while (!this.state.exhausted) this.appendStep();
    }
  }

  private appendStep(): boolean {
    if (this.state.exhausted) return false;
    const result = this.generator.next();
    if (result.done) {
      this.state.exhausted = true;
      return false;
    }
    this.steps.push(result.value);
    this.state.count = this.steps.length;
    this.state.exhausted = result.value.kind === 'complete';
    return true;
  }


  private setStep(index: number, animated: boolean): void {
    const state = this.state;
    const step = this.steps[index];
    this.elapsed = 0;
    state.index = index;
    state.step = step;
    state.transition = animated && step.kind === 'swap' ? 0 : 1;
    state.animating = animated && step.kind === 'swap';
    this.singleStepAnimation = state.animating && !state.playing;
    state.landing = step.kind === 'swap' && !state.animating ? LANDING_DURATION : 0;
    state.celebrationTime = 0;
    state.delta = 0;
    state.revision++;
    this.onStep?.(step, animated);
  }
}

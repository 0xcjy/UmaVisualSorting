import { ALGORITHMS } from './algorithms';
import type { Algorithm, AudioSettings, PlaybackState, StageProjection } from './contracts';

export interface UIActions {
  toggle(): void;
  next(): void;
  previous(): void;
  reset(): void;
  shuffle(): void;
  setAlgorithm(algorithm: Algorithm): void;
  setElementCount(count: number): void;
  setSpeed(speed: number): void;
  seek(normalized: number): void;
  setPhysics(enabled: boolean): void;
  setAudio(key: keyof AudioSettings, value: number | boolean): void;
  fullscreen(): void;
}
const PALETTE = ['#ef85aa', '#f6b06a', '#ebc84c', '#70c08c', '#65add8', '#a685e3'];
const color = (value: number) => PALETTE[(value - 1) % PALETTE.length];
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent: HTMLElement, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  parent.append(node);
  return node;
}
function syntax(row: HTMLElement, source: string): void {
  const tokens = /\b(def|if|for|in|return|while|break|True|False|not)\b|\b(quick|insertion|bubble|selection|bogo|range|len|random|randrange)\b|\b\d+\b/g;
  let offset = 0;
  for (const match of source.matchAll(tokens)) {
    row.append(document.createTextNode(source.slice(offset, match.index)));
    element('span', match[1] ? 'syntax-keyword' : match[2] ? 'syntax-function' : 'syntax-number', row, match[0]);
    offset = match.index! + match[0].length;
  }
  row.append(document.createTextNode(source.slice(offset)));
}
interface ActorUI { badge: HTMLDivElement; number: HTMLSpanElement; crown: HTMLSpanElement; star: HTMLSpanElement; shadow: HTMLDivElement; }

export class UI {
  readonly canvas: HTMLCanvasElement;
  private readonly container: HTMLDivElement;
  private readonly scene: HTMLDivElement;
  private readonly episode: HTMLParagraphElement;
  private readonly title: HTMLHeadingElement;
  private readonly english: HTMLParagraphElement;
  private readonly description: HTMLParagraphElement;
  private readonly select: HTMLSelectElement;
  private readonly code: HTMLOListElement;
  private readonly rangeStat: HTMLElement;
  private readonly compareStat: HTMLElement;
  private readonly swapStat: HTMLElement;
  private readonly indexBadge: HTMLElement;
  private readonly play: HTMLButtonElement;
  private readonly previous: HTMLButtonElement;
  private readonly next: HTMLButtonElement;
  private readonly count: HTMLInputElement;
  private readonly countOutput: HTMLOutputElement;
  private readonly speed: HTMLInputElement;
  private readonly speedOutput: HTMLOutputElement;
  private readonly progress: HTMLInputElement;
  private readonly position: HTMLElement;
  private readonly status: HTMLElement;
  private readonly loading: HTMLElement;
  private readonly dots: HTMLElement;
  private readonly bracket: HTMLElement;
  private readonly rangePill: HTMLElement;
  private readonly comparison: HTMLElement;
  private readonly compareBubble: HTMLElement;
  private readonly compareLine: HTMLElement;
  private readonly confetti: HTMLElement[] = [];
  private readonly actors: ActorUI[] = [];
  private readonly pads: HTMLElement[] = [];
  private readonly bars: HTMLElement[] = [];
  private readonly barNumbers: HTMLElement[] = [];
  private readonly barStars: HTMLElement[] = [];
  private readonly events = new AbortController();
  private shownAlgorithm: Algorithm | null = null;
  private lastRevision = -1;
  private lastPlaying: boolean | null = null;
  private loadingMessage: string | null = null;
  private readonly reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

  constructor(root: HTMLElement, private readonly actions: UIActions) {
    this.container = element('div', 'sorting-app', root);
    const left = element('section', 'stage-column', this.container);
    left.setAttribute('aria-label', '排序角色舞台');
    const header = element('header', 'stage-header', left);
    for (let n = 0; n < 4; n++) element('i', `header-bubble bubble-${n}`, header).setAttribute('aria-hidden', 'true');
    this.episode = element('p', 'episode', header);
    this.title = element('h1', 'algorithm-title', header);
    this.english = element('p', 'english-title', header);
    const algorithmLabel = element('label', 'algorithm-select-wrap', header);
    element('span', 'sr-only', algorithmLabel, '选择排序算法');
    this.select = element('select', 'algorithm-select', algorithmLabel);
    this.select.setAttribute('aria-label', '选择排序算法');
    for (const [key, metadata] of Object.entries(ALGORITHMS)) {
      const option = element('option', '', this.select, `${metadata.name} · ${metadata.english}`);
      option.value = key;
    }
    this.select.addEventListener('change', () => actions.setAlgorithm(this.select.value as Algorithm), { signal: this.events.signal });
    this.scene = element('div', 'stage-scene', left);
    const scenery = element('div', 'stage-scenery', this.scene);
    scenery.setAttribute('aria-hidden', 'true');
    for (let n = 0; n < 4; n++) element('i', `soft-tree tree-${n}`, scenery);
    for (let n = 0; n < 16; n++) {
      const petal = element('i', 'flower-petal', scenery);
      petal.style.left = `${(n * 37 + 5) % 100}%`;
      petal.style.top = `${42 + (n * 19) % 52}%`;
      petal.style.transform = `scale(${0.5 + (n % 3) * 0.3}) rotate(${n * 37}deg)`;
    }
    const ground = element('div', 'stage-ground', this.scene);
    ground.setAttribute('aria-hidden', 'true');
    for (let n = 0; n < 12; n++) {
      this.pads.push(element('div', 'slot-pad', ground));
      this.pads[n].hidden = true;
      const shadow = element('div', 'actor-shadow', ground);
      const badge = element('div', 'actor-badge', this.scene);
      shadow.hidden = true; badge.hidden = true;
      const number = element('span', 'actor-number', badge, String(n + 1));
      const crown = element('span', 'actor-crown', badge);
      crown.setAttribute('aria-hidden', 'true');
      const star = element('span', 'actor-star', badge, '✦');
      star.setAttribute('aria-hidden', 'true');
      this.actors.push({ badge, number, crown, star, shadow });
    }
    this.canvas = element('canvas', 'character-canvas', this.scene);
    this.canvas.setAttribute('aria-label', '以真实角色动画展示排序过程');
    this.dots = element('div', 'ground-dots', this.scene);
    this.dots.setAttribute('aria-hidden', 'true');
    this.dots.hidden = true;
    this.bracket = element('div', 'range-bracket', this.scene);
    this.bracket.hidden = true;
    this.rangePill = element('span', 'range-pill', this.bracket);
    this.comparison = element('div', 'comparison-guide', this.scene);
    this.comparison.hidden = true;
    this.compareLine = element('div', 'comparison-line', this.comparison);
    this.compareBubble = element('div', 'comparison-bubble', this.comparison);
    const celebration = element('div', 'confetti-layer', this.scene);
    celebration.setAttribute('aria-hidden', 'true');
    for (let n = 0; n < 84; n++) {
      const piece = element('i', n % 3 === 0 ? 'confetti ribbon' : 'confetti', celebration);
      piece.hidden = true;
      piece.style.backgroundColor = PALETTE[n % 6];
      this.confetti.push(piece);
    }
    this.loading = element('div', 'loading-message', this.scene);
    this.loading.setAttribute('role', 'status');
    this.loading.hidden = true;

    const right = element('section', 'workbench', this.container);
    right.setAttribute('aria-label', '算法与播放控制');
    const card = element('section', 'algorithm-card', right);
    card.setAttribute('aria-label', '数组与代码同步演示');
    const stats = element('div', 'card-stats', card);
    const stat = (label: string) => { const node = element('span', 'stat', stats); node.append(`${label} `); return element('strong', '', node, '0'); };
    this.rangeStat = stat('区间');
    this.compareStat = stat('比较');
    this.swapStat = stat('交换');
    this.indexBadge = element('span', 'index-badge', stats);
    const body = element('div', 'card-body', card);
    const chart = element('div', 'bar-chart', body);
    chart.setAttribute('role', 'img');
    chart.setAttribute('aria-label', '当前数组');
    for (let n = 0; n < 12; n++) {
      const bar = element('div', 'value-bar', chart);
      bar.hidden = true;
      this.barStars.push(element('span', 'bar-star', bar, '✦'));
      this.barNumbers.push(element('span', 'bar-number', bar));
      this.bars.push(bar);
    }
    const codeScroll = element('div', 'code-scroll', body);
    codeScroll.tabIndex = 0;
    codeScroll.setAttribute('aria-label', '算法代码，可横向滚动');
    this.code = element('ol', 'algorithm-code', codeScroll);
    this.description = element('p', 'algorithm-description', right);
    const settings = element('div', 'sort-settings', right);
    const countSlider = this.slider(settings, '数量', '2', '12', '1', '6');
    this.count = countSlider.input; this.countOutput = countSlider.output;
    this.count.addEventListener('input', () => actions.setElementCount(Number(this.count.value)), { signal: this.events.signal });
    const speedSlider = this.slider(settings, '速度', '0.25', '3', '0.05', '1');
    this.speed = speedSlider.input; this.speedOutput = speedSlider.output;
    this.speed.addEventListener('input', () => actions.setSpeed(Number(this.speed.value)), { signal: this.events.signal });
    const controls = element('div', 'playback-controls', right);
    this.previous = this.button(controls, '上一步', '←', actions.previous, '上一步（左方向键）');
    this.play = this.button(controls, '播放', '▶', actions.toggle, '播放或暂停（空格键）');
    this.play.classList.add('primary-button');
    this.next = this.button(controls, '单步', '→', actions.next, '下一步（右方向键）');
    this.button(controls, '重置', '↺', actions.reset, '重置当前排序');
    this.button(controls, '打乱', '⤨', actions.shuffle, '随机打乱数组');
    const timeline = element('div', 'timeline', right);
    this.progress = element('input', 'progress-slider', timeline);
    this.progress.type = 'range'; this.progress.min = '0'; this.progress.max = '1'; this.progress.step = 'any'; this.progress.value = '0';
    this.progress.setAttribute('aria-label', '排序进度');
    this.progress.addEventListener('input', () => actions.seek(Number(this.progress.value)), { signal: this.events.signal });
    this.position = element('output', 'step-position', timeline);
    this.status = element('p', 'playback-status', right);
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    const tools = element('div', 'utility-controls', right);
    const physicsLabel = element('label', 'toggle-control', tools);
    const physics = element('input', '', physicsLabel);
    physics.type = 'checkbox'; physics.checked = true;
    element('span', '', physicsLabel, '头发 / 耳朵 / 尾巴物理');
    physics.addEventListener('change', () => actions.setPhysics(physics.checked), { signal: this.events.signal });
    this.button(tools, '全屏', '⛶', actions.fullscreen, '切换全屏');
    const audio = element('details', 'audio-settings', right);
    element('summary', '', audio, '声音设置');
    const soundControls = element('div', 'audio-grid', audio);
    const defaults: AudioSettings = { master: 0.7, voice: 0.75, effects: 0.3, music: 0.28, muted: false };
    for (const [key, label] of [['master', '总音量'], ['voice', '角色语音'], ['effects', '排序音效'], ['music', '背景音乐']] as const) {
      const control = this.slider(soundControls, label, '0', '1', '0.01', String(defaults[key]));
      control.output.value = `${Math.round(defaults[key] * 100)}%`;
      control.input.addEventListener('input', () => {
        const value = Number(control.input.value);
        control.output.value = `${Math.round(value * 100)}%`;
        actions.setAudio(key, value);
      }, { signal: this.events.signal });
    }
    const muteLabel = element('label', 'toggle-control mute-toggle', soundControls);
    const mute = element('input', '', muteLabel); mute.type = 'checkbox';
    element('span', '', muteLabel, '静音');
    mute.addEventListener('change', () => actions.setAudio('muted', mute.checked), { signal: this.events.signal });
    element('p', 'keyboard-hint', right, '空格 播放 / 暂停 · ← 上一步 · → 单步');
    document.addEventListener('keydown', this.onKey, { signal: this.events.signal });
  }

  render(state: PlaybackState, projection: StageProjection): void {
    const step = state.step;
    const complete = step.kind === 'complete';
    if (this.shownAlgorithm !== state.algorithm) {
      this.shownAlgorithm = state.algorithm;
      const metadata = ALGORITHMS[state.algorithm];
      this.episode.textContent = `ALGORITHM · EP.${String(metadata.episode).padStart(2, '0')}`;
      this.title.textContent = metadata.name;
      this.english.textContent = metadata.english;
      this.description.textContent = metadata.description;
      this.select.value = state.algorithm;
      this.code.replaceChildren();
      for (const source of metadata.code) syntax(element('li', 'code-row', this.code), source);
    }
    if (this.lastRevision !== state.revision) {
      this.lastRevision = state.revision;
      this.rangeStat.textContent = complete ? '✓' : step.lo >= 0 && step.hi >= step.lo ? `${step.lo}–${step.hi}` : '—';
      this.compareStat.textContent = String(step.comparisons);
      this.swapStat.textContent = String(step.swaps);
      this.indexBadge.hidden = complete || step.pivotIndex < 0;
      const showI = step.kind === 'advance' || step.kind === 'swap';
      this.indexBadge.textContent = state.algorithm !== 'quick' ? `j = ${step.j}` : showI ? `i = ${step.i}` : `p = ${step.pivotValue}`;
      this.indexBadge.classList.toggle('advance-badge', showI);
      this.status.textContent = step.message;
      this.status.classList.toggle('complete-status', complete);
      for (let n = 0; n < this.code.children.length; n++) {
        const row = this.code.children[n];
        row.classList.toggle('active-code', n === step.codeLine);
        if (n === step.codeLine) row.setAttribute('aria-current', 'step'); else row.removeAttribute('aria-current');
      }
      for (let n = 0; n < 12; n++) {
        const visible = n < step.values.length;
        this.bars[n].hidden = !visible;
        if (!visible) continue;
        const value = step.values[n];
        this.bars[n].style.height = `${8 + 84 * value / state.elementCount}%`;
        this.bars[n].style.setProperty('--value-color', color(value));
        this.bars[n].classList.toggle('sorted-bar', step.sorted[n]);
        this.barNumbers[n].textContent = String(value);
        this.barStars[n].hidden = !step.sorted[n];
      }
      this.bars[0].parentElement!.setAttribute('aria-label', `当前数组：${step.values.join('、')}`);
    }
    if (this.lastPlaying !== state.playing) {
      this.lastPlaying = state.playing;
      this.play.children[0].textContent = state.playing ? 'Ⅱ' : '▶';
      this.play.children[1].textContent = state.playing ? '暂停' : '播放';
      this.play.setAttribute('aria-pressed', String(state.playing));
    }
    this.previous.disabled = state.index <= 0;
    this.next.disabled = state.exhausted && state.index >= state.count - 1;
    this.count.value = String(state.elementCount); this.countOutput.value = String(state.elementCount);
    this.speed.value = String(state.speed); this.speedOutput.value = `${state.speed.toFixed(2).replace(/0$/, '')}×`;
    this.progress.disabled = state.count <= 1;
    this.progress.value = String(state.count > 1 ? state.index / (state.count - 1) : 0);
    this.progress.setAttribute('aria-valuetext', `第 ${state.index + 1} 步，共 ${state.count} 步${state.exhausted ? '' : '，仍在生成'}`);
    this.position.textContent = `${state.index + 1} / ${state.count}${state.exhausted ? '' : '+'}`;
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    const scale = Math.min(1, 6 / state.elementCount) * Math.min(1.3, width / 608);
    const badgeSize = Math.max(18, 42 * scale);
    const spacing = projection.slots.length > 1 ? Math.abs(projection.slots[1] - projection.slots[0]) : width / 2;
    const padWidth = Math.min(spacing * 0.85, width * 0.13);
    for (let n = 0; n < this.pads.length; n++) {
      this.pads[n].hidden = n >= projection.slots.length;
      if (n >= projection.slots.length) continue;
      const pad = this.pads[n];
      pad.style.left = `${projection.slots[n]}px`; pad.style.top = `${projection.groundY + 6}px`;
      pad.style.width = `${padWidth}px`; pad.style.height = `${Math.max(5, padWidth * 0.25)}px`;
      pad.style.backgroundColor = color(n + 1);
    }
    for (const actor of this.actors) { actor.badge.hidden = true; actor.shadow.hidden = true; }
    for (const actor of projection.actors) {
      const ui = this.actors[actor.value - 1];
      if (!ui) continue;
      const slot = step.values.indexOf(actor.value);
      const pivot = !complete && step.pivotValue === actor.value && step.pivotIndex >= 0;
      const active = step.kind === 'compare' && (slot === step.j || pivot) || step.kind === 'swap' && (slot === step.swapA || slot === step.swapB);
      ui.badge.hidden = false;
      ui.badge.style.left = `${actor.x}px`; ui.badge.style.top = `${actor.y}px`;
      ui.badge.style.width = `${badgeSize}px`; ui.badge.style.height = `${badgeSize}px`;
      ui.badge.style.fontSize = `${badgeSize * 0.52}px`;
      ui.badge.style.setProperty('--value-color', color(actor.value));
      ui.badge.classList.toggle('active-actor', active || pivot);
      ui.crown.hidden = !pivot; ui.star.hidden = !step.sorted[slot] || pivot;
      ui.shadow.hidden = false;
      ui.shadow.style.left = `${actor.groundX}px`; ui.shadow.style.top = `${actor.groundY - 3}px`;
      ui.shadow.style.width = `${actor.shadowWidth}px`;
      ui.shadow.style.height = `${Math.max(4, actor.shadowWidth * 0.17)}px`;
      ui.shadow.style.opacity = String(Math.max(0.03, 0.13 / (1 + actor.lift * 2)));
    }
    this.dots.hidden = projection.actors.length === 0;
    this.dots.style.top = `${Math.min(height - 14, projection.groundY + 36 * width / 608)}px`;
    this.bracket.hidden = projection.actors.length === 0 || complete || step.lo < 0 || step.hi < step.lo;
    if (!this.bracket.hidden) {
      this.bracket.style.left = `${projection.rangeLeft}px`;
      this.bracket.style.width = `${Math.max(0, projection.rangeRight - projection.rangeLeft)}px`;
      this.bracket.style.top = `${Math.min(height - 39, projection.groundY + 57 * width / 608)}px`;
      this.rangePill.textContent = state.algorithm === 'quick' ? `quick(${step.lo}, ${step.hi})` : `区间 ${step.lo}–${step.hi}`;
    }
    this.comparison.hidden = true;
    if ((step.kind === 'compare' || step.kind === 'advance') && step.j >= 0 && step.pivotIndex >= 0) {
      const tested = projection.actors.find(actor => actor.value === step.values[step.j]);
      const other = projection.actors.find(actor => actor.value === step.values[step.pivotIndex]);
      if (tested && other) {
        this.comparison.hidden = false;
        const smaller = tested.value < other.value;
        const relation = state.algorithm === 'bubble' ? tested.value > other.value ? '>' : '≤' : smaller ? '<' : '≥';
        this.compareBubble.textContent = relation;
        this.comparison.classList.toggle('positive-comparison', relation === '<' || relation === '≤');
        this.compareBubble.style.left = `${Math.max(26, Math.min(width - 26, (tested.x + other.x) * 0.5))}px`;
        this.compareBubble.style.top = `${Math.max(27, Math.min(tested.y, other.y) - badgeSize * 1.3)}px`;
        this.compareLine.style.left = `${Math.min(tested.x, other.x)}px`;
        this.compareLine.style.top = `${Math.min(tested.y, other.y) + badgeSize * 0.6}px`;
        this.compareLine.style.width = `${Math.abs(tested.x - other.x)}px`;
      }
    }
    this.renderConfetti(complete ? state.celebrationTime : 5, width, height);
  }

  setLoading(message: string | null): void {
    this.loadingMessage = message;
    this.loading.hidden = message === null;
    this.loading.textContent = message;
    this.scene.setAttribute('aria-busy', String(message !== null));
  }

  dispose(): void { this.events.abort(); this.container.remove(); }

  private readonly onKey = (event: KeyboardEvent): void => {
    if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.isComposing || this.loadingMessage !== null) return;
    const target = event.target;
    if (target instanceof HTMLElement && target.closest('input,select,textarea,button,summary,[contenteditable="true"]')) return;
    if (event.code === 'Space') { event.preventDefault(); this.actions.toggle(); }
    else if (event.code === 'ArrowLeft' && !this.previous.disabled) { event.preventDefault(); this.actions.previous(); }
    else if (event.code === 'ArrowRight' && !this.next.disabled) { event.preventDefault(); this.actions.next(); }
  };

  private button(parent: HTMLElement, label: string, icon: string, action: () => void, accessibleLabel: string): HTMLButtonElement {
    const button = element('button', 'soft-button', parent);
    button.type = 'button'; button.setAttribute('aria-label', accessibleLabel); button.title = accessibleLabel;
    element('span', 'button-icon', button, icon).setAttribute('aria-hidden', 'true');
    element('span', '', button, label);
    button.addEventListener('click', () => action(), { signal: this.events.signal });
    return button;
  }

  private slider(parent: HTMLElement, label: string, min: string, max: string, step: string, value: string): { input: HTMLInputElement; output: HTMLOutputElement } {
    const wrapper = element('label', 'slider-control', parent);
    const caption = element('span', 'slider-caption', wrapper, label);
    const output = element('output', '', caption, value);
    const input = element('input', '', wrapper);
    input.type = 'range'; input.min = min; input.max = max; input.step = step; input.value = value;
    input.setAttribute('aria-label', label);
    return { input, output };
  }

  private renderConfetti(time: number, width: number, height: number): void {
    const hidden = this.reducedMotion.matches || time >= 5;
    for (let n = 0; n < this.confetti.length; n++) {
      const piece = this.confetti[n];
      const age = time - (n < 18 ? 0 : ((n * 17) % 55) / 100);
      const lifetime = 3.75 + ((n * 11) % 70) / 100;
      piece.hidden = hidden || age < 0 || age >= lifetime;
      if (piece.hidden) continue;
      const ribbon = n % 3 === 0;
      const sign = n % 2 === 0 ? 1 : -1;
      const phase = n * 2.399;
      const wave = phase + age * (3.5 + n % 4);
      const x = (ribbon ? sign > 0 ? 10 : 598 : 24 + (n * 43) % 560) + (ribbon ? sign * (140 + n % 70) : (n % 90) - 45) * age / (1 + 0.4 * age) + (9 + n % 16) * (Math.sin(wave) - Math.sin(phase));
      const y = (ribbon ? 55 + n % 120 : 6 + n % 40) + (ribbon ? -25 + n % 40 : 65 + n % 55) * age + (ribbon ? 27.5 : 16) * age * age;
      piece.style.transform = `translate(${x * width / 608}px, ${y * height / 510}px) rotate(${n * 37 + sign * (95 + n % 160) * age}deg) scaleX(${0.18 + 0.82 * Math.abs(Math.cos(wave))})`;
      piece.style.opacity = String(Math.min(1, (age + 0.06) / 0.15, (lifetime - age) / 0.65));
    }
  }
}

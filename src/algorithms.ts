import type { Algorithm, SortStep, StepKind } from './contracts';

interface AlgorithmMetadata {
  name: string;
  english: string;
  episode: number;
  description: string;
  code: string[];
}

export const ALGORITHMS: Record<Algorithm, AlgorithmMetadata> = {
  quick: {
    name: '快速排序', english: 'Quick Sort', episode: 1,
    description: '以末尾元素为枢轴，将较小元素移到左侧，再递归排序两边；枢轴就位后标绿。',
    code: [
      'def quick(a, lo, hi):',
      '  if lo >= hi: return',
      '  p, i = a[hi], lo',
      '  for j in range(lo, hi):',
      '    if a[j] < p:',
      '      a[i], a[j] = a[j], a[i]',
      '      i += 1',
      '  a[i], a[hi] = a[hi], a[i]',
      '  quick(a, lo, i - 1)',
      '  quick(a, i + 1, hi)',
    ],
  },
  insertion: {
    name: '插入排序', english: 'Insertion Sort', episode: 2,
    description: '用稳定的相邻交换将新元素插入有序前缀，每一步都保留所有角色；前缀仍可能移动，完成前不标绿。',
    code: [
      'def insertion(a):',
      '  for end in range(1, len(a)):',
      '    j = end',
      '    while j > 0:',
      '      if a[j] >= a[j - 1]: break',
      '      a[j - 1], a[j] = a[j], a[j - 1]',
      '      j -= 1',
      '  return a',
    ],
  },
  bubble: {
    name: '冒泡排序', english: 'Bubble Sort', episode: 3,
    description: '比较相邻元素并交换逆序对，每轮将最大值送到末尾，已就位后缀标绿；一轮无交换就提前结束。',
    code: [
      'def bubble(a):',
      '  for end in range(len(a) - 1, 0, -1):',
      '    swapped = False',
      '    for j in range(end):',
      '      if a[j] > a[j + 1]:',
      '        a[j], a[j + 1] = a[j + 1], a[j]',
      '        swapped = True',
      '    if not swapped: return a',
      '  return a',
    ],
  },
  selection: {
    name: '选择排序', english: 'Selection Sort', episode: 4,
    description: '扫描未排序区间寻找最小值，每轮至多交换一次并固定下一位；远距离交换使该算法不稳定。',
    code: [
      'def selection(a):',
      '  for start in range(len(a) - 1):',
      '    minimum = start',
      '    for j in range(start + 1, len(a)):',
      '      if a[j] < a[minimum]:',
      '        minimum = j',
      '    if minimum != start:',
      '      a[start], a[minimum] = a[minimum], a[start]',
      '  return a',
    ],
  },
  bogo: {
    name: '猴子排序', english: 'Bogo Sort', episode: 5,
    description: '逐对检查相邻元素，发现逆序就用 Fisher–Yates 均匀洗牌再试；逐步生成真实比较与交换，不限轮数、不保证何时结束。',
    code: [
      'def bogo(a):',
      '  while True:',
      '    ordered = True',
      '    for j in range(1, len(a)):',
      '      if a[j] < a[j - 1]:',
      '        ordered = False; break',
      '    if ordered: return a',
      '    for i in range(len(a) - 1, 0, -1):',
      '      j = random.randrange(i + 1)',
      '      if i != j: a[i], a[j] = a[j], a[i]',
    ],
  },
};

class Trace {
  readonly values: number[];
  readonly sorted: boolean[];
  comparisons = 0;
  swaps = 0;

  constructor(input: readonly number[]) {
    this.values = input.slice();
    this.sorted = new Array<boolean>(input.length).fill(false);
  }

  exchange(a: number, b: number): void {
    const value = this.values[a];
    this.values[a] = this.values[b];
    this.values[b] = value;
    this.swaps++;
  }

  step(kind: StepKind, lo: number, hi: number, i: number, j: number,
    pivotIndex: number, codeLine: number, message: string,
    swapA = -1, swapB = -1,
    pivotValue = pivotIndex >= 0 ? this.values[pivotIndex] : 0): SortStep {
    return {
      kind, values: this.values.slice(), sorted: this.sorted.slice(), lo, hi, i, j,
      pivotIndex, pivotValue, comparisons: this.comparisons, swaps: this.swaps,
      codeLine, swapA, swapB, message,
    };
  }

  complete(codeLine: number, message = '排序完成，每个数都已就位。'): SortStep {
    this.sorted.fill(true);
    return this.step('complete', 0, this.values.length - 1, -1, -1, -1, codeLine, message);
  }
}

export function generate(algorithm: Algorithm, values: readonly number[], seed?: number): Generator<SortStep> {
  if (!values || values.length === 0) throw new Error('排序数组不能为空。');
  const trace = new Trace(values);
  switch (algorithm) {
    case 'quick': return quick(trace);
    case 'insertion': return insertion(trace);
    case 'bubble': return bubble(trace);
    case 'selection': return selection(trace);
    case 'bogo': return bogo(trace, seed === undefined ? Math.random : seededRandom(seed));
    default: throw new RangeError(`未知排序算法：${String(algorithm)}`);
  }
}

function* quick(trace: Trace): Generator<SortStep> {
  yield* quickRange(trace, 0, trace.values.length - 1);
  yield trace.complete(-1);
}

function* quickRange(trace: Trace, lo: number, hi: number): Generator<SortStep> {
  if (lo > hi) return;
  const pivotValue = trace.values[hi];
  let pivotIndex = hi;
  let i = lo;
  yield trace.step('partition', lo, hi, i, lo, pivotIndex, lo === hi ? 1 : 2,
    `划分第 ${lo + 1}–${hi + 1} 位，枢轴为 ${pivotValue}。`);
  if (lo === hi) {
    trace.sorted[lo] = true;
    yield trace.step('rangeComplete', lo, hi, lo, lo, pivotIndex, 1,
      `${trace.values[lo]} 已就位：单元素区间无需比较。`);
    return;
  }
  for (let j = lo; j < hi; j++) {
    trace.comparisons++;
    const less = trace.values[j] < pivotValue;
    yield trace.step('compare', lo, hi, i, j, pivotIndex, 4,
      less ? `${trace.values[j]} < ${pivotValue}：成立，移入左区。`
        : `${trace.values[j]} < ${pivotValue}：不成立，保留在右区。`);
    if (less) {
      if (i !== j) {
        trace.exchange(i, j);
        if (pivotIndex === i) pivotIndex = j;
        else if (pivotIndex === j) pivotIndex = i;
        yield trace.step('swap', lo, hi, i, j, pivotIndex, 5,
          `交换第 ${i + 1} 和第 ${j + 1} 位。`, i, j, pivotValue);
      }
      i++;
      yield trace.step('advance', lo, hi, i, j, pivotIndex, 6,
        `左区扩展，i 指向第 ${i + 1} 位。`, -1, -1, pivotValue);
    }
  }
  if (i !== hi) {
    trace.exchange(i, hi);
    if (pivotIndex === i) pivotIndex = hi;
    else if (pivotIndex === hi) pivotIndex = i;
    yield trace.step('swap', lo, hi, i, hi, pivotIndex, 7,
      `交换第 ${i + 1} 和第 ${hi + 1} 位。`, i, hi, pivotValue);
  }
  trace.sorted[i] = true;
  yield trace.step('pivotPlaced', lo, hi, i, hi, pivotIndex, 7,
    `枢轴 ${pivotValue} 在第 ${i + 1} 位就位，两侧分别排序。`, -1, -1, pivotValue);
  yield* quickRange(trace, lo, i - 1);
  yield* quickRange(trace, i + 1, hi);
  yield trace.step('rangeComplete', lo, hi, i, hi, pivotIndex, -1,
    `第 ${lo + 1}–${hi + 1} 位排序完成。`, -1, -1, pivotValue);
}

function* insertion(trace: Trace): Generator<SortStep> {
  for (let end = 1; end < trace.values.length; end++) {
    let j = end;
    yield trace.step('partition', 0, end, end, j, -1, 2,
      `将第 ${end + 1} 位插入有序前缀；前缀尚未最终就位。`);
    while (j > 0) {
      const inOrder = trace.values[j] >= trace.values[j - 1];
      trace.comparisons++;
      yield trace.step('compare', 0, end, end, j, j - 1, 4,
        inOrder ? `${trace.values[j]} ≥ ${trace.values[j - 1]}：停止向左插入。`
          : `${trace.values[j]} < ${trace.values[j - 1]}：向左交换一位。`);
      if (inOrder) break;
      trace.exchange(j - 1, j);
      yield trace.step('swap', 0, end, end, j, -1, 5,
        `交换第 ${j} 和第 ${j + 1} 位，所有元素仍各在一处。`, j - 1, j);
      j--;
      yield trace.step('advance', 0, end, end, j, -1, 6,
        `插入元素移至第 ${j + 1} 位，继续检查左邻。`);
    }
    yield trace.step('rangeComplete', 0, end, end, j, -1, 1,
      `前 ${end + 1} 位已有序，但后续插入仍可能改变位置。`);
  }
  yield trace.complete(7);
}

function* bubble(trace: Trace): Generator<SortStep> {
  for (let end = trace.values.length - 1; end > 0; end--) {
    let swapped = false;
    yield trace.step('partition', 0, end, -1, -1, -1, 2,
      `从左到右比较前 ${end + 1} 位，将最大值送到本轮末尾。`);
    for (let j = 0; j < end; j++) {
      const outOfOrder = trace.values[j] > trace.values[j + 1];
      trace.comparisons++;
      yield trace.step('compare', 0, end, -1, j, j + 1, 4,
        outOfOrder ? `${trace.values[j]} > ${trace.values[j + 1]}：交换相邻逆序对。`
          : `${trace.values[j]} ≤ ${trace.values[j + 1]}：保持顺序。`);
      if (!outOfOrder) continue;
      trace.exchange(j, j + 1);
      swapped = true;
      yield trace.step('swap', 0, end, -1, j, -1, 5,
        `交换第 ${j + 1} 和第 ${j + 2} 位。`, j, j + 1);
    }
    trace.sorted[end] = true;
    yield trace.step('rangeComplete', end, end, -1, -1, -1, 7,
      `第 ${end + 1} 位已最终就位，绿色后缀不再参与交换。`);
    if (!swapped) {
      yield trace.complete(7, '本轮没有交换，整个数组已有序，提前完成。');
      return;
    }
  }
  yield trace.complete(8);
}

function* selection(trace: Trace): Generator<SortStep> {
  for (let start = 0; start < trace.values.length - 1; start++) {
    let minimum = start;
    const hi = trace.values.length - 1;
    yield trace.step('partition', start, hi, start, -1, minimum, 2,
      `扫描第 ${start + 1}–${hi + 1} 位，寻找本轮最小值。`);
    for (let j = start + 1; j <= hi; j++) {
      const smaller = trace.values[j] < trace.values[minimum];
      trace.comparisons++;
      yield trace.step('compare', start, hi, start, j, minimum, 4,
        smaller ? `${trace.values[j]} < ${trace.values[minimum]}：发现更小的候选。`
          : `${trace.values[j]} ≥ ${trace.values[minimum]}：保留当前最小值。`);
      if (!smaller) continue;
      minimum = j;
      yield trace.step('advance', start, hi, start, j, minimum, 5,
        `当前最小值更新为第 ${minimum + 1} 位的 ${trace.values[minimum]}。`);
    }
    if (minimum !== start) {
      trace.exchange(start, minimum);
      yield trace.step('swap', start, hi, start, minimum, -1, 7,
        `交换第 ${start + 1} 和第 ${minimum + 1} 位，本轮只交换一次。`, start, minimum);
    }
    trace.sorted[start] = true;
    yield trace.step('rangeComplete', start, start, start, -1, -1, 1,
      `第 ${start + 1} 位的 ${trace.values[start]} 已最终就位。`);
  }
  yield trace.complete(8);
}

function* bogo(trace: Trace, random: () => number): Generator<SortStep> {
  while (true) {
    const hi = trace.values.length - 1;
    let ordered = true;
    yield trace.step('partition', 0, hi, -1, -1, -1, 2,
      '从左到右检查相邻元素，遇到第一个逆序对即停止检查。');
    for (let j = 1; j <= hi; j++) {
      const outOfOrder = trace.values[j] < trace.values[j - 1];
      trace.comparisons++;
      yield trace.step('compare', 0, hi, -1, j, j - 1, 4,
        outOfOrder ? `${trace.values[j]} < ${trace.values[j - 1]}：存在逆序，需要重新洗牌。`
          : `${trace.values[j]} ≥ ${trace.values[j - 1]}：继续检查。`);
      if (outOfOrder) {
        ordered = false;
        break;
      }
    }
    if (ordered) {
      yield trace.complete(6, '逐对检查确认整个数组已有序，猴子排序完成。');
      return;
    }
    yield trace.step('partition', 0, hi, -1, -1, -1, 7,
      '执行 Fisher–Yates 洗牌：每次在剩余前缀中均匀随机选一位。');
    for (let i = hi; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      yield trace.step('advance', 0, i, i, j, -1, 8,
        i === j ? `随机选中第 ${j + 1} 位自身，无需交换。`
          : `从前 ${i + 1} 位随机选中第 ${j + 1} 位，与第 ${i + 1} 位交换。`);
      if (i === j) continue;
      trace.exchange(i, j);
      yield trace.step('swap', 0, i, i, j, -1, 9,
        `随机交换第 ${i + 1} 和第 ${j + 1} 位，尚未确认任何最终位置。`, i, j);
    }
  }
}

// Match Unity's seeded System.Random, so a seeded Bogo trace replays identically.
function seededRandom(seed: number): () => number {
  const max = 2147483647;
  const value = seed | 0;
  const subtraction = value === -2147483648 ? max : Math.abs(value);
  const state = new Int32Array(56);
  let mj = 161803398 - subtraction;
  state[55] = mj;
  let mk = 1;
  for (let i = 1; i < 55; i++) {
    const ii = (21 * i) % 55;
    state[ii] = mk;
    mk = mj - mk;
    if (mk < 0) mk += max;
    mj = state[ii];
  }
  for (let k = 0; k < 4; k++) {
    for (let i = 1; i < 56; i++) {
      state[i] -= state[1 + ((i + 30) % 55)];
      if (state[i] < 0) state[i] += max;
    }
  }
  let next = 0;
  let nextP = 21;
  return () => {
    if (++next >= 56) next = 1;
    if (++nextP >= 56) nextP = 1;
    let sample = state[next] - state[nextP];
    if (sample === max) sample--;
    if (sample < 0) sample += max;
    state[next] = sample;
    return sample / max;
  };
}

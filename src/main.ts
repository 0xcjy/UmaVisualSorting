import './style.css';
import { Playback } from './playback';
import { Stage } from './stage';
import { UI } from './ui';
import { Audio } from './audio';

const root = document.querySelector<HTMLElement>('#app')!;
export const playback = new Playback();
export const audio = new Audio();
let loaded = false;
let frame = 0;
let lastTime = 0;
const unlock = () => { void audio.unlock().catch(error => { ui.setLoading(`声音加载失败：${String(error)}`); }); };
const interrupt = (action: () => void) => { audio.stopTransient(); audio.pause(); action(); };
export const ui = new UI(root, {
  toggle: () => { if (!loaded) return; unlock(); playback.toggle(); if (playback.state.playing) audio.resume(); else audio.pause(); },
  next: () => { if (!loaded) return; unlock(); playback.next(); },
  previous: () => interrupt(() => playback.previous()),
  reset: () => interrupt(() => playback.reset()),
  shuffle: () => interrupt(() => playback.shuffle()),
  setAlgorithm: algorithm => interrupt(() => playback.setAlgorithm(algorithm)),
  setElementCount: count => interrupt(() => playback.setElementCount(count)),
  setSpeed: speed => playback.setSpeed(speed),
  seek: fraction => interrupt(() => playback.seek(fraction)),
  setPhysics: enabled => stage.setPhysics(enabled),
  setAudio: (key, value) => {
    if (key === 'muted') audio.settings.muted = Boolean(value);
    else audio.settings[key] = Math.max(0, Math.min(1, Number(value)));
    unlock();
  },
  fullscreen: () => {
    const promise = document.fullscreenElement ? document.exitFullscreen() : root.requestFullscreen();
    void promise.catch(error => ui.setLoading(`无法进入全屏：${String(error)}`));
  },
});
export const stage = new Stage(ui.canvas);
playback.onStep = (step, animated) => {
  if (animated || step.kind === 'complete') audio.playStep(step);
  else { audio.stopTransient(); audio.pause(); }
};
playback.onLand = () => audio.land();
audio.pause();
ui.setLoading('加载原版角色与动作…');
ui.render(playback.state, { actors: [], slots: [], groundY: 0, rangeLeft: 0, rangeRight: 0 });
function draw(time: number): void {
  const dt = lastTime ? Math.min((time - lastTime) / 1000, 0.1) : 0;
  lastTime = time;
  playback.tick(dt);
  const state = playback.state;
  const running = state.delta > 0;
  audio.update(dt, running);
  ui.render(state, stage.update(state));
  frame = requestAnimationFrame(draw);
}
void stage.load(message => ui.setLoading(message)).then(() => {
  loaded = true;
  ui.setLoading(null);
  frame = requestAnimationFrame(draw);
}).catch(error => { console.error(error); ui.setLoading(`角色加载失败：${String(error)}。请刷新重试。`); });
document.addEventListener('visibilitychange', () => {
  lastTime = 0;
  if (document.hidden) audio.pause();
  else if (playback.state.playing || playback.state.animating || playback.state.step.kind === 'complete') audio.resume();
});
window.addEventListener('pagehide', () => { cancelAnimationFrame(frame); stage.dispose(); audio.dispose(); ui.dispose(); }, { once: true });

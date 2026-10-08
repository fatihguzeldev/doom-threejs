import type { SessionState } from '../session/session';
import type { DoomResources } from '../wad/resources';
import type { PatchPainter } from './patches';

const nodes = [
  [[185, 164], [148, 143], [69, 122], [209, 102], [116, 89], [166, 55], [71, 56], [135, 29], [71, 24]],
  [[254, 25], [97, 50], [188, 64], [128, 78], [214, 92], [133, 130], [208, 136], [148, 140], [235, 158]],
  [[156, 168], [48, 154], [174, 95], [265, 75], [130, 48], [279, 23], [198, 48], [140, 25], [281, 136]],
] as const;
const animationPositions = [
  [[224, 104], [184, 160], [112, 136], [72, 112], [88, 96], [64, 48], [192, 40], [136, 16], [80, 16], [64, 24]],
  [[128, 136], [128, 136], [128, 136], [128, 136], [128, 136], [128, 136], [128, 136], [192, 144], [128, 136]],
  [[104, 168], [40, 136], [160, 96], [104, 80], [120, 32], [40, 0]],
] as const;

export function drawSessionScreen(context: CanvasRenderingContext2D, state: Exclude<SessionState, { kind: 'level' }>, resources: DoomResources, painter: PatchPainter): void {
  const centered = (name: string, y: number): void => {
    const image = resources.patch(name); painter.patch(context, name, (320 - image.width) / 2, y);
  };
  const number = (value: number, x: number, y: number, digits = -1): number => {
    if (Math.abs(value) === 1994) return 0;
    const width = resources.patch('WINUM0').width, negative = value < 0;
    let remaining = Math.abs(value);
    if (digits < 0) digits = remaining.toString().length;
    while (digits-- > 0) {
      x -= width; painter.patch(context, `WINUM${remaining % 10}`, x, y); remaining = Math.trunc(remaining / 10);
    }
    if (negative) { x -= 8; painter.patch(context, 'WIMINUS', x, y); }
    return x;
  };
  const percent = (value: number, x: number, y: number): void => {
    if (value < 0) return;
    painter.patch(context, 'WIPCNT', x, y); number(value, x, y);
  };
  const time = (seconds: number, x: number, y: number): void => {
    if (seconds < 0) return;
    if (seconds > 3599) { painter.patch(context, 'WISUCKS', x - resources.patch('WISUCKS').width, y); return; }
    let divisor = 1;
    do {
      x = number(Math.trunc(seconds / divisor) % 60, x, y, 2) - resources.patch('WICOLON').width;
      divisor *= 60;
      if (divisor === 60 || Math.trunc(seconds / divisor) !== 0) painter.patch(context, 'WICOLON', x, y);
    } while (Math.trunc(seconds / divisor) !== 0);
  };
  const onNode = (point: readonly [number, number], variants: readonly string[]): void => {
    for (const name of variants) {
      const image = resources.patch(name), left = point[0] - image.leftOffset, top = point[1] - image.topOffset;
      if (left >= 0 && left + image.width < 320 && top >= 0 && top + image.height < 200) {
        painter.patch(context, name, point[0], point[1]); return;
      }
    }
  };
  context.clearRect(0, 0, 320, 200);
  if (state.kind === 'intermission') {
    if (state.episode <= 3) context.drawImage(painter.image(`WIMAP${state.episode - 1}`), 0, 0);
    else context.drawImage(painter.image('INTERPIC'), 0, 0);
    for (const [index, animation] of state.animations.entries()) {
      if (animation.frame < 0) continue;
      const position = animationPositions[state.episode - 1]?.[index];
      if (!position) continue;
      // Original episode-two animation eight shares animation four's image.
      const picture = state.episode === 2 && index === 8 ? 4 : index;
      painter.patch(context, `WIA${state.episode - 1}${picture.toString().padStart(2, '0')}${animation.frame.toString().padStart(2, '0')}`, position[0], position[1]);
    }
    if (state.stage === 'counting') {
      const name = `WILV${state.episode - 1}${state.mapNumber - 1}`, lineHeight = Math.trunc(resources.patch('WINUM0').height * 3 / 2);
      centered(name, 2); centered('WIF', 2 + Math.trunc(resources.patch(name).height * 5 / 4));
      painter.patch(context, 'WIOSTK', 50, 50); percent(state.counters.kills, 270, 50);
      painter.patch(context, 'WIOSTI', 50, 50 + lineHeight); percent(state.counters.items, 270, 50 + lineHeight);
      painter.patch(context, 'WISCRT2', 50, 50 + 2 * lineHeight); percent(state.counters.secrets, 270, 50 + 2 * lineHeight);
      painter.patch(context, 'WITIME', 16, 168); time(state.counters.time, 144, 168);
      if (state.episode <= 3) { painter.patch(context, 'WIPAR', 176, 168); time(state.counters.par, 304, 168); }
    } else {
      const positions = nodes[state.episode - 1];
      if (positions) {
        const last = state.mapNumber === 9 ? state.nextMapNumber - 1 : state.mapNumber;
        for (let map = 1; map <= last; map++) {
          const point = positions[map - 1]; if (point) onNode(point, ['WISPLAT']);
        }
        const secret = positions[8]; if (state.player.didSecret && secret) onNode(secret, ['WISPLAT']);
        const target = positions[state.nextMapNumber - 1];
        if (target && state.pointerOn) onNode(target, ['WIURH0', 'WIURH1']);
      }
      const name = `WILV${state.episode - 1}${state.nextMapNumber - 1}`;
      centered('WIENTER', 2); centered(name, 2 + Math.trunc(resources.patch(name).height * 5 / 4));
    }
    return;
  }
  if (state.stage === 'text') {
    const tile = painter.indexed(resources.flat(state.flat));
    for (let y = 0; y < 200; y += 64) for (let x = 0; x < 320; x += 64) context.drawImage(tile, x, y);
    let y = 10;
    for (const line of state.text.slice(0, state.textVisibleChars).split('\n')) {
      let visible = '', x = 10, overflow = false;
      for (const character of line) {
        const width = painter.textWidth(character);
        if (x + width > 320) { overflow = true; break; }
        visible += character; x += width;
      }
      painter.text(context, visible, 10, y); y += 11;
      if (overflow) break;
    }
  } else if (state.episode === 3) {
    context.drawImage(painter.image('PFUB2'), -state.bunnyScroll, 0);
    context.drawImage(painter.image('PFUB1'), 320 - state.bunnyScroll, 0);
    if (state.bunnyEndFrame !== null) centered(`END${state.bunnyEndFrame}`, 68);
  } else if (state.picture !== null) context.drawImage(painter.image(state.picture), 0, 0);
}

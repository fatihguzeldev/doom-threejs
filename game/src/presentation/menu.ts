import type { GameMode, Skill } from '../simulation/world';
import type { InputAction } from '../input/browser';
import type { PatchPainter } from './patches';

export type MenuAction = { readonly type: 'newGame'; readonly episode: number; readonly skill: Skill } |
  { readonly type: 'save' | 'load'; readonly slot: number } |
  { readonly type: 'volume'; readonly channel: 'sfx' | 'music'; readonly value: number } |
  { readonly type: 'close' | 'quit' };

export interface GameMenu {
  readonly open: boolean;
  show(page?: 'main' | 'save' | 'load'): void;
  hide(): void;
  input(action: InputAction): MenuAction | null;
  click(x: number, y: number): MenuAction | null;
  draw(context: CanvasRenderingContext2D, tick: number): void;
}

export function createGameMenu(painter: PatchPainter, mode: () => GameMode, savedSlots: () => readonly string[]): GameMenu {
  let opened = true, page: 'main' | 'episode' | 'skill' | 'options' | 'save' | 'load' | 'help' = 'main';
  let selection = 0, episode = 1, sfx = 0.8, music = 0.55;
  const layout = (): { x: number; y: number; rowHeight: number } => {
    if (page === 'main') return { x: 97, y: 64, rowHeight: 16 };
    if (page === 'episode' || page === 'skill') return { x: 48, y: 63, rowHeight: 16 };
    if (page === 'save' || page === 'load') return { x: 80, y: 54, rowHeight: 16 };
    return { x: 60, y: 60, rowHeight: 32 };
  };
  const rows = (): number => page === 'main' ? 6 : page === 'episode' ? mode() === 'retail' ? 4 : 3 : page === 'skill' ? 5 : page === 'options' ? 2 : page === 'help' ? 1 : 6;
  const choose = (): MenuAction | null => {
    if (page === 'main') {
      if (selection === 0) page = 'episode';
      else if (selection === 1) page = 'options';
      else if (selection === 2) page = 'load';
      else if (selection === 3) page = 'save';
      else if (selection === 4) page = 'help';
      else { opened = false; return { type: 'quit' }; }
      selection = 0; return null;
    }
    if (page === 'episode') {
      if (mode() === 'shareware' && selection > 0) return null;
      episode = selection + 1; page = 'skill'; selection = 2; return null;
    }
    if (page === 'skill') { opened = false; return { type: 'newGame', episode, skill: selection as Skill }; }
    if (page === 'save' || page === 'load') { opened = false; return { type: page, slot: selection }; }
    if (page === 'help') { page = 'main'; selection = 0; }
    return null;
  };
  const input = (action: InputAction): MenuAction | null => {
    if (!opened) return null;
    if (action === 'menu') {
      if (page !== 'main') { page = 'main'; selection = 0; return null; }
      opened = false; return { type: 'close' };
    }
    if (action === 'up' || action === 'down') selection = (selection + (action === 'up' ? -1 : 1) + rows()) % rows();
    if (action === 'confirm') return choose();
    if (page === 'options' && (action === 'left' || action === 'right')) {
      const change = action === 'left' ? -0.1 : 0.1;
      if (selection === 0) sfx = Math.max(0, Math.min(1, sfx + change));
      else music = Math.max(0, Math.min(1, music + change));
      return { type: 'volume', channel: selection === 0 ? 'sfx' : 'music', value: selection === 0 ? sfx : music };
    }
    return null;
  };
  return {
    get open(): boolean { return opened; },
    show(next = 'main'): void { page = next; selection = 0; opened = true; },
    hide(): void { opened = false; }, input,
    click(x, y): MenuAction | null {
      if (!opened) return null;
      if (page === 'help') return choose();
      const row = layout(), index = Math.floor((y - row.y) / row.rowHeight);
      if (x >= row.x - 32 && x <= 292 && index >= 0 && index < rows()) { selection = index; return choose(); }
      return null;
    },
    draw(context, tick): void {
      if (!opened) return;
      context.fillStyle = 'rgb(0 0 0 / 35%)'; context.fillRect(0, 0, 320, 200);
      if (page === 'help') {
        painter.text(context, 'W A S D  MOVE\nMOUSE / ARROWS  TURN\nCTRL / LEFT CLICK  FIRE\nSPACE / E  USE\nSHIFT  RUN\n1-7  WEAPONS\nTAB  AUTOMAP\nF5 / F9  QUICK SAVE / LOAD\nESC  MENU\n\nENTER TO RETURN', 30, 25);
        return;
      }
      let names: readonly string[] = [];
      const { x, y, rowHeight } = layout();
      if (page === 'main') {
        painter.patch(context, 'M_DOOM', 94, 2);
        names = ['M_NGAME', 'M_OPTION', 'M_LOADG', 'M_SAVEG', 'M_RDTHIS', 'M_QUITG'];
      } else if (page === 'episode') {
        painter.patch(context, 'M_EPISOD', 54, 38);
        names = mode() === 'retail' ? ['M_EPI1', 'M_EPI2', 'M_EPI3', 'M_EPI4'] : ['M_EPI1', 'M_EPI2', 'M_EPI3'];
        if (mode() === 'shareware') painter.text(context, 'EPISODES 2 AND 3 REQUIRE YOUR DOOM WAD', 16, 145);
      } else if (page === 'skill') {
        painter.patch(context, 'M_NEWG', 96, 14); painter.patch(context, 'M_SKILL', 54, 38);
        names = ['M_JKILL', 'M_ROUGH', 'M_HURT', 'M_ULTRA', 'M_NMARE'];
      } else if (page === 'options') {
        painter.patch(context, 'M_OPTTTL', 108, 15);
        painter.text(context, `SOUND VOLUME  ${Math.round(sfx * 10)}`, x, y);
        painter.text(context, `MUSIC VOLUME  ${Math.round(music * 10)}`, x, y + rowHeight);
        painter.text(context, 'LEFT / RIGHT TO ADJUST', x, y + rowHeight * 2);
      } else {
        painter.patch(context, page === 'save' ? 'M_SAVEG' : 'M_LOADG', 72, 28);
        const slots = savedSlots();
        for (let slot = 0; slot < 6; slot++) {
          const lineY = y + slot * rowHeight;
          painter.patch(context, 'M_LSLEFT', x - 8, lineY + 7);
          for (let cell = 0; cell < 24; cell++) painter.patch(context, 'M_LSCNTR', x + cell * 8, lineY + 7);
          painter.patch(context, 'M_LSRGHT', x + 24 * 8, lineY + 7);
          painter.text(context, slots[slot] ?? 'EMPTY SLOT', x, lineY);
        }
      }
      for (const [index, name] of names.entries()) painter.patch(context, name, x, y + index * rowHeight);
      painter.patch(context, `M_SKULL${Math.floor(tick / 8) % 2 + 1}`, x - 32, y + selection * rowHeight - 5);
    },
  };
}

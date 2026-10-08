import type { InputAction } from './browser';

// Release actions let a staggered Start+Select launcher chord suppress both keys.
export function createSystemButtons() {
  let previousStart = false, previousSelect = false, suppressed = false;
  return {
    update(start: boolean, select: boolean): InputAction[] {
      const actions: InputAction[] = [];
      if (start && select) suppressed = true;
      if (!suppressed) {
        if (previousStart && !start) actions.push('menu');
        if (previousSelect && !select) actions.push('automap');
      }
      previousStart = start; previousSelect = select;
      if (!start && !select) suppressed = false;
      return actions;
    },
    clear(start: boolean, select: boolean): void {
      previousStart = start; previousSelect = select;
      suppressed = start || select;
    },
  };
}

import { Editor, Key, matchesKey } from '@mariozechner/pi-tui';

const PROMPT = '\u276f ';
const PROMPT_WIDTH = 2;

export class CustomEditor extends Editor {
  onEscape?: () => void;
  onCtrlC?: () => void;

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) && this.onEscape) {
      this.onEscape();
      return;
    }
    if (matchesKey(data, Key.ctrl('c')) && this.onCtrlC) {
      this.onCtrlC();
      return;
    }
    super.handleInput(data);
  }

  render(width: number): string[] {
    // Render the editor narrower to leave room for the prompt prefix
    const innerWidth = Math.max(1, width - PROMPT_WIDTH);
    const lines = super.render(innerWidth);

    const coloredPrompt = this.borderColor(PROMPT);
    const borderPad = this.borderColor('\u2500'.repeat(PROMPT_WIDTH));

    for (let i = 0; i < lines.length; i++) {
      if (i === 0 || i === lines.length - 1) {
        // Border lines: extend with more border chars to fill full width
        lines[i] = lines[i] + borderPad;
      } else {
        // Content lines: prepend the chevron on the first, spaces on the rest
        lines[i] = (i === 1 ? coloredPrompt : ' '.repeat(PROMPT_WIDTH)) + lines[i];
      }
    }

    return lines;
  }
}

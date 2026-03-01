import { Container, Spacer, Text } from '@mariozechner/pi-tui';
import packageJson from '../../package.json';
import { getModelDisplayName } from '../utils/model.js';
import { theme } from '../theme.js';

// "$"-themed block-letter OA — O p e n  A c c o u n t a n t
const OA_ART = `
  /$$$$$$
 /$$__  $$
| $$  \\ $$  /$$$$$$
| $$  | $$ |____  $$
| $$  | $$  /$$$$$$$
| $$  | $$ /$$__  $$
|  $$$$$$/ |  $$$$$$$
 \\______/   \\_______/`;

/** Color $ chars in green, everything else (frame chars) in white. */
function colorizeArt(art: string): string {
  return art
    .split('\n')
    .map((line) => {
      let result = '';
      let i = 0;
      while (i < line.length) {
        if (line[i] === '$') {
          let j = i;
          while (j < line.length && line[j] === '$') j++;
          result += theme.bold(theme.primary(line.slice(i, j)));
          i = j;
        } else {
          let j = i;
          while (j < line.length && line[j] !== '$') j++;
          result += theme.bold(theme.white(line.slice(i, j)));
          i = j;
        }
      }
      return result;
    })
    .join('\n');
}

export class IntroComponent extends Container {
  private readonly modelText: Text;

  constructor(model: string) {
    super();

    // Top border with centered version info
    const version = `v${packageJson.version}`;
    const label = ` Welcome to Open Accountant ${version} `;
    const borderChar = '\u2550';
    const totalWidth = 72;
    const sideLen = Math.max(0, Math.floor((totalWidth - label.length) / 2));
    const topBorder = borderChar.repeat(sideLen) + label + borderChar.repeat(totalWidth - sideLen - label.length);
    this.addChild(new Text(theme.primary(topBorder), 0, 0));

    // ASCII art — $ in green, frame in white
    this.addChild(new Text(colorizeArt(OA_ART), 0, 0));

    this.addChild(new Spacer(1));

    // Subtitle
    this.addChild(new Text(theme.muted('Your AI bookkeeper. Follow the money.'), 0, 0));

    // Model line
    this.modelText = new Text('', 0, 0);
    this.addChild(this.modelText);
    this.setModel(model);

    this.addChild(new Spacer(1));

    // Bottom separator
    this.addChild(new Text(theme.separator(totalWidth), 0, 0));
  }

  setModel(model: string) {
    this.modelText.setText(
      `${theme.muted('Model: ')}${theme.primary(getModelDisplayName(model))}${theme.muted(
        '. Type /model to change.',
      )}`,
    );
  }
}

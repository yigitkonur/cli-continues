import chalk from 'chalk';

/**
 * ASCII art banner with indigo->cyan gradient and highlighted 's' brand mark.
 * All letters are exactly 4 chars wide, 1-space separated, 3 rows.
 */
export function showBanner(version: string, supportsColor: boolean): void {
  if (!supportsColor) return;

  // Letter glyphs: [top, mid, bot], each 4 chars wide
  const glyphs: string[][] = [
    ['\u2588\u2580\u2580\u2580', '\u2588   ', '\u2580\u2580\u2580\u2580'], // c
    ['\u2588\u2580\u2580\u2588', '\u2588  \u2588', '\u2580\u2580\u2580\u2580'], // o
    ['\u2588\u2580\u2580\u2584', '\u2588  \u2588', '\u2580  \u2580'], // n
    ['\u2580\u2588\u2588\u2580', ' \u2588\u2588 ', ' \u2580\u2580 '], // t
    [' \u2588\u2588 ', ' \u2588\u2588 ', ' \u2580\u2580 '], // i
    ['\u2588\u2580\u2580\u2584', '\u2588  \u2588', '\u2580  \u2580'], // n
    ['\u2588  \u2588', '\u2588  \u2588', '\u2580\u2580\u2580\u2580'], // u
    ['\u2588\u2580\u2580\u2588', '\u2588\u2580\u2580 ', '\u2580\u2580\u2580\u2580'], // e
    ['\u2588\u2580\u2580\u2580', '\u2580\u2580\u2580\u2588', '\u2580\u2580\u2580\u2580'], // s
  ];

  // Gradient: soft indigo -> bright cyan, with 's' in bold mint
  const colors = [
    chalk.hex('#9b8ec9'), // c
    chalk.hex('#8a9ed7'), // o
    chalk.hex('#79aee5'), // n
    chalk.hex('#68bef3'), // t
    chalk.hex('#57ceff'), // i
    chalk.hex('#4ad6ff'), // n
    chalk.hex('#3cdeff'), // u
    chalk.hex('#2ee6ff'), // e
    chalk.hex('#00ffc8').bold, // s
  ];

  console.log();
  for (let row = 0; row < 3; row++) {
    let line = '  ';
    for (let i = 0; i < glyphs.length; i++) {
      line += colors[i](glyphs[i][row]);
      if (i < glyphs.length - 1) line += ' ';
    }
    console.log(line);
  }
  console.log();
  console.log('  ' + chalk.cyan('Session'.padEnd(10)) + chalk.gray('Resume any AI coding session, never lose context'));
  console.log('  ' + chalk.cyan('Continue'.padEnd(10)) + chalk.gray(`v${version} \u2014 cont <n> or continues <tool>`));
  console.log();
}

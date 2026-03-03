import { emitKeypressEvents } from 'node:readline';
import chalk from 'chalk';

type RotatingBannerLine = () => string;
type KeyPress = { name?: string; ctrl?: boolean };

const TAB_CYCLE_TIMEOUT_MS = 1400;
const TAB_CYCLE_HINT = chalk.gray('[Tab to cycle]');

const FALLBACK_BANNER_LINE: RotatingBannerLine = () =>
  `${chalk.gray('💡 Tip:')} ${chalk.gray('Run')} ${chalk.cyan('continues --help')} ${chalk.gray(
    'for examples and preset recipes.',
  )}`;

const PRESET_PROMO_LINES: RotatingBannerLine[] = [
  () =>
    `${chalk.gray('🎛️ Preset:')} ${chalk.cyan('full')} ${chalk.gray(
      'is ideal for rich handoff context (npx continues --preset full).',
    )}`,
  () =>
    `${chalk.gray('🎛️ Preset:')} ${chalk.cyan('minimal')} ${chalk.gray(
      'keeps output compact when you only need the essentials.',
    )}`,
  () =>
    `${chalk.gray('🎛️ Preset:')} ${chalk.cyan('verbose')} ${chalk.gray(
      'adds deeper tool activity while staying shorter than full.',
    )}`,
  () =>
    `${chalk.gray('🎛️ Preset:')} ${chalk.cyan('standard')} ${chalk.gray(
      'is balanced for daily resume + inspect flows.',
    )}`,
];

const STAR_PROMO_LINES: RotatingBannerLine[] = [
  () =>
    `${chalk.bgHex('#FFD93D').black.bold(' ⭐ LOVE CONTINUES? ')} ${chalk
      .hex('#FFD93D')
      .bold('Star:')} ${chalk.hex('#00FFC8').bold('github.com/yigitkonur/cli-continues')}`,
];

const GENERAL_BANNER_LINES: RotatingBannerLine[] = [
  () =>
    `${chalk.gray('💡 Tip:')} ${chalk.gray('Use')} ${chalk.cyan('continues inspect <id> --preset full')} ${chalk.gray(
      'for maximum handoff detail.',
    )}`,
  () =>
    `${chalk.gray('💡 Tip:')} ${chalk.gray('Run')} ${chalk.cyan('continues dump all ./handoffs --preset verbose')} ${chalk.gray(
      'to export readable archives.',
    )}`,
  () =>
    `${chalk.gray('🧠 Fact:')} ${chalk.gray(
      'Presets cascade into inspect/dump output, so one flag can tune your whole workflow.',
    )}`,
  () =>
    `${chalk.gray('🧠 Fact:')} ${chalk.gray(
      'The',
    )} ${chalk.cyan('cont')} ${chalk.gray('alias is built in — use')} ${chalk.cyan('cont claude')} ${chalk.gray(
      'for fast quick-resume.',
    )}`,
  () =>
    `${chalk.gray('💡 Tip:')} ${chalk.gray('Pair')} ${chalk.cyan('--config .continues.yml')} ${chalk.gray(
      'with',
    )} ${chalk.cyan('--preset')} ${chalk.gray('for per-project defaults + one-off overrides.')}`,
  () =>
    `${chalk.gray('💡 Tip:')} ${chalk.gray('Run')} ${chalk.cyan('continues resume <id> --in gemini')} ${chalk.gray(
      'to hand off a Codex/Claude session cross-tool.',
    )}`,
  () =>
    `${chalk.gray('💡 Tip:')} ${chalk.gray('Use')} ${chalk.cyan('continues list --jsonl | jq')} ${chalk.gray(
      'when scripting filters around session metadata.',
    )}`,
  () =>
    `${chalk.gray('💡 Tip:')} ${chalk.gray('Try')} ${chalk.cyan('continues scan --rebuild')} ${chalk.gray(
      'if a freshly-created session is missing from the index.',
    )}`,
  () =>
    `${chalk.gray('💡 Tip:')} ${chalk.gray('Use')} ${chalk.cyan('continues inspect <id> --write-md handoff.md')} ${chalk.gray(
      'to save a portable handoff file.',
    )}`,
  () =>
    `${chalk.gray('🧠 Fact:')} ${chalk.gray('Use')} ${chalk.cyan('--all')} ${chalk.gray(
      'to skip CWD filtering and browse every discovered session.',
    )}`,
  () =>
    `${chalk.gray('🧠 Fact:')} ${chalk.gray('You can forward args to target CLIs after')} ${chalk.cyan('--')} ${chalk.gray(
      '(e.g. continues claude 1 -- --dangerously-skip-permissions).',
    )}`,
  () =>
    `${chalk.gray('🧠 Fact:')} ${chalk.gray('Inspect + dump both honor')} ${chalk.cyan('--preset')} ${chalk.gray(
      'so detail level stays consistent across tools.',
    )}`,
  () =>
    `${chalk.gray('🧠 Fact:')} ${chalk.gray('Need quick routing?')} ${chalk.cyan('cont claude')} ${chalk.gray(
      'and',
    )} ${chalk.cyan('cont codex')} ${chalk.gray('jump straight into recent sessions.')}`,
];

const ALL_ROTATING_BANNER_LINES: RotatingBannerLine[] = [
  ...PRESET_PROMO_LINES,
  ...STAR_PROMO_LINES,
  ...GENERAL_BANNER_LINES,
];

function pickRandomLine(lines: RotatingBannerLine[]): RotatingBannerLine {
  if (lines.length === 0) return FALLBACK_BANNER_LINE;
  const index = Math.floor(Math.random() * lines.length);
  return lines[index] ?? lines[0] ?? FALLBACK_BANNER_LINE;
}

function pickWeightedInitialLine(): RotatingBannerLine {
  const roll = Math.random();
  if (roll < 0.5) return pickRandomLine(PRESET_PROMO_LINES); // 50%
  if (roll < 0.6) return pickRandomLine(STAR_PROMO_LINES); // 10%
  return pickRandomLine(GENERAL_BANNER_LINES); // 40%
}

function shuffleLines(lines: RotatingBannerLine[]): RotatingBannerLine[] {
  const shuffled = [...lines];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const current = shuffled[i];
    const target = shuffled[j];
    if (!current || !target) continue;
    shuffled[i] = target;
    shuffled[j] = current;
  }
  return shuffled;
}

function createCycleDeck(): RotatingBannerLine[] {
  const initial = pickWeightedInitialLine();
  const rest = shuffleLines(ALL_ROTATING_BANNER_LINES.filter((line) => line !== initial));
  return [initial, ...rest];
}

function renderLineFromDeck(cycleDeck: RotatingBannerLine[], index: number): string {
  const lineFactory = cycleDeck[index] ?? cycleDeck[0] ?? FALLBACK_BANNER_LINE;
  return lineFactory();
}

async function showRotatingBannerLine(): Promise<boolean> {
  const cycleDeck = createCycleDeck();
  const stdin = process.stdin;
  const stdout = process.stdout;
  const canCycle = stdin.isTTY && stdout.isTTY && !process.env.CI && typeof stdin.setRawMode === 'function';

  if (!canCycle) {
    console.log(`  ${renderLineFromDeck(cycleDeck, 0)}`);
    console.log();
    return false;
  }

  let index = 0;
  let timeout: NodeJS.Timeout | undefined;

  return await new Promise<boolean>((resolve) => {
    let finished = false;
    let rawModeEnabled = false;

    const render = (): void => {
      const line = renderLineFromDeck(cycleDeck, index);
      stdout.write(`\r\x1B[2K  ${line} ${TAB_CYCLE_HINT}`);
    };

    const teardownInput = (): void => {
      if (timeout) clearTimeout(timeout);
      stdin.off('keypress', onKeyPress);
      if (rawModeEnabled) {
        stdin.setRawMode(false);
        rawModeEnabled = false;
      }
      stdin.pause();
    };

    const finish = (): void => {
      if (finished) return;
      finished = true;
      teardownInput();
      stdout.write('\n\n');
      resolve(false);
    };

    const abortFromCtrlC = (): void => {
      if (finished) return;
      finished = true;
      teardownInput();
      stdout.write('\n\n');
      if (process.exitCode === undefined) {
        process.exitCode = 130;
      }
      resolve(true);
    };

    const armTimeout = (): void => {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(finish, TAB_CYCLE_TIMEOUT_MS);
    };

    const onKeyPress = (_input: string, key: KeyPress): void => {
      if (key.ctrl && key.name === 'c') {
        abortFromCtrlC();
        return;
      }

      if (key.name === 'tab') {
        index = (index + 1) % cycleDeck.length;
        render();
        armTimeout();
        return;
      }

      if (key.name === 'return' || key.name === 'enter' || key.name === 'escape' || key.name === 'space') {
        finish();
      }
    };

    try {
      emitKeypressEvents(stdin);
      stdin.resume();
      stdin.setRawMode(true);
      rawModeEnabled = true;
      stdin.on('keypress', onKeyPress);
      render();
      armTimeout();
    } catch {
      if (!finished) {
        finished = true;
        teardownInput();
        console.log(`  ${renderLineFromDeck(cycleDeck, 0)}`);
        console.log();
        resolve(false);
      }
    }
  });
}

/**
 * ASCII art banner with warm-to-cool gradient and highlighted 's' brand mark.
 * All letters are exactly 4 chars wide, 1-space separated, 3 rows.
 */
export async function showBanner(version: string, supportsColor: boolean): Promise<boolean> {
  if (!supportsColor) return false;

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

  // Gradient: coral -> orange -> gold -> emerald -> blue -> sky -> purple -> mint
  const colors = [
    chalk.hex('#FF6B6B'), // c — coral
    chalk.hex('#FF8E53'), // o — orange
    chalk.hex('#FFA940'), // n — amber
    chalk.hex('#FFD93D'), // t — gold
    chalk.hex('#6BCB77'), // i — emerald
    chalk.hex('#4D96FF'), // n — blue
    chalk.hex('#38B6FF'), // u — sky
    chalk.hex('#6C5CE7'), // e — purple
    chalk.hex('#00FFC8').bold, // s — mint
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
  console.log(
    '  ' +
      chalk.bold.white(`v${version}`) +
      chalk.gray(' — never lose context across ') +
      chalk.cyan('14 AI coding agents'),
  );
  console.log();
  console.log(
    '  ' +
      chalk.gray('🔄 Cross-tool handoff') +
      chalk.gray(' · ') +
      chalk.gray('🔎 Inspect mode') +
      chalk.gray(' · ') +
      chalk.gray('⚙️  YAML config') +
      chalk.gray(' · ') +
      chalk.gray('🌍 Env var overrides'),
  );
  console.log(
    '  ' +
      chalk.gray('🎛️ Try Presets:') +
      chalk.gray(' · ') +
      chalk.cyan('minimal') +
      chalk.gray(' · ') +
      chalk.cyan('standard') +
      chalk.gray(' · ') +
      chalk.cyan('verbose') +
      chalk.gray(' · ') +
      chalk.cyan('full') +
      chalk.gray(' (eg: npx continues --preset full for better context handoff!)'),
  );
  console.log(`  ${chalk.gray('💡 cont <n> or continues <tool> to quick-resume')}`);
  return await showRotatingBannerLine();
}

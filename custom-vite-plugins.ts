import fs from 'fs';
import { resolve } from 'path';
import type { NormalizedInputOptions, NormalizedOutputOptions } from 'rollup';
import type { PluginOption } from 'vite';

// plugin to remove dev icons from prod build
export function stripDevIcons(isDev: boolean) {
  if (isDev) return null;

  const devIconFiles = [
    'dev-icon-16.png',
    'dev-icon-32.png',
    'dev-icon-48.png',
    'dev-icon-128.png',
  ];

  const removeDevIcons = (outDir: string) => {
    for (const file of devIconFiles) {
      const iconPath = resolve(outDir, file);
      if (!fs.existsSync(iconPath)) continue;

      fs.rm(iconPath, { force: true }, () => console.log(`Deleted ${file} from prod build`));
    }
  };

  return {
    name: 'strip-dev-icons',
    resolveId(source: string) {
      return source === 'virtual-module' ? source : null;
    },
    renderStart(outputOptions: NormalizedOutputOptions, _inputOptions: NormalizedInputOptions) {
      const outDir = outputOptions.dir ?? '';
      removeDevIcons(outDir);

      // Remove assets directory if it exists
      const assetsDir = resolve(outDir, 'assets');
      fs.rm(assetsDir, { recursive: true, force: true }, () =>
        console.log(`Deleted assets/ directory from prod build`),
      );
    },
    writeBundle(outputOptions: NormalizedOutputOptions) {
      const outDir = outputOptions.dir ?? '';
      removeDevIcons(outDir);

      // Remove .vite directory (Vite's internal manifest, not needed for extension)
      const viteDir = resolve(outDir, '.vite');
      fs.rm(viteDir, { recursive: true, force: true }, () =>
        console.log(`Deleted .vite/ directory from prod build`),
      );
    },
  };
}

type LocaleMessages = Record<string, { message: string; description?: string }>;

function stripDescriptions(raw: LocaleMessages): LocaleMessages {
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, { message: v.message }]));
}

// plugin to strip `description` fields from locale JSON at build time.
// Runs before vite:json so we return stripped JSON; vite:json then converts it to ESM normally.
export function stripI18nDescriptions(isDev: boolean): PluginOption {
  if (isDev) return null;

  return {
    name: 'strip-i18n-descriptions',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('/locales/') || !id.endsWith('messages.json')) return null;
      const raw: LocaleMessages = JSON.parse(code);
      return { code: JSON.stringify(stripDescriptions(raw)), map: null };
    },
  };
}

// plugin to support i18n
export function crxI18n(options: {
  localize: boolean;
  src: string;
  stripDescriptions?: boolean;
}): PluginOption {
  if (!options.localize) return null;

  const getJsonFiles = (dir: string): Array<string> => {
    const files = fs.readdirSync(dir, { recursive: true }) as string[];
    return files.filter((file) => !!file && file.endsWith('.json'));
  };
  const entry = resolve(__dirname, options.src);
  const localeFiles = getJsonFiles(entry);
  const files = localeFiles.map((file) => {
    const raw: LocaleMessages = JSON.parse(fs.readFileSync(resolve(entry, file), 'utf-8'));
    const source = options.stripDescriptions
      ? JSON.stringify(stripDescriptions(raw))
      : JSON.stringify(raw);
    return { id: '', fileName: file, source };
  });
  return {
    name: 'crx-i18n',
    enforce: 'pre',
    buildStart: {
      order: 'post',
      handler() {
        files.forEach((file) => {
          const refId = this.emitFile({
            type: 'asset',
            source: file.source,
            fileName: '_locales/' + file.fileName,
          });
          file.id = refId;
        });
      },
    },
  };
}

// 配布先ごとのファイル選択を、ローカルと CI の全パッケージ経路で共有する。
const fs = require('node:fs');
const path = require('node:path');

const [variant, destination] = process.argv.slice(2);
const excluded = {
  chrome: ['src/content/volume-booster-mes.js'],
  firefox: ['src/offscreen'],
};
if (!Object.hasOwn(excluded, variant) || !destination) {
  throw new Error('Usage: node scripts/copy-package-files.js <chrome|firefox> <destination>');
}

const root = path.resolve(__dirname, '..');
const output = path.resolve(destination);
fs.mkdirSync(output, { recursive: true });
fs.copyFileSync(path.join(root, variant === 'firefox' ? 'manifest.firefox.json' : 'manifest.json'), path.join(output, 'manifest.json'));
for (const entry of ['icons', 'src', '_locales']) {
  fs.cpSync(path.join(root, entry), path.join(output, entry), {
    recursive: true,
    filter(source) {
      const relative = path.relative(root, source).split(path.sep).join('/');
      return !excluded[variant].some(item => relative === item || relative.startsWith(`${item}/`))
        && !/(?:\.DS_Store|\.swp|~)$/.test(path.basename(source));
    },
  });
}

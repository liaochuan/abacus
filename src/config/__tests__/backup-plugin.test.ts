import fs from 'fs';
import path from 'path';

const xmlPath = path.join(__dirname, '../../../plugins/android-res/xml/data_extraction_rules.xml');
const PLUGIN_NAME = './plugins/withAndroidManifest';

type PluginEntry = string | [string, Record<string, any>];

const EXCLUDED_DOMAINS = ['root', 'file', 'database', 'sharedpref', 'external'];
const INCLUDED_DOMAINS = ['database', 'sharedpref', 'file'];

function domainsOf(xml: string, tag: 'exclude' | 'include'): string[] {
  const pattern = new RegExp(`<${tag}\\s+domain="([^"]+)"\\s+path="\\.?"\\s*/>`, 'g');

  return Array.from(xml.matchAll(pattern), (match) => match[1]).sort();
}

test('备份规则禁止云备份并允许换机直传', () => {
  const xml = fs.readFileSync(xmlPath, 'utf8');

  expect(xml).toContain('<cloud-backup');
  expect(xml).toContain('<device-transfer>');

  expect(xml.match(/<exclude domain=/g)).toHaveLength(5);
  expect(domainsOf(xml, 'exclude')).toEqual([...EXCLUDED_DOMAINS].sort());

  expect(xml.match(/<include domain=/g)).toHaveLength(3);
  expect(domainsOf(xml, 'include')).toEqual([...INCLUDED_DOMAINS].sort());
});

test('备份规则 plugin 导出函数且只注册一次', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const plugin = require('../../../plugins/withAndroidManifest');
  expect(typeof plugin).toBe('function');

  let config: any;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    config = require('../../../app.config').default;
  });

  const matching = (config.plugins as PluginEntry[]).filter((entry) => (
    Array.isArray(entry) ? entry[0] === PLUGIN_NAME : entry === PLUGIN_NAME
  ));
  expect(matching).toHaveLength(1);
});

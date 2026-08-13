// Unit tests for account discovery in src/quota.js (loadAccounts).
//
// loadAccounts takes an injectable `home` parameter, so every test runs
// against a throwaway fixture home under the OS temp dir — the real
// ~/.claude* profiles are never read, and nothing here goes anywhere
// near credentials contents or the network (fixture .credentials.json
// files are empty JSON objects; only their existence matters).

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const { loadAccounts } = require('../src/quota.js')

// Fresh fixture home. `dirs` = dir names to create; those listed in
// `withCreds` additionally get a dummy .credentials.json.
function fixtureHome({ dirs = [], withCreds = [], overrideJson = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-accounts-'))
  for (const d of dirs) fs.mkdirSync(path.join(home, d), { recursive: true })
  for (const d of withCreds) {
    fs.mkdirSync(path.join(home, d), { recursive: true })
    fs.writeFileSync(path.join(home, d, '.credentials.json'), '{}')
  }
  if (overrideJson != null) {
    fs.writeFileSync(path.join(home, '.claude-usage-widget.json'), overrideJson)
  }
  return { home, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) }
}

test('discovery: finds .claude* dirs that contain a .credentials.json', () => {
  const { home, cleanup } = fixtureHome({
    withCreds: ['.claude', '.claude-acct2'],
    dirs: ['.claude-xyz', '.config'],   // xyz: no credentials -> not an account
  })
  try {
    const accs = loadAccounts(home)
    assert.deepEqual(accs, [
      { name: 'haupt', configDir: path.join(home, '.claude') },
      { name: 'acct2', configDir: path.join(home, '.claude-acct2') },
    ])
  } finally { cleanup() }
})

test('discovery: haupt first, rest alphabetical by display name', () => {
  const { home, cleanup } = fixtureHome({
    withCreds: ['.claude-bravo', '.claude', '.claude-alpha'],
  })
  try {
    assert.deepEqual(loadAccounts(home).map(a => a.name), ['haupt', 'alpha', 'bravo'])
  } finally { cleanup() }
})

test('discovery: non-.claude dirs are ignored even with credentials', () => {
  const { home, cleanup } = fixtureHome({ withCreds: ['.claude', '.other-tool'] })
  try {
    assert.deepEqual(loadAccounts(home).map(a => a.name), ['haupt'])
  } finally { cleanup() }
})

test('discovery: a .claude* dir without dash keeps its dot-less dir name', () => {
  const { home, cleanup } = fixtureHome({ withCreds: ['.claudeportable'] })
  try {
    assert.deepEqual(loadAccounts(home).map(a => a.name), ['claudeportable'])
  } finally { cleanup() }
})

test('override file wins over discovery (window-state keys coexist)', () => {
  const { home, cleanup } = fixtureHome({
    withCreds: ['.claude', '.claude-acct2'],  // discovery would find these...
    overrideJson: JSON.stringify({
      width: 360, height: 340, x: 10, y: 20,  // main.js window state
      accounts: [
        { name: 'custom', configDir: 'C:\\somewhere\\else' },
        { name: 'zwei', configDir: 'D:\\dir2' },
      ],
    }),
  })
  try {
    assert.deepEqual(loadAccounts(home), [
      { name: 'custom', configDir: 'C:\\somewhere\\else' },
      { name: 'zwei', configDir: 'D:\\dir2' },
    ])
  } finally { cleanup() }
})

test('override: malformed entries are skipped, valid ones survive', () => {
  const { home, cleanup } = fixtureHome({
    overrideJson: JSON.stringify({
      accounts: [
        null, 42, {}, { name: 'nur-name' }, { configDir: 'nur-dir' },
        { name: 'ok', configDir: '/some/dir' },
      ],
    }),
  })
  try {
    assert.deepEqual(loadAccounts(home), [{ name: 'ok', configDir: '/some/dir' }])
  } finally { cleanup() }
})

test('override: broken JSON falls back to discovery', () => {
  const { home, cleanup } = fixtureHome({
    withCreds: ['.claude'],
    overrideJson: '{ this is not json',
  })
  try {
    assert.deepEqual(loadAccounts(home).map(a => a.name), ['haupt'])
  } finally { cleanup() }
})

test('override: no usable entries falls back to discovery', () => {
  const { home, cleanup } = fixtureHome({
    withCreds: ['.claude-acct2'],
    overrideJson: JSON.stringify({ accounts: [{ name: '' }, 'nope'] }),
  })
  try {
    assert.deepEqual(loadAccounts(home).map(a => a.name), ['acct2'])
  } finally { cleanup() }
})

test('empty home falls back to the default haupt account', () => {
  const { home, cleanup } = fixtureHome()
  try {
    assert.deepEqual(loadAccounts(home), [
      { name: 'haupt', configDir: path.join(home, '.claude') },
    ])
  } finally { cleanup() }
})

test('missing home directory yields the defensive haupt fallback', () => {
  const home = path.join(os.tmpdir(), 'uw-accounts-does-not-exist-' + Date.now())
  assert.deepEqual(loadAccounts(home), [
    { name: 'haupt', configDir: path.join(home, '.claude') },
  ])
})

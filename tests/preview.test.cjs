const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jprev-'))
process.env.JARVIS_PREVIEW_DIR = dir
const preview = require('../lib/preview')

test('preview: resolves a file inside the folder only', () => {
  fs.writeFileSync(path.join(dir, 'a.html'), '<h1>a</h1>')
  assert.equal(preview.resolve('a.html'), path.join(dir, 'a.html'))
  assert.equal(preview.resolve('../secret.txt'), null)
  assert.equal(preview.resolve('/etc/passwd'), null)
  assert.equal(preview.resolve('missing.html'), null)
})

test('preview: write sanitises the name and list sees it', () => {
  const name = preview.write('my chart!!', '<p>x</p>')
  assert.match(name, /^my-chart--\.html$|^my-chart.*\.html$/)
  assert.ok(preview.list().some((f) => f.name === name))
})

test('preview: demo renders the performance page', () => {
  const d = preview.demo()
  assert.ok(fs.existsSync(path.join(dir, d.file)))
  assert.match(fs.readFileSync(path.join(dir, d.file), 'utf8'), /AI performance/)
})

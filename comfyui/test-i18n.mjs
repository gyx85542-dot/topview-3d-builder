import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
const source = await readFile(new URL('./ComfyUI-Topview3D/web/i18n.js', import.meta.url),'utf8')
const {messages, normalizeLocale, translate} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
assert.equal(Object.keys(messages).length,15)
const placeholders = (value) => [...value.matchAll(/\{(\w+)\}/g)].map((m)=>m[1]).sort()
for(const [locale, dictionary] of Object.entries(messages)) {
  assert.deepEqual(Object.keys(dictionary),Object.keys(messages.en))
  for(const [key, value] of Object.entries(dictionary)) {
    assert.ok(value,`${locale}.${key}`)
    assert.deepEqual(placeholders(value),placeholders(messages.en[key]),`${locale}.${key}`)
  }
  assert.ok(translate(locale,'done',{width:640,height:480,frame:12}).includes('640'))
}
for(const [input,expected] of [['zh','zh-CN'],['zh_TW','zh-TW'],['zh-Hant-HK','zh-TW'],['pt-BR','pt'],['ja-JP','ja'],['en-GB','en'],['unknown','en'],['','en']]) assert.equal(normalizeLocale(input),expected)
console.log('15 locales: key parity, placeholders, interpolation and aliases passed')

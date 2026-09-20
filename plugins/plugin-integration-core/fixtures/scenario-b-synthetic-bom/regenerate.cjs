'use strict'

// 重新生成本目录下的两个 .sql。改了 scenario-b-synthetic-bom.cjs 之后跑：
//   node fixtures/scenario-b-synthetic-bom/regenerate.cjs
// 不跑就会被 __tests__/scenario-b-synthetic-bom-source-run.test.cjs 的漂移断言逮住。
// LF 写入：committed 文件与生成器输出必须逐字节相等，CRLF 检出下 fs 默认不做换行转换，这里也不做。

const fs = require('node:fs')
const path = require('node:path')

const { schemaSql, seedSql } = require('./scenario-b-synthetic-bom.cjs')

const files = [
  ['01-schema.sql', schemaSql()],
  ['02-seed.sql', seedSql()],
]

for (const [name, content] of files) {
  const target = path.join(__dirname, name)
  fs.writeFileSync(target, content, 'utf8')
  process.stdout.write(`wrote ${name} (${Buffer.byteLength(content, 'utf8')} bytes)\n`)
}

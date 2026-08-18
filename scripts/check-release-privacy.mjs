import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const git = ['-c', `safe.directory=${root.replaceAll('\\', '/')}`]

function gitOutput(args) {
  return execFileSync('git', [...git, ...args], { cwd: root, encoding: 'utf8', windowsHide: true })
}

function collectLocalValues() {
  const values = new Set()
  const environmentFile = resolve(root, '.env.local')
  if (existsSync(environmentFile)) {
    for (const rawLine of readFileSync(environmentFile, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const separator = line.indexOf('=')
      if (separator < 1) continue
      const key = line.slice(0, separator).trim()
      const value = line.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/, '$2')
      const looksLikePlaceholder = /^(?:your_|example|changeme|none|null)/i.test(value)
      if (/(?:KEY|TOKEN|SECRET|PASSWORD|OWNER)$/i.test(key) && value.length >= 8 && !looksLikePlaceholder) values.add(value)
    }
  }

  const automationFile = resolve(root, 'work', 'robinhood-automation-config.json')
  if (existsSync(automationFile)) {
    const source = readFileSync(automationFile, 'utf8')
    for (const match of source.matchAll(/0x[0-9a-fA-F]{40}/g)) values.add(match[0])
  }
  return [...values]
}

const files = gitOutput(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
  .split('\0')
  .filter(Boolean)
const localValues = collectLocalValues()
const findings = []

for (const file of files) {
  const normalized = file.replaceAll('\\', '/')
  if (/^(?:\.env$|\.env\.local$|\.secrets\/|work\/|cloudflared\/(?:config\.ya?ml|.*\.json)|HANDOFF\.md$)/i.test(normalized)) {
    findings.push({ file: normalized, rule: '로컬 전용 경로' })
    continue
  }

  const absolute = resolve(root, file)
  if (!existsSync(absolute)) continue
  let source
  try {
    source = readFileSync(absolute, 'utf8')
  } catch {
    continue
  }
  if (/parkyouonit\.pp\.ua/i.test(source)) findings.push({ file: normalized, rule: '운영 Cloudflare 호스트명' })
  if (/(?:[A-Z]:\\Users\\[^\\\s]+|(?:^|[\s'"(])\/Users\/[^/\s]+)/im.test(source)) findings.push({ file: normalized, rule: '개인 사용자 절대 경로' })
  if (localValues.some(value => value && source.includes(value))) findings.push({ file: normalized, rule: '로컬 비밀값 또는 운영 지갑 주소' })
}

if (findings.length) {
  console.error('공개 저장소에 포함하면 안 되는 항목을 발견했습니다:')
  for (const finding of findings) console.error(`- ${finding.file}: ${finding.rule}`)
  process.exit(1)
}

console.log(`공개 후보 ${files.length}개 파일 검사 통과: 로컬 비밀값·운영 주소·개인 경로 없음`)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import solc from 'solc'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const sourcePath = join(root, 'contracts', 'BStockerThreeTickVault.sol')
const outputDirectory = join(root, 'contracts', 'build')
if (!existsSync(sourcePath)) throw new Error('BStockerThreeTickVault.sol을 찾지 못했습니다.')

const input = {
  language: 'Solidity',
  sources: { 'BStockerThreeTickVault.sol': { content: readFileSync(sourcePath, 'utf8') } },
  settings: {
    optimizer: { enabled: true, runs: 500 },
    viaIR: true,
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'metadata'] } },
  },
}

const output = JSON.parse(solc.compile(JSON.stringify(input)))
const errors = (output.errors || []).filter(item => item.severity === 'error')
for (const item of output.errors || []) console.error(`${item.severity}: ${item.formattedMessage}`)
if (errors.length) process.exit(1)

const artifact = output.contracts['BStockerThreeTickVault.sol'].BStockerThreeTickVault
mkdirSync(outputDirectory, { recursive: true })
writeFileSync(join(outputDirectory, 'BStockerThreeTickVault.json'), JSON.stringify({
  contractName: 'BStockerThreeTickVault',
  compiler: solc.version(),
  abi: artifact.abi,
  bytecode: `0x${artifact.evm.bytecode.object}`,
  deployedBytecode: `0x${artifact.evm.deployedBytecode.object}`,
  metadata: JSON.parse(artifact.metadata),
}, null, 2), 'utf8')
console.log(`Compiled BStockerThreeTickVault with ${solc.version()}`)
console.log(`Creation bytecode: ${artifact.evm.bytecode.object.length / 2} bytes`)
console.log(`Runtime bytecode: ${artifact.evm.deployedBytecode.object.length / 2} bytes`)

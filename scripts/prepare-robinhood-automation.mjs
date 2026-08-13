import { ensureKeeperIdentity, keeperKeyFile } from '../server/robinhood-keeper-key.mjs'

const identity = ensureKeeperIdentity()
console.log(identity.created ? '새 Robinhood 저권한 Keeper를 만들었습니다.' : '기존 Robinhood Keeper를 확인했습니다.')
console.log(`Keeper address: ${identity.address}`)
console.log(`Keeper metadata: ${keeperKeyFile}`)
console.log(`개인키는 ${identity.protection}으로 보호되며 출력되지 않습니다.`)

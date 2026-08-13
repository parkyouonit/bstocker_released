import { useEffect, useState } from 'react'
import { getAvailableWallets, type AvailableWallet, type WalletKind } from '../lib/wallet'

interface Props {
  open: boolean
  onClose: () => void
  onSelect: (kind: WalletKind) => void
}

export function WalletPicker({ open, onClose, onSelect }: Props) {
  const [wallets, setWallets] = useState<AvailableWallet[]>([])

  useEffect(() => {
    if (!open) return
    let active = true
    void getAvailableWallets().then(value => { if (active) setWallets(value) })
    return () => { active = false }
  }, [open])

  if (!open) return null
  const state = (kind: WalletKind) => wallets.find(wallet => wallet.kind === kind)
  return <div className="wallet-picker-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="wallet-picker" role="dialog" aria-modal="true" aria-labelledby="wallet-picker-title" onMouseDown={event => event.stopPropagation()}>
      <div className="wallet-picker-heading"><div><span>CONNECT WALLET</span><strong id="wallet-picker-title">사용할 지갑 선택</strong></div><button type="button" onClick={onClose} aria-label="지갑 선택 닫기">×</button></div>
      <button type="button" className="wallet-choice rabby" disabled={!state('rabby')?.installed} onClick={() => onSelect('rabby')}><i>R</i><span><b>Rabby Wallet</b><small>{state('rabby')?.installed ? '설치됨 · 권장' : '현재 브라우저에서 찾지 못함'}</small></span></button>
      <button type="button" className="wallet-choice metamask" disabled={!state('metamask')?.installed} onClick={() => onSelect('metamask')}><i>M</i><span><b>MetaMask</b><small>{state('metamask')?.installed ? '설치됨' : '현재 브라우저에서 찾지 못함'}</small></span></button>
      <p>두 확장이 함께 설치되어 있어도 선택한 지갑으로만 연결합니다. 모바일에서는 해당 지갑 앱의 내장 브라우저를 사용하세요.</p>
    </section>
  </div>
}

import type { PoolPreset } from '../pools'

interface PoolPickerProps {
  pools: PoolPreset[]
  selectedPoolId: string
  onSelect: (poolId: string) => void
}

export function PoolPicker({ pools, selectedPoolId, onSelect }: PoolPickerProps) {
  return (
    <section className="pool-picker" aria-label="bStocker BNB Chain LP pools">
      <div className="pool-picker-heading">
        <strong>bStocker LP</strong>
        <span>공식 PancakeSwap 풀</span>
      </div>
      <div className="pool-picker-list">
        {pools.map(pool => (
          <button
            type="button"
            key={pool.id}
            className={`pool-chip ${selectedPoolId === pool.id ? 'selected' : ''}`}
            onClick={() => onSelect(pool.id)}
            title={`${pool.description} · ${pool.label}`}
          >
            <span>{pool.label}</span>
            <small>{pool.description}</small>
          </button>
        ))}
      </div>
    </section>
  )
}

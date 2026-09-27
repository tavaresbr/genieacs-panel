interface BarChartData {
  name: string
  value: number
}

export function BarChart({ data, valueLabel = 'Devices' }: { data: BarChartData[]; valueLabel?: string }) {
  const max = Math.max(...data.map((item) => item.value), 1)

  return (
    <div className="flex flex-col sm:min-h-[250px] justify-center gap-3 py-2" role="img" aria-label={`${valueLabel} by category`}>
      {data.map((item) => (
        <div key={item.name} className="grid grid-cols-[minmax(4.5rem,0.45fr)_minmax(0,1fr)_auto] items-center gap-2 sm:grid-cols-[minmax(5.5rem,0.45fr)_minmax(8rem,1fr)_2.5rem] sm:gap-3">
          <span className="truncate text-end text-xs font-semibold text-muted-foreground" title={item.name}>{item.name}</span>
          <div className="h-5 overflow-hidden rounded-sm bg-muted">
            <div className="h-full min-w-1 rounded-sm bg-primary transition-[width] duration-300"
              style={{ width: `${Math.max((item.value / max) * 100, item.value ? 2 : 0)}%` }}
              title={`${item.name}: ${item.value} ${valueLabel}`} />
          </div>
          <span className="font-mono text-xs font-semibold text-foreground">{item.value}</span>
        </div>
      ))}
    </div>
  )
}
